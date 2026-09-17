import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import sync from '../bin/sync-pi-extensions.js';

const { syncExtensions, applyPatch, MARKER } = sync;
const hash = (s) => createHash('sha256').update(s).digest('hex');
function put(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-ext-中文 space-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const agentDir = path.join(root, 'instance');
  const repo = path.join(agentDir, 'pi-web-extensions');
  const item = { name: 'example-tasks', version: '1.0.0', patch: 'patches/tasks/manifest.json' };
  const packages = [];
  const calls = [];
  let fail = false;
  const createManager = async () => ({
    packages: () => packages,
    async install(source) {
      calls.push(['install', source]);
      if (fail) throw new Error('install failed');
      if (source.startsWith('npm:')) {
        const dir = path.join(agentDir, 'npm/node_modules/example-tasks');
        put(path.join(dir, 'package.json'), { name: item.name, version: item.version });
        put(path.join(dir, 'src/a.ts'), 'original');
      }
      const stored = source.startsWith('npm:') ? source : path.relative(agentDir, source).replace(/\\/g, '/');
      if (!packages.includes(stored)) packages.push(stored);
    },
  });
  const runGit = async (args) => {
    calls.push(['git', ...args]);
    if (args[0] !== 'clone') return;
    put(path.join(repo, 'install-manifest.json'), { schemaVersion: 1, packages: [item, { name: 'example-local', path: 'example-local' }] });
    put(path.join(repo, 'example-local/package.json'), { name: 'example-local', pi: { skills: ['./skills'] } });
    put(path.join(repo, 'patches/tasks/src/a.ts'), 'patched');
    put(path.join(repo, item.patch), { package: item.name, version: item.version, files: [{ path: 'src/a.ts', before: hash('original'), after: hash('patched') }] });
  };
  return { root, repo, agentDir, item, packages, calls, marker: path.join(agentDir, MARKER),
    options: { agentDir, repository: 'https://example.invalid/extensions.git', createManager, runGit, log() {} },
    setFailure(value) { fail = value; },
  };
}

test('first install applies patch and registers packages; subsequent start does not load SDK or use network', async (t) => {
  const f = fixture(t);
  await syncExtensions(f.options);
  assert.equal(fs.existsSync(f.marker), true);
  assert.deepEqual(f.packages, ['npm:example-tasks@1.0.0', 'pi-web-extensions/example-local']);
  assert.equal(fs.readFileSync(path.join(f.agentDir, 'npm/node_modules/example-tasks/src/a.ts'), 'utf8'), 'patched');
  await syncExtensions({ ...f.options, createManager() { throw new Error('SDK must not load'); }, runGit() { throw new Error('No network'); } });
  assert.equal(fs.existsSync(path.join(f.root, 'another-instance', MARKER)), false);
});

test('update pulls explicitly and updates listed npm packages; existing local sources remain untouched', async (t) => {
  const f = fixture(t);
  f.packages.push('example-local');
  await syncExtensions(f.options);
  f.calls.length = 0;
  await syncExtensions({ ...f.options, mode: 'update' });
  assert.deepEqual(f.calls[0], ['git', 'pull', '--ff-only', 'origin', 'main']);
  assert.deepEqual(f.calls.filter((c) => c[0] === 'install'), [['install', 'npm:example-tasks@1.0.0']]);
  assert.equal(f.packages.filter((p) => p.endsWith('example-local')).length, 1);
});

test('failure does not leave a success marker; retry completes registration and patch', async (t) => {
  const f = fixture(t);
  f.setFailure(true);
  await assert.rejects(syncExtensions(f.options), /install failed/);
  assert.equal(fs.existsSync(f.marker), false);
  f.setFailure(false);
  await syncExtensions(f.options);
  assert.equal(fs.existsSync(f.marker), true);
  // 模拟安装后、应用补丁前退出：已登记包在下一次 ensure 仍补齐修复。
  fs.unlinkSync(f.marker);
  put(path.join(f.agentDir, 'npm/node_modules/example-tasks/src/a.ts'), 'original');
  await syncExtensions(f.options);
  assert.equal(fs.readFileSync(path.join(f.agentDir, 'npm/node_modules/example-tasks/src/a.ts'), 'utf8'), 'patched');
});

test('patch refuses unknown local edits without overwriting them', async (t) => {
  const f = fixture(t);
  await syncExtensions(f.options);
  const file = path.join(f.agentDir, 'npm/node_modules/example-tasks/src/a.ts');
  put(file, 'personal edit');
  assert.throws(() => applyPatch(f.repo, f.agentDir, f.item), /Locally modified/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'personal edit');
});
