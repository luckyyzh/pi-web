import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import path from "node:path";
import ts from "typescript";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const helpers = await jiti.import("./remote-workspace.ts");
const input = await jiti.import("./subagent-input.ts");
const require = createRequire(import.meta.url);
const compiled = ts.transpileModule(readFileSync(new URL("./remote-subagent-input.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
function makeLoader(realFile, calls) {
  const exports = {};
  runInNewContext(compiled, { exports, Buffer, TextDecoder, require(id) {
    if (id === "./remote-workspace") return helpers;
    if (id === "./subagent-input") return input;
    if (id === "./ssh") return {
      sshExec: async (host, command) => { calls.push([host, command]); return command.startsWith("cd ") ? "/srv/project\n" : realFile + "\n"; },
      sshReadTextFile: async (host, file, limit) => { calls.push([host, file, limit]); return { content: "remote text", size: 11 }; },
    };
    return require(id);
  } });
  return exports.loadRemoteSubagentInputFiles;
}
const localRoot = path.resolve("fake-cache");
const workspace = { host: "server", cwd: "/srv/project", localRoot };

test("subagent input attachments use the parent's remote target and skip duplicate files", async () => {
  const calls = [];
  const files = await makeLoader("/srv/project/src/app.ts", calls)(workspace, localRoot, ["src/app.ts", "src/app.ts"]);
  assert.equal(files.length, 1);
  assert.equal(files[0].path, "src/app.ts");
  assert.equal(files[0].content, "remote text");
  assert.equal(calls.filter((call) => call.length === 3).length, 1);
  assert.equal(calls.find((call) => call.length === 3)[2], 512 * 1024);
  assert.ok(calls.every((call) => call[0] === "server"));
});

test("remote attachments reject symlink escapes and too many input files", async () => {
  const calls = [];
  const load = makeLoader("/etc/passwd", calls);
  await assert.rejects(load(workspace, localRoot, ["link"]), /outside the session cwd/);
  assert.equal(calls.filter((call) => call.length === 3).length, 0);
  await assert.rejects(load(workspace, localRoot, Array(9).fill("file")), /at most 8/);
});
