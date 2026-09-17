import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { PassThrough } from "node:stream";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const source = await readFile(new URL("./ssh.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;

function harness() {
  const children = [];
  const exports = {};
  runInNewContext(compiled, {
    exports, Buffer, TextDecoder, setTimeout, clearTimeout,
    require(name) {
      if (name === "./remote-workspace") return { sshArguments: (host, command) => [host, command], quoteShellArg: (value) => `'${value}'` };
      if (name === "node:child_process") return { spawn: () => {
        const child = new EventEmitter();
        child.stdout = new PassThrough(); child.stderr = new PassThrough();
        child.kills = 0;
        // Deliberately no close event: termination must settle independently.
        child.kill = () => { child.kills++; return true; };
        children.push(child);
        return child;
      } };
      return require(name);
    },
  });
  return { ...exports, children };
}

test("SSH abort rejects immediately, kills only its child, and does not need close", async () => {
  const { sshExec, children } = harness();
  const abort = new AbortController();
  const result = sshExec("not-contacted.invalid", "ignored", 5000, { signal: abort.signal });
  abort.abort(new Error("request cancelled"));
  await assert.rejects(result, /request cancelled/);
  assert.equal(children[0].kills, 1);
  children[0].emit("error", new Error("late error must be harmless"));
  children[0].emit("close", 1);
  assert.equal(children[0].kills, 1);
});

test("pre-aborted SSH never spawns and output limit stops the producer", async () => {
  const { sshExec, children } = harness();
  await assert.rejects(sshExec("not-contacted.invalid", "ignored", 5000, { signal: AbortSignal.abort(new Error("already aborted")) }), /already aborted/);
  assert.equal(children.length, 0);
  const result = sshExec("not-contacted.invalid", "ignored", 5000, { onStdout: () => false });
  children[0].stdout.write("bounded prefix\0");
  assert.equal(await result, "bounded prefix\0");
  assert.equal(children[0].kills, 1);
  children[0].stdout.write("ignored tail");
});

test("SSH timeout settles without close, while normal completion preserves output", async () => {
  const { sshExec, children } = harness();
  await assert.rejects(sshExec("not-contacted.invalid", "ignored", 5), /timed out/);
  assert.equal(children[0].kills, 1);
  const result = sshExec("not-contacted.invalid", "ignored", 5000);
  children[1].stdout.write("hello\n");
  children[1].emit("close", 0);
  assert.equal(await result, "hello\n");
  assert.equal(children[1].kills, 0);
});

test("remote file preview does not start base64 after the request is cancelled", async () => {
  const { sshReadTextFile, children } = harness();
  const abort = new AbortController();
  const result = sshReadTextFile("not-contacted.invalid", "/non-secret-fixture", 256, { signal: abort.signal });
  children[0].stdout.write("10\n");
  children[0].emit("close", 0);
  abort.abort(new Error("cancel before content read"));
  await assert.rejects(result, /cancel before content read/);
  assert.equal(children.length, 1);
});
