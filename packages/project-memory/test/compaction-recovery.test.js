import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJiti } from 'jiti';
import { loadStore, storePathFor, DEFAULT_CONFIG, saveHandoff, persistStore } from '../src/store.ts';
import { loadCheckpoints } from '../src/checkpoints.ts';
const { default: factory } = await createJiti(import.meta.url).import('../extensions/index.ts');

test('automatic compaction checkpoints preserve original and recover after compact/new session without prefix edits', async () => {
 const root = await mkdtemp(join(tmpdir(),'pm-cmp-')); const old = process.env.PI_CODING_AGENT_DIR;
 const agentDir = join(root, 'agent'); await mkdir(agentDir); process.env.PI_CODING_AGENT_DIR = agentDir;
 try {
  const file = join(root,'session.jsonl');
  const branch = [
   { type:'message', id:'u1', parentId:null, message:{role:'user',content:'重要约束：接口必须保留 old_flag 参数，不可删除'} },
   { type:'message', id:'a1', parentId:'u1', message:{role:'assistant',content:[{type:'text',text:'已确认；接下来补充兼容性测试'}]} }
  ];
  const original = [{type:'session',id:'sess',cwd:root}, ...branch].map(e=>JSON.stringify(e)).join('\n')+'\n';
  await writeFile(file,original);
  const handlers = new Map(); const tools = new Map(); const sent=[]; const notices=[];
  factory({on:(n,f)=>handlers.set(n,f),registerTool:t=>tools.set(t.name,t),registerCommand(){},exec:async()=>({code:0,stdout:root}),sendMessage:(m,o)=>sent.push({m,o})});
  let entries=branch;
  const ctx={cwd:root,hasUI:true,isProjectTrusted:()=>true,sessionManager:{getSessionFile:()=>file,getLeafId:()=>entries.at(-1)?.id??null,getEntries:()=>entries},ui:{notify:(m)=>notices.push(m),setStatus(){}}};
  const event={reason:'threshold',signal:new AbortController().signal,preparation:{messagesToSummarize:branch,firstKeptEntryId:'a1'}};
  await handlers.get('session_start')({reason:'startup'},ctx);
  assert.equal(sent.length,0);
  const eventBefore=JSON.stringify(event); const branchBefore=JSON.stringify(branch);
  assert.equal(await handlers.get('session_before_compact')(event,ctx),undefined);
  assert.equal(JSON.stringify(event),eventBefore); assert.equal(JSON.stringify(branch),branchBefore);
  assert.equal(sent.length,0); // nothing injected before the actual compaction request
  assert.equal(await readFile(file,'utf8'),original);
  const [cp]=await loadCheckpoints(root); assert.ok(cp);
  await handlers.get('session_compact')({compactionEntry:{summary:'当前任务：补测试。下一步运行回归。'}},ctx);
  assert.equal(sent.length,1); assert.equal(sent[0].o.triggerTurn,false);
  assert.match(sent[0].m.content,new RegExp(cp.id));
  const {store}=await loadStore(storePathFor(root)); assert.match(store.handoff.content,/补测试/);
  assert.ok(store.handoff.title.length+store.handoff.content.length<=DEFAULT_CONFIG.budgets.handoff.maxChars);
  const search=await tools.get('project_memory_recall').execute('t',{action:'search',checkpointId:cp.id,query:'old_flag'},null,null,ctx);
  assert.match(search.content[0].text,/u1/);
  const read=await tools.get('project_memory_recall').execute('t',{action:'read',checkpointId:cp.id,entryId:'u1'},null,null,ctx);
  assert.match(read.content[0].text,/不可删除/);
  entries=[];
  await handlers.get('session_start')({reason:'new'},ctx);
  assert.equal(sent.length,2); assert.match(sent[1].m.content,/补测试/); assert.match(sent[1].m.content,/project_memory_recall/);
  assert.equal(handlers.has('context'),false); assert.equal(handlers.has('before_agent_start'),false);
  assert.equal(await readFile(file,'utf8'),original);
  // Source missing -> cancel manual AND overflow compaction, no pretending it was protected.
  await rm(file); entries=branch;
  for(const reason of ['manual','overflow']) assert.deepEqual(await handlers.get('session_before_compact')({...event,reason},ctx),{cancel:true});
  assert.ok(notices.some(n=>n.includes('压缩已取消')));
 } finally {
  if(old===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=old;
  await rm(root,{recursive:true,force:true});
 }
});

test('checkpoint switch disables hooks; failed compaction retains checkpoint but does not publish successful handoff', async()=>{
 const root=await mkdtemp(join(tmpdir(),'pm-cmp-fail-')); const old=process.env.PI_CODING_AGENT_DIR;
 process.env.PI_CODING_AGENT_DIR=join(root,'agent');await mkdir(process.env.PI_CODING_AGENT_DIR);
 try{
  const file=join(root,'s.jsonl'); const e={type:'message',id:'u',parentId:null,message:{role:'user',content:'pending'}};
  await writeFile(file,[{type:'session',id:'s',cwd:root},e].map(JSON.stringify).join('\n'));
  const hooks=new Map();const sent=[];factory({on:(n,f)=>hooks.set(n,f),registerTool(){},registerCommand(){},exec:async()=>({code:0,stdout:root}),sendMessage:m=>sent.push(m)});
  const ctx={cwd:root,hasUI:false,isProjectTrusted:()=>true,sessionManager:{getSessionFile:()=>file,getLeafId:()=>e.id,getEntries:()=>[e]}};
  const event={reason:'manual',signal:new AbortController().signal};
  await hooks.get('session_start')({reason:'startup'},ctx);
  await hooks.get('session_before_compact')(event,ctx);
  assert.equal((await loadCheckpoints(root)).length,1);
  await hooks.get('session_compact_failed')({},ctx);
  assert.equal((await loadStore(storePathFor(root))).store.handoff,null);assert.equal(sent.length,0);
  // A newer explicit handoff must not get overwritten by the compaction summary.
  await hooks.get('session_before_compact')(event,ctx);
  let s=(await loadStore(storePathFor(root))).store;
  s=saveHandoff(s,DEFAULT_CONFIG,{title:'用户确认',content:'以后按这个步骤执行'}).store;
  s.handoff.updatedAt=Date.now()+1000; await persistStore(storePathFor(root),s);
  await hooks.get('session_compact')({compactionEntry:{summary:'older summary'}},ctx);
  assert.equal((await loadStore(storePathFor(root))).store.handoff.content,'以后按这个步骤执行');
  await writeFile(join(process.env.PI_CODING_AGENT_DIR,'project-memory.json'),JSON.stringify({checkpoint:{enabled:false}}));
  await hooks.get('session_start')({reason:'reload'},ctx);await rm(file);
  assert.equal(await hooks.get('session_before_compact')(event,ctx),undefined);
 }finally{if(old===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=old;await rm(root,{recursive:true,force:true});}
});
