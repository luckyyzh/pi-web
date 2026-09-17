import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// The route is transpiled into an isolated context with faked collaborators so
// the test never stats real shadow subdirs, resolves real remote mappings, or
// spawns git.
function loadRoute(fakes) {
  const source = readFileSync(new URL("./route.ts", import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const exports = {};
  runInNewContext(outputText, {
    exports,
    process,
    console,
    require: (id) => {
      if (id === "fs") return fakes.fs;
      if (id === "next/server") return fakes.nextServer;
      if (id === "@/lib/file-access") return fakes.fileAccess;
      if (id === "@/lib/git-changes") return fakes.gitChanges;
      if (id === "@/lib/remote-workspace") return fakes.remoteWorkspace;
      throw new Error(`Unexpected require in git status route: ${id}`);
    },
  });
  return exports;
}

function jsonResponse(body, init) {
  return new Response(JSON.stringify(body), { status: init?.status ?? 200, headers: { "Content-Type": "application/json" } });
}

const isWindowsAbsolutePath = (p) => /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("\\\\") || p.startsWith("//");

function makeFakes({ workspace = null, resolveError = null, authorize = true, existing = true } = {}) {
  const calls = { lexical: [], existing: [], stat: [], resolve: [], gitStatus: [] };
  // The transpiled route uses `fs.default.statSync` (default import interop),
  // so the fake exposes one mutable impl on both module forms.
  const statImpl = { fn: (cwd) => { throw new Error(`stat must not be reached in this case: ${cwd}`); } };
  const fsMod = { statSync: (...args) => { calls.stat.push(args[0]); return statImpl.fn(...args); } };
  return {
    calls,
    setStat: (fn) => { statImpl.fn = fn; },
    fakes: {
      fs: { ...fsMod, default: fsMod },
      nextServer: { NextResponse: { json: jsonResponse } },
      fileAccess: {
        getAllowedFileRoots: async () => new Set(["/allowed", "/shadow"]),
        isFilePathAllowed: (cwd) => { calls.lexical.push(cwd); return authorize; },
        isExistingFilePathAllowed: (cwd) => { calls.existing.push(cwd); return existing; },
        isWindowsAbsolutePath,
      },
      gitChanges: {
        getGitStatus: async (cwd, options) => {
          calls.gitStatus.push({ cwd, options });
          return { isGitRepository: true, repositoryRoot: "/allowed/project", files: [], additions: 0, deletions: 0 };
        },
      },
      remoteWorkspace: {
        resolveRemoteWorkspace: (cwd) => {
          calls.resolve.push(cwd);
          if (resolveError) throw new Error(resolveError);
          return workspace;
        },
      },
    },
  };
}

function get(search) {
  const url = new URL(`http://localhost/api/git/status?${search}`);
  const request = new Request(url);
  request.nextUrl = { searchParams: url.searchParams };
  return request;
}

test("remote binding without a local shadow subdir passes without any local stat or realpath", async () => {
  const workspace = { kind: "ssh", id: "user_h1_aabbccddeeff", host: "user@h1", cwd: "/home/user/mono/app", localRoot: "/shadow/user_h1_aabbccddeeff" };
  const { calls, fakes } = makeFakes({ workspace });
  const { GET } = loadRoute(fakes);
  const request = get("cwd=" + encodeURIComponent("/shadow/user_h1_aabbccddeeff/services"));
  const response = await GET(request);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { isGitRepository: true, repositoryRoot: "/allowed/project", files: [], additions: 0, deletions: 0 });
  assert.equal(calls.lexical.length, 1, "lexical allowedRoots authorization is kept");
  assert.equal(calls.resolve.length, 1);
  assert.equal(calls.stat.length, 0, "no local stat for a remote cwd");
  assert.equal(calls.existing.length, 0, "no local realpath authorization for a remote cwd");
  assert.equal(calls.gitStatus.length, 1, "git verifies the remote directory itself");
  assert.equal(calls.gitStatus[0].cwd, "/shadow/user_h1_aabbccddeeff/services");
  assert.equal(calls.gitStatus[0].options?.signal, request.signal, "request signal is passed through");
});

test("cwd outside the allowed roots is 403 before any remote resolution, stat, or git call", async () => {
  const { calls, fakes } = makeFakes({ authorize: false });
  const { GET } = loadRoute(fakes);
  const response = await GET(get("cwd=" + encodeURIComponent("/outside/shadow/user_h1_aabbccddeeff")));
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "Access denied" });
  assert.equal(calls.resolve.length, 0);
  assert.equal(calls.stat.length, 0);
  assert.equal(calls.existing.length, 0);
  assert.equal(calls.gitStatus.length, 0);
});

test("local cwd keeps the existing stat + realpath authorization behavior", async () => {
  const dirStat = { isDirectory: () => true };
  let GET;

  // Existing local directory: stat + realpath authorization both run, and the
  // request signal is passed through.
  const ok = makeFakes({});
  ok.setStat(() => dirStat);
  GET = loadRoute(ok.fakes).GET;
  const okRequest = get("cwd=" + encodeURIComponent("/allowed/project"));
  assert.equal((await GET(okRequest)).status, 200);
  assert.deepEqual(ok.calls.stat, ["/allowed/project"], "local cwd is still stat'ed");
  assert.deepEqual(ok.calls.existing, ["/allowed/project"], "local cwd still gets symlink-aware authorization");
  assert.equal(ok.calls.gitStatus.length, 1);
  assert.equal(ok.calls.gitStatus[0].options?.signal, okRequest.signal, "request signal is passed through");

  // Missing local directory: still 404 before any git call.
  const missing = makeFakes({});
  GET = loadRoute(missing.fakes).GET;
  assert.equal((await GET(get("cwd=" + encodeURIComponent("/allowed/nope")))).status, 404);
  assert.equal(missing.calls.gitStatus.length, 0);

  // Symlink escape (realpath outside allowed roots): still 403, no git call.
  const escape = makeFakes({ existing: false });
  escape.setStat(() => dirStat);
  GET = loadRoute(escape.fakes).GET;
  assert.equal((await GET(get("cwd=" + encodeURIComponent("/allowed/link")))).status, 403);
  assert.equal(escape.calls.gitStatus.length, 0);

  // Relative cwd: still 400.
  assert.equal((await GET(get("cwd=project"))).status, 400);
  assert.equal(escape.calls.gitStatus.length, 0);
});

test("orphaned remote shadows fail closed with 500 and never fall back to local git", async () => {
  for (const message of [
    "Remote workspace mapping is missing; reconnect this project from the Remote panel (local execution was blocked)",
    "Unknown remote workspace; reconnect this project from the Remote panel",
  ]) {
    const { calls, fakes } = makeFakes({ resolveError: message });
    const { GET } = loadRoute(fakes);
    const response = await GET(get("cwd=" + encodeURIComponent("/shadow/ghost_aaaabbbbcccc/sub")));
    assert.equal(response.status, 500, message);
    assert.match((await response.json()).error, /mapping is missing|Unknown remote workspace/);
    assert.equal(calls.stat.length, 0, "no local fallback stat");
    assert.equal(calls.existing.length, 0, "no local fallback realpath");
    assert.equal(calls.gitStatus.length, 0, "git never runs for an orphaned shadow");
  }
});
