import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import path from "node:path";
import ts from "typescript";

// The route is transpiled into an isolated context with faked collaborators so
// the test never stats remote paths, touches ssh state, or spawns terminals.
function loadRoute(fakes) {
  const source = readFileSync(new URL("./route.ts", import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const exports = {};
  runInNewContext(outputText, {
    exports,
    process,
    console,
    require: (id) => {
      if (id === "path") return path;
      if (id === "fs/promises") return fakes.fsPromises;
      if (id === "next/server") return fakes.nextServer;
      if (id === "@/lib/file-access") return fakes.fileAccess;
      if (id === "@/lib/remote-workspace") return fakes.remoteWorkspace;
      if (id === "@/lib/paths") return fakes.paths;
      if (id === "@/lib/workspace-target") return fakes.workspaceTarget;
      if (id === "@/lib/terminal-manager") return fakes.terminalManager;
      throw new Error(`Unexpected require in terminal route: ${id}`);
    },
  });
  return exports;
}

function jsonResponse(body, init) {
  return new Response(JSON.stringify(body), { status: init?.status ?? 200, headers: { "Content-Type": "application/json" } });
}

function makeFakes({ target, authorize = true, isDirectory = true, resolveError = null } = {}) {
  const calls = { stat: [], lexical: [], existing: [], create: [] };
  return {
    calls,
    fakes: {
      fsPromises: {
        stat: async (cwd) => {
          calls.stat.push(cwd);
          return { isDirectory: () => isDirectory };
        },
      },
      nextServer: { NextResponse: { json: jsonResponse } },
      fileAccess: {
        getAllowedFileRoots: async () => new Set(["/allowed"]),
        isFilePathAllowed: (cwd, roots) => {
          calls.lexical.push({ cwd, roots: [...roots] });
          return authorize;
        },
        isExistingFilePathAllowed: (cwd, roots) => {
          calls.existing.push({ cwd, roots: [...roots] });
          return authorize;
        },
      },
      remoteWorkspace: {
        resolveWorkspaceTarget: (cwd) => {
          if (resolveError) throw new Error(resolveError);
          return typeof target === "function" ? target(cwd) : target;
        },
      },
      paths: {
        // Real platform semantics for the samePath comparison.
        samePath: (a, b) => (a === b ? true : path.resolve(a) === path.resolve(b)),
      },
      workspaceTarget: {
        sameWorkspaceTarget: (a, b) => a.kind === b.kind && a.cwd === b.cwd
          && (a.kind === "local" || (b.kind === "ssh" && a.id === b.id && a.host === b.host)),
      },
      terminalManager: {
        createTerminal: (cwd, cols, rows, id, terminalTarget) => {
          calls.create.push({ cwd, cols, rows, id, target: terminalTarget });
          return "terminal-1";
        },
      },
    },
  };
}

function post(body) {
  return new Request("http://localhost/api/terminal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("create resolves the execution target server-side and returns it for display", async () => {
  const resolve = (cwd) => ({ kind: "local", cwd: path.resolve(cwd) });
  const { calls, fakes } = makeFakes({ target: resolve });
  const { POST } = loadRoute(fakes);
  const response = await POST(post({ cwd: "/allowed/project", cols: 100, rows: 30 }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { id: "terminal-1", cwd: path.resolve("/allowed/project"), target: resolve("/allowed/project") });
  assert.deepEqual(calls.create, [{ cwd: path.resolve("/allowed/project"), cols: 100, rows: 30, id: undefined, target: resolve("/allowed/project") }]);
  assert.equal(calls.stat.length, 1, "local cwds are still validated as directories");
  assert.equal(calls.existing.length, 1, "local cwds use the existing-path authorization");
  assert.equal(calls.lexical.length, 0);
});

test("remote targets are authorized lexically on the local path and are never stat'ed locally", async () => {
  const target = { kind: "ssh", id: "user_h1_aabbccddeeff", host: "user@h1", cwd: "/remote/project" };
  let statCalled = false;
  const { calls, fakes } = makeFakes({ target });
  fakes.fsPromises.stat = async () => { statCalled = true; throw new Error("remote cwd must not be stat'ed locally"); };
  const { POST } = loadRoute(fakes);
  const response = await POST(post({ cwd: "/allowed/shadow/root" }));
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).target, target);
  assert.equal(statCalled, false);
  assert.equal(calls.lexical.length, 1, "the server-resolved mapping is authorized lexically");
  assert.equal(calls.existing.length, 0, "no filesystem check for the compatibility path");
  assert.equal(calls.lexical[0].cwd, path.resolve("/allowed/shadow/root"));
  assert.deepEqual(calls.create, [{ cwd: path.resolve("/allowed/shadow/root"), cols: 80, rows: 24, id: undefined, target }]);
});

test("denied cwd never creates a terminal, local or remote", async () => {
  for (const target of [{ kind: "local", cwd: "/nope" }, { kind: "ssh", id: "w_aabbccddeeff", host: "user@h1", cwd: "/remote/project" }]) {
    const { calls, fakes } = makeFakes({ target, authorize: false });
    const { POST } = loadRoute(fakes);
    const response = await POST(post({ cwd: "/nope" }));
    assert.equal(response.status, 403, JSON.stringify(target));
    assert.equal(calls.create.length, 0, JSON.stringify(target));
  }
});

test("unknown remote shadows fail closed without stat, authorization, or creation", async () => {
  let statCalled = false;
  const { calls, fakes } = makeFakes({ resolveError: "Unknown remote workspace; reconnect this project from the Remote panel" });
  fakes.fsPromises.stat = async () => { statCalled = true; };
  const { POST } = loadRoute(fakes);
  const response = await POST(post({ cwd: "/allowed/shadow/unknown" }));
  assert.equal(response.status, 500);
  assert.match((await response.json()).error, /Unknown remote workspace/);
  assert.equal(statCalled, false);
  assert.equal(calls.lexical.length, 0);
  assert.equal(calls.existing.length, 0);
  assert.equal(calls.create.length, 0);
});

test("local cwd that is not a directory is rejected before creation", async () => {
  const { calls, fakes } = makeFakes({ target: (cwd) => ({ kind: "local", cwd }), isDirectory: false });
  const { POST } = loadRoute(fakes);
  const response = await POST(post({ cwd: "/allowed/file.txt" }));
  assert.equal(response.status, 400);
  assert.equal(calls.create.length, 0);
});

test("invalid ids and missing cwd are rejected", async () => {
  const { calls, fakes } = makeFakes({ target: (cwd) => ({ kind: "local", cwd }) });
  const { POST } = loadRoute(fakes);
  assert.equal((await POST(post({ id: "not-a-uuid", cwd: "/allowed/project" }))).status, 400);
  assert.equal((await POST(post({ cwd: "" }))).status, 400);
  assert.equal(calls.create.length, 0);
});

test("restart POST with a mismatching expected target is 409 and never spawns", async () => {
  const target = { kind: "ssh", id: "user_h1_aabbccddeeff", host: "user@h1", cwd: "/remote/project" };
  let statCalled = false;
  const { calls, fakes } = makeFakes({ target });
  fakes.fsPromises.stat = async () => { statCalled = true; };
  const { POST } = loadRoute(fakes);
  for (const expected of [
    { kind: "ssh", id: "user_h2_ffffeeeeffff", host: "user@h1", cwd: "/remote/project" },
    { kind: "ssh", id: "user_h1_aabbccddeeff", host: "user@h2", cwd: "/remote/project" },
    { kind: "ssh", id: "user_h1_aabbccddeeff", host: "user@h1", cwd: "/remote/other" },
    { kind: "local", cwd: "/allowed/shadow/root" },
  ]) {
    const response = await POST(post({ cwd: "/allowed/shadow/root", target: expected }));
    assert.equal(response.status, 409, JSON.stringify(expected));
    assert.match((await response.json()).error, /does not match this workspace/);
  }
  assert.equal(calls.create.length, 0, "createTerminal is never called on mismatch");
  assert.equal(statCalled, false);
});

test("restart POST with a matching expected target is accepted", async () => {
  const target = { kind: "ssh", id: "user_h1_aabbccddeeff", host: "user@h1", cwd: "/remote/project" };
  const { calls, fakes } = makeFakes({ target });
  const { POST } = loadRoute(fakes);
  const response = await POST(post({ cwd: "/allowed/shadow/root", target: { ...target } }));
  assert.equal(response.status, 200);
  assert.equal(calls.create.length, 1);
  assert.deepEqual(calls.create[0].target, target);
});

test("mismatching local expected target is 409 before creation", async () => {
  const resolve = (cwd) => ({ kind: "local", cwd: path.resolve(cwd) });
  const { calls, fakes } = makeFakes({ target: resolve });
  const { POST } = loadRoute(fakes);
  const response = await POST(post({ cwd: "/allowed/project", target: { kind: "local", cwd: "/allowed/other-project" } }));
  assert.equal(response.status, 409);
  assert.equal(calls.create.length, 0);
});

test("matching local expected target is accepted and old requests without one stay compatible", async () => {
  const resolve = (cwd) => ({ kind: "local", cwd: path.resolve(cwd) });
  const { calls, fakes } = makeFakes({ target: resolve });
  const { POST } = loadRoute(fakes);
  assert.equal((await POST(post({ cwd: "/allowed/project", target: { kind: "local", cwd: "/allowed/project/" } }))).status, 200);
  assert.equal((await POST(post({ cwd: "/allowed/project" }))).status, 200, "no target field stays compatible");
  assert.equal(calls.create.length, 2);
});

test("malformed expected targets are ignored, never trusted", async () => {
  const target = { kind: "ssh", id: "user_h1_aabbccddeeff", host: "user@h1", cwd: "/remote/project" };
  const { calls, fakes } = makeFakes({ target });
  const { POST } = loadRoute(fakes);
  for (const junk of ["ssh", 42, { kind: "ssh" }, { kind: "ssh", id: "x", host: "h" }, { kind: "weird", cwd: "/x" }, { kind: "local", cwd: "" }]) {
    const response = await POST(post({ cwd: "/allowed/shadow/root", target: junk }));
    assert.equal(response.status, 200, JSON.stringify(junk));
  }
  assert.equal(calls.create.length, 6);
});
