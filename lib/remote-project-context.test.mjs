import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import path from "node:path";
import ts from "typescript";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const workspaceHelpers = await jiti.import("./remote-workspace.ts");
const paths = await jiti.import("./paths.ts");
const require = createRequire(import.meta.url);
const source = readFileSync(new URL("./remote-project-context.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;

function loader(stdout, calls) {
  const exports = {};
  runInNewContext(compiled, { exports, Buffer, TextDecoder, require(id) {
    if (id === "./ssh") return { sshExec: async (...args) => { calls.push(args); return stdout; } };
    if (id === "./remote-workspace") return workspaceHelpers;
    if (id === "./paths") return paths;
    return require(id);
  } });
  return exports.remoteContextOverride;
}

test("remote context only injects text and excludes stale cache/host ancestor instructions", async () => {
  const calls = [];
  const output = `/srv/project/AGENTS.md\0${Buffer.from("project instructions").toString("base64")}\0/srv/AGENTS.override.md\0${Buffer.from("parent instructions").toString("base64")}\0`;
  const localRoot = path.resolve("cache-root");
  const agentDir = path.resolve("host-agent");
  const apply = await loader(output, calls)({ host: "server", cwd: "/srv/project", localRoot }, localRoot, agentDir);
  const result = apply({ agentsFiles: [
    { path: path.join(agentDir, "AGENTS.md"), content: "global" },
    { path: path.join(localRoot, "AGENTS.md"), content: "stale cache" },
    { path: path.resolve("AGENTS.md"), content: "host project" },
  ] });
  assert.deepEqual(Array.from(result.agentsFiles, (file) => file.content), ["global", "parent instructions", "project instructions"]);
  assert.equal(calls[0][0], "server");
  assert.match(calls[0][1], /AGENTS.override.md AGENTS.md CLAUDE.md/);
  assert.doesNotMatch(calls[0][1], /tar|\.pi\/extensions/);
});

test("empty remote context is valid, malformed framing is rejected", async () => {
  const root = path.resolve("cache");
  const workspace = { host: "server", cwd: "/srv/project", localRoot: root };
  const apply = await loader("", [])(workspace, root, path.resolve("host-agent"));
  assert.equal(apply({ agentsFiles: [] }).agentsFiles.length, 0);
  await assert.rejects(loader("broken", [])(workspace, root, path.resolve("host-agent")), /Invalid remote context/);
});
