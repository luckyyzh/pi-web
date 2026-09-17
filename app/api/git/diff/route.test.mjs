import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// The route is transpiled into an isolated context with faked collaborators so
// the test never resolves real remote mappings, realpaths real shadow paths,
// or spawns git.
function loadRoute(fakes) {
  const source = readFileSync(new URL("./route.ts", import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const exports = {};
  runInNewContext(outputText, {
    exports,
    process,
    console,
    require: (id) => {
      if (id === "next/server") return fakes.nextServer;
      if (id === "@/lib/file-access") return fakes.fileAccess;
      if (id === "@/lib/git-changes") return fakes.gitChanges;
      if (id === "@/lib/remote-workspace") return fakes.remoteWorkspace;
      throw new Error(`Unexpected require in git diff route: ${id}`);
    },
  });
  return exports;
}

function jsonResponse(body, init) {
  return new Response(JSON.stringify(body), { status: init?.status ?? 200, headers: { "Content-Type": "application/json" } });
}

const isWindowsAbsolutePath = (p) => /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("\\\\") || p.startsWith("//");

function makeFakes({ workspace = null, resolveError = null, deny = new Set(), existing = true, diff = { supported: false } } = {}) {
  const calls = { lexical: [], existing: [], resolve: [], gitDiff: [] };
  return {
    calls,
    fakes: {
      nextServer: { NextResponse: { json: jsonResponse } },
      fileAccess: {
        getAllowedFileRoots: async () => new Set(["/allowed", "/shadow"]),
        isFilePathAllowed: (p) => { calls.lexical.push(p); return !deny.has(p); },
        isExistingFilePathAllowed: (p) => { calls.existing.push(p); return existing; },
        isWindowsAbsolutePath,
      },
      gitChanges: {
        getGitFileDiff: async (cwd, filePath, options) => {
          calls.gitDiff.push({ cwd, filePath, options });
          return diff;
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
  const url = new URL(`http://localhost/api/git/diff?${search}`);
  const request = new Request(url);
  request.nextUrl = { searchParams: url.searchParams };
  return request;
}

test("remote binding without a local shadow subdir passes with lexical auth only and no local realpath", async () => {
  const workspace = { kind: "ssh", id: "user_h1_aabbccddeeff", host: "user@h1", cwd: "/home/user/mono/app", localRoot: "/shadow/user_h1_aabbccddeeff" };
  const patch = "diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-x\n+y\n";
  const { calls, fakes } = makeFakes({ workspace, diff: { supported: true, status: "modified", patch } });
  const { GET } = loadRoute(fakes);
  const request = get(
    "cwd=" + encodeURIComponent("/shadow/user_h1_aabbccddeeff/services")
    + "&path=" + encodeURIComponent("/shadow/user_h1_aabbccddeeff/services/src/a.ts"),
  );
  const response = await GET(request);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { supported: true, status: "modified", patch });
  assert.deepEqual(
    calls.lexical,
    ["/shadow/user_h1_aabbccddeeff/services", "/shadow/user_h1_aabbccddeeff/services/src/a.ts"],
    "cwd and file both keep lexical allowedRoots authorization",
  );
  assert.equal(calls.existing.length, 0, "no local realpath for a remote cwd");
  assert.equal(calls.gitDiff.length, 1, "git verifies the repository over SSH");
  assert.equal(calls.gitDiff[0].options?.signal, request.signal, "request signal is passed through");
});

test("a file outside the bound workspace is rejected by the git layer, not the route", async () => {
  const workspace = { kind: "ssh", id: "user_h1_aabbccddeeff", host: "user@h1", cwd: "/home/user/mono/app", localRoot: "/shadow/user_h1_aabbccddeeff" };
  const { calls, fakes } = makeFakes({ workspace, diff: { supported: false } });
  const { GET } = loadRoute(fakes);
  const response = await GET(get(
    "cwd=" + encodeURIComponent("/shadow/user_h1_aabbccddeeff")
    + "&path=" + encodeURIComponent("/shadow/other_ffffffffffff/x.txt"),
  ));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { supported: false });
  assert.equal(calls.gitDiff.length, 1, "the underlying lib cross-workspace check is preserved");
});

test("cwd or file outside the allowed roots is 403 before remote resolution or diff", async () => {
  for (const [cwd, filePath] of [
    ["/outside/proj", "/allowed/file.txt"],
    ["/allowed/proj", "/outside/file.txt"],
  ]) {
    const { calls, fakes } = makeFakes({ deny: new Set([cwd, filePath].filter((p) => p.startsWith("/outside"))) });
    const { GET } = loadRoute(fakes);
    const response = await GET(get(`cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(filePath)}`));
    assert.equal(response.status, 403, `cwd=${cwd} path=${filePath}`);
    assert.equal(calls.resolve.length, 0);
    assert.equal(calls.existing.length, 0);
    assert.equal(calls.gitDiff.length, 0);
  }
  // Missing or relative path params: still 400.
  const plain = makeFakes({});
  const { GET } = loadRoute(plain.fakes);
  assert.equal((await GET(get("cwd=" + encodeURIComponent("/allowed/proj")))).status, 400, "missing path");
  assert.equal((await GET(get("cwd=proj&path=/allowed/f.txt"))).status, 400, "relative cwd");
  assert.equal(plain.calls.gitDiff.length, 0);
});

test("local cwd keeps the existing realpath authorization behavior", async () => {
  const ok = makeFakes({ diff: { supported: true, status: "untracked", patch: "@@ -0,0 +1 @@\n+a\n" } });
  const { GET } = loadRoute(ok.fakes);
  const request = get("cwd=" + encodeURIComponent("/allowed/proj") + "&path=" + encodeURIComponent("/allowed/proj/new.txt"));
  assert.equal((await GET(request)).status, 200);
  assert.deepEqual(ok.calls.existing, ["/allowed/proj"], "local cwd is still realpath-authorized");
  assert.equal(ok.calls.gitDiff.length, 1);
  assert.equal(ok.calls.gitDiff[0].options?.signal, request.signal, "request signal is passed through");

  // Symlink escape on the local cwd: still 403 with no diff.
  const escape = makeFakes({ existing: false });
  const { GET: GET403 } = loadRoute(escape.fakes);
  assert.equal(
    (await GET403(get("cwd=" + encodeURIComponent("/allowed/link") + "&path=" + encodeURIComponent("/allowed/link/f.txt")))).status,
    403,
  );
  assert.equal(escape.calls.gitDiff.length, 0);
});

test("orphaned remote shadows fail closed with 500 and never fall back to local diff", async () => {
  const { calls, fakes } = makeFakes({
    resolveError: "Remote workspace mapping is missing; reconnect this project from the Remote panel (local execution was blocked)",
  });
  const { GET } = loadRoute(fakes);
  const response = await GET(get(
    "cwd=" + encodeURIComponent("/shadow/ghost_aaaabbbbcccc/sub")
    + "&path=" + encodeURIComponent("/shadow/ghost_aaaabbbbcccc/sub/f.txt"),
  ));
  assert.equal(response.status, 500);
  assert.match((await response.json()).error, /mapping is missing/);
  assert.equal(calls.existing.length, 0, "no local fallback realpath");
  assert.equal(calls.gitDiff.length, 0, "diff never runs for an orphaned shadow");
});
