import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

function loadRoute(terminalManager) {
  const source = readFileSync(new URL("./route.ts", import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const exports = {};
  runInNewContext(outputText, {
    exports,
    process,
    console,
    require: (id) => {
      if (id === "next/server") {
        return { NextResponse: { json: (body, init) => new Response(JSON.stringify(body), { status: init?.status ?? 200, headers: { "Content-Type": "application/json" } }) } };
      }
      if (id === "@/lib/terminal-manager") return terminalManager;
      throw new Error(`Unexpected require in terminal [id] route: ${id}`);
    },
  });
  return exports;
}

function manager({ cwd, target } = {}) {
  return {
    getTerminalCwd: () => cwd,
    getTerminalTarget: () => target,
    writeTerminal: () => false,
    resizeTerminal: () => false,
    killTerminal: () => false,
  };
}

test("GET returns the server-stored ssh target for display", async () => {
  const target = { kind: "ssh", id: "user_h1_aabbccddeeff", host: "user@h1", cwd: "/remote/project" };
  const { GET } = loadRoute(manager({ cwd: "/local/shadow/root", target }));
  const response = await GET(new Request("http://localhost/api/terminal/abc"), { params: Promise.resolve({ id: "abc" }) });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { id: "abc", cwd: "/local/shadow/root", target });
});

test("GET returns a local target for legacy terminals", async () => {
  const target = { kind: "local", cwd: "/repo" };
  const { GET } = loadRoute(manager({ cwd: "/repo", target }));
  const response = await GET(new Request("http://localhost/api/terminal/abc"), { params: Promise.resolve({ id: "abc" }) });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { id: "abc", cwd: "/repo", target });
});

test("expired terminals 404 without leaking a target", async () => {
  const { GET } = loadRoute(manager({}));
  const response = await GET(new Request("http://localhost/api/terminal/abc"), { params: Promise.resolve({ id: "abc" }) });
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "Terminal expired or closed" });
});
