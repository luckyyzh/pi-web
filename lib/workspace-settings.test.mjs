import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { createWorkspaceSettings } = await jiti.import("./workspace-settings.ts");

test("remote settings keep host plugins but exclude legacy SSH and cached project code without writing user settings", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-web-remote-settings-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const agentDir = path.join(root, "agent");
  const cwd = path.join(root, "project");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(path.join(cwd, ".pi"), { recursive: true });
  const settingsPath = path.join(agentDir, "settings.json");
  const raw = JSON.stringify({ packages: ["ssh", "npm:some-ssh-helper", "npm:skills-package"], defaultTools: ["read", "powershell"], shellCommandPrefix: "host-only setup" });
  writeFileSync(settingsPath, raw);
  writeFileSync(path.join(cwd, ".pi", "settings.json"), JSON.stringify({ packages: ["./untrusted"] }));
  const settings = createWorkspaceSettings(cwd, agentDir, true);
  assert.deepEqual(settings.getGlobalSettings().packages, ["npm:some-ssh-helper", "npm:skills-package"]);
  assert.deepEqual(settings.getProjectSettings(), {});
  assert.deepEqual(settings.getDefaultTools(), ["read", "bash"]);
  assert.equal(settings.getShellCommandPrefix(), undefined);
  assert.equal(settings.isProjectTrusted(), false);
  assert.equal(readFileSync(settingsPath, "utf8"), raw);
});
