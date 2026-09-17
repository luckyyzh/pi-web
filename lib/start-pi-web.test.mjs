import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const launcher = fileURLToPath(new URL('../start-pi-web.cmd', import.meta.url));
const bytes = readFileSync(launcher);
const source = bytes.toString('utf8');
const windows = process.platform === 'win32';

test('launcher has UTF-8 Chinese REMs after an ASCII codepage bootstrap and CRLF', () => {
  assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.equal(source.includes('\ufffd'), false);
  assert.match(source, /^@echo off\r\nsetlocal\r\nchcp 65001 >nul\r\n/);
  const firstChinese = source.search(/[^\x00-\x7f]/);
  assert.ok(firstChinese > source.indexOf('chcp 65001 >nul'));
  assert.match(source, /REM [\u4e00-\u9fff]/);
  assert.equal(/(?<!\r)\n|\r(?!\n)/.test(source), false);
});

// All executable branch tests use a disposable copy, fake HOME, fake CLI/npm,
// and fake helper. No project install/build, real helper, service or port is used.
function fixture(t, { dependencies = true } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'pi-web-launcher-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const stubs = path.join(root, 'stubs');
  const log = path.join(root, 'events.jsonl');
  for (const dir of [home, stubs, path.join(root, 'bin')]) mkdirSync(dir, { recursive: true });
  const deps = path.join(root, 'node_modules', '@earendil-works', 'pi-coding-agent');
  if (dependencies) mkdirSync(deps, { recursive: true });
  writeFileSync(path.join(root, 'start-pi-web.cmd'), bytes);
  const recorder = `const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TEST_LOG, JSON.stringify({args, agentDir: process.env.PI_CODING_AGENT_DIR, dependencies: fs.existsSync(path.join(process.cwd(), 'node_modules/@earendil-works/pi-coding-agent'))})+'\\n');
if (args[0] === 'npm' && args[1] === 'install') { fs.mkdirSync('node_modules/@earendil-works/pi-coding-agent', {recursive:true}); process.exit(0); }
if (args[0] === 'npm' && args[1] === 'run') process.exit(31);
if (args[0] === 'helper') process.exit(Number(process.env.TEST_HELPER_EXIT || 0));
if (args[0] !== 'pi') process.exit(99);
`;
  writeFileSync(path.join(stubs, 'record.cjs'), recorder);
  for (const command of ['npm', 'pi', 'netstat', 'taskkill', 'ping']) {
    writeFileSync(path.join(stubs, `${command}.cmd`), `@echo off\r\n"${process.execPath}" "%~dp0record.cjs" ${command} %*\r\nexit /b %errorlevel%\r\n`);
  }
  writeFileSync(path.join(root, 'bin', 'sync-pi-extensions.js'), `process.argv.splice(2,0,'helper');require('../stubs/record.cjs');`);
  writeFileSync(path.join(root, 'bin', 'pi-web.js'), `process.argv.splice(2,0,'unexpected-server');require('../stubs/record.cjs');`);
  const env = { ...process.env };
  // Windows environment keys are case-insensitive; avoid duplicate PATH entries.
  for (const key of Object.keys(env)) if (['path', 'port', 'pi_coding_agent_dir', 'userprofile'].includes(key.toLowerCase())) delete env[key];
  Object.assign(env, { PATH: [stubs, path.dirname(process.execPath), path.join(process.env.SystemRoot, 'System32')].join(';'), USERPROFILE: home, PI_CODING_AGENT_DIR: path.join(home, 'custom-agent'), TEST_LOG: log });
  return {
    root, home, env,
    run(args, extraEnv = {}) {
      // CALL itself consumes /? as help; invoke that alias directly instead.
      const result = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', `${args === '/?' ? '' : 'call '}start-pi-web.cmd ${args}`], {
        cwd: root, env: { ...env, ...extraEnv }, windowsVerbatimArguments: true, encoding: 'utf8', input: '\r\n', timeout: 15000,
      });
      assert.ifError(result.error);
      return result;
    },
    events() { return existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : []; },
  };
}

const winTest = (name, fn) => test(name, { skip: !windows }, fn);
winTest('real cmd parses help without installation or helper side effects', t => {
  const f = fixture(t);
  for (const arg of ['help', '--help', '-h', '/?']) {
    const result = f.run(arg);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /update \[instance-name\]/);
  }
  assert.deepEqual(f.events(), []);
});
winTest('invalid ports, extra arguments and unsafe instance names fail before side effects', t => {
  const f = fixture(t);
  for (const args of ['0', '65536', '-1', '30abc', '1.5', 'unknown', '30200 ../escape', 'update ..', 'update a/b', 'update a\\b', 'update "bad name "', 'update "a&b"', 'update CON', 'update CON.txt', 'update x y', 'help extra', `update ${'a'.repeat(65)}`]) {
    const result = f.run(args);
    assert.equal(result.status, 2, `${args}: ${result.stdout}${result.stderr}`);
  }
  assert.deepEqual(f.events(), []);
  assert.equal(existsSync(path.join(f.home, '.pi')), false);
});
winTest('update preserves custom agent directory and exits without global CLI, build or ports', t => {
  const f = fixture(t);
  const result = f.run('update', { PORT: 'not-a-port' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(f.events(), [{ args: ['helper', 'update'], agentDir: f.env.PI_CODING_AGENT_DIR, dependencies: true }]);
  assert.doesNotMatch(result.stdout, /build artifacts|Starting pi-web|Press any key/);
});
winTest('update installs missing project dependencies before helper with isolated instance env', t => {
  const f = fixture(t, { dependencies: false });
  const result = f.run('update Agent_1');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const events = f.events();
  assert.deepEqual(events.map(e => e.args), [['npm', 'install', '--include=dev'], ['helper', 'update']]);
  for (const event of events) assert.equal(event.agentDir, path.join(f.home, '.pi', 'pi-web-instances', 'Agent_1'));
  assert.equal(events[1].dependencies, true);
});
winTest('Chinese instance names with spaces remain supported', t => {
  const f = fixture(t);
  const result = f.run('update "我的 Agent"');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(f.events()[0].agentDir, path.join(f.home, '.pi', 'pi-web-instances', '我的 Agent'));
});
winTest('ensure runs before stub build with isolated instance env; build failure prevents ports', t => {
  const f = fixture(t);
  const result = f.run('30200 Agent-2');
  assert.notEqual(result.status, 0);
  const events = f.events();
  assert.deepEqual(events.map(e => e.args), [['pi', '--version'], ['helper', 'ensure'], ['npm', 'run', 'build']]);
  for (const event of events) assert.equal(event.agentDir, path.join(f.home, '.pi', 'pi-web-instances', 'Agent-2'));
  assert.equal(events[1].dependencies, true);
});
winTest('helper failure short-circuits update and ordinary default/next/explicit startup', t => {
  for (const args of ['update', '', 'next', '65535']) {
    const f = fixture(t);
    const result = f.run(args, { TEST_HELPER_EXIT: '17' });
    assert.notEqual(result.status, 0);
    const expected = args === 'update' ? [['helper', 'update']] : [['pi', '--version'], ['helper', 'ensure']];
    assert.deepEqual(f.events().map(e => e.args), expected);
    assert.doesNotMatch(result.stdout, /build artifacts|Starting pi-web|Press any key/);
  }
});
