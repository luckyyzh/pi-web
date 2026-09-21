import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJiti } from 'jiti';
import { emptyStore, saveHandoff, persistStore, storePathFor, DEFAULT_CONFIG } from '../src/store.ts';

const jiti = createJiti(import.meta.url);
const { default: factory } = await jiti.import('../extensions/index.ts');

test('saved memory never changes system/history; resumed startup gets no duplicate handoff', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pm-cache-'));
  const previousHome = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, 'agent');
  await mkdir(process.env.PI_CODING_AGENT_DIR);
  try {
    await persistStore(storePathFor(root), saveHandoff(emptyStore(), DEFAULT_CONFIG, { title: 'Next', content: 'Finish regression tests' }).store);
    const events = new Map(); const tools = new Map(); const messages = [];
    factory({ on: (name, fn) => events.set(name, fn), registerTool: t => tools.set(t.name, t), registerCommand() {},
      exec: async () => ({ code: 0, stdout: root }), sendMessage: m => messages.push(m) });
    let history = [{ type: 'message', message: { role: 'user', content: 'original' } }];
    const ctx = { cwd: root, hasUI: false, isProjectTrusted: () => true,
      sessionManager: { getEntries: () => history, getSessionFile: () => 'source-session.jsonl' } };
    await events.get('session_start')({ reason: 'startup' }, ctx);
    assert.equal(messages.length, 0);
    assert.equal(events.has('context'), false);
    assert.equal(events.has('before_agent_start'), false);
    const originalHistory = JSON.stringify(history);
    await tools.get('project_memory_save').execute('1', { kind: 'handoff', title: 'Changed', content: 'New next step' }, undefined, undefined, ctx);
    assert.equal(messages.length, 0);
    assert.equal(JSON.stringify(history), originalHistory);
    history = [];
    await events.get('session_start')({ reason: 'new' }, ctx);
    assert.equal(messages.length, 1);
    assert.match(messages[0].content, /New next step/);
    history = [{ type: 'custom_message' }];
    await events.get('session_start')({ reason: 'startup' }, ctx);
    assert.equal(messages.length, 1);
  } finally {
    if (previousHome === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousHome;
    await rm(root, { recursive: true, force: true });
  }
});
