import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { saveCheckpoint, readCheckpointSource } from '../src/checkpoints.ts';

test('real Pi SessionManager: omitted user message remains recoverable after compaction and reopen', async () => {
 const root=await mkdtemp(join(tmpdir(),'pm-sdk-'));
 try {
  const manager=SessionManager.create(root,join(root,'sessions'));
  const oldId=manager.appendMessage({role:'user',content:[{type:'text',text:'务必保留旧接口 /api/v1/orders'}],timestamp:Date.now()});
  manager.appendMessage({role:'assistant',content:[{type:'text',text:'已记录，继续实现'}],api:'openai-completions',provider:'test',model:'test',stopReason:'stop',timestamp:Date.now(),usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}});
  const kept=manager.appendMessage({role:'user',content:[{type:'text',text:'现在先运行测试'}],timestamp:Date.now()});
  const checkpoint=await saveCheckpoint(root,manager.getSessionFile(),manager.getLeafId(),'manual');
  manager.appendCompaction('在实现项目；细节省略',kept,30000);
  const reopened=SessionManager.open(manager.getSessionFile(),join(root,'sessions'));
  assert.ok(!reopened.buildContextEntries().some(e=>e.id===oldId));
  const recovered=await readCheckpointSource(root,checkpoint.id,{entryId:oldId});
  assert.match(recovered.content,/\/api\/v1\/orders/);
 }finally{await rm(root,{recursive:true,force:true});}
});
