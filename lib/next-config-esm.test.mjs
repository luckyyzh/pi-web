import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const configUrl = new URL("../next.config.ts", import.meta.url);
const source = await readFile(configUrl, "utf8");

test("resolves config paths without CommonJS globals", async () => {
  assert.doesNotMatch(source, /\b__dirname\b/);
  assert.match(source, /dirname\(fileURLToPath\(import\.meta\.url\)\)/);

  const config = await import(`${configUrl.href}?esm-test`);
  assert.equal(typeof config.default.env.NEXT_PUBLIC_APP_VERSION, "string");
});

test("cross-drive tracing exclusions match native Windows paths before tracing", async () => {
  const { default: config } = await import(`${configUrl.href}?esm-test`);
  const patterns = config.outputFileTracingExcludes["/*"];
  if (!patterns.length) return;
  class TraceEntryPointsPlugin { traceIgnores = []; }
  const plugin = new TraceEntryPointsPlugin();
  config.webpack({ plugins: [plugin] });
  const picomatch = createRequire(import.meta.url)("next/dist/compiled/picomatch");
  const ignored = picomatch(plugin.traceIgnores, { contains: true, dot: true });
  assert.equal(ignored(`${process.env.USERPROFILE}\\AppData\\cache\\example`), true);
  assert.equal(ignored(fileURLToPath(configUrl)), false);
});

test("blocks profile-root tracing through every readdir API but keeps project files", {
  skip: !process.env.USERPROFILE,
}, async () => {
  await import(`${configUrl.href}?esm-test`);
  for (const root of [process.env.USERPROFILE, `${process.env.USERPROFILE}/`]) {
    assert.deepEqual(await fs.promises.readdir(root, { withFileTypes: true }), []);
    assert.deepEqual(fs.readdirSync(root), []);
    assert.deepEqual(await new Promise((resolve, reject) => {
      fs.readdir(root, (error, entries) => error ? reject(error) : resolve(entries));
    }), []);
  }
  const projectDir = fileURLToPath(new URL("../", import.meta.url));
  assert.ok((await fs.promises.readdir(projectDir)).includes("package.json"));
});
