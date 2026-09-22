import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createJiti } from 'jiti';
const { default: factory } = await createJiti(import.meta.url).import('../extensions/index.ts');

test('real hooks: UI only, deduplicated, successful handoff only, reset and opt out', async () => {
  const root = await mkdtemp(join(tmpdir(), 'handoff-hooks-'));
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, 'agent');
  await mkdir(process.env.PI_CODING_AGENT_DIR);
  try {
    const events = new Map(); const tools = []; const notices = [];
    factory({on: (name, handler) => events.set(name, handler), registerTool: t => tools.push(t), registerCommand(){}, exec: async () => ({code:0, stdout:root})});
    const ctx = {cwd:root, hasUI:true, isProjectTrusted:()=>true, ui:{notify: text => notices.push(text), setStatus(){}, setWidget(){}}};
    const settled = () => events.get('agent_settled')({}, ctx);
    let id = 0;
    const endTool = async (toolName, args = {}, isError = false) => {
      const toolCallId = String(++id);
      await events.get('tool_execution_start')({toolCallId, toolName, args}, ctx);
      await events.get('tool_execution_end')({toolCallId, toolName, isError, result:{}}, ctx);
    };
    await settled(); assert.equal(notices.length, 0);
    await endTool('edit', {}, true); await settled(); assert.equal(notices.length, 0);
    await endTool('write'); await endTool('project_memory_save', {kind:'knowledge'});
    await endTool('project_memory_save', {kind:'handoff'}, true);
    await settled(); assert.equal(notices.length, 1);
    await endTool('edit'); await settled(); assert.equal(notices.length, 1);
    await endTool('project_memory_save', {kind:'handoff'}); await settled(); assert.equal(notices.length, 1);
    await endTool('edit'); await settled(); assert.equal(notices.length, 2);
    await events.get('session_start')({}, ctx); // fresh session has no pending state
    notices.length = 0; await settled(); assert.equal(notices.length, 0);
    await writeFile(join(process.env.PI_CODING_AGENT_DIR,'project-memory.json'), JSON.stringify({handoffReminder:{enabled:false}}));
    await events.get('session_start')({}, ctx); notices.length = 0;
    await endTool('edit'); await settled(); assert.equal(notices.length, 0);
    assert.ok(tools.find(t => t.name === 'project_memory_save').promptGuidelines.some(t => t.includes('must save the current handoff')));
  } finally {
    if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old;
    await rm(root, {recursive:true, force:true});
  }
});
