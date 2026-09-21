import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createJiti } from 'jiti';
import { emptyStore, DEFAULT_CONFIG, addProposal, persistStore, storePathFor, loadStore } from '../src/store.ts';
const { default: factory } = await createJiti(import.meta.url).import('../extensions/index.ts');

test('Web memory commands: correct panel hint, no-id approval UI, cancel and headless deny', async () => {
 const root=await mkdtemp(join(tmpdir(),'pm-ui-'));const old=process.env.PI_CODING_AGENT_DIR;
 process.env.PI_CODING_AGENT_DIR=join(root,'agent');await mkdir(process.env.PI_CODING_AGENT_DIR);
 try {
  let command;const notices=[];const dialogs=[];let selected=false;let confirm=false;let confirmations=0;
  factory({on(){},registerTool(){},registerCommand:(_n,c)=>command=c,exec:async()=>({code:0,stdout:root})});
  const ctx={cwd:root,mode:'rpc',hasUI:true,isProjectTrusted:()=>true,ui:{setWidget(){},notify:m=>notices.push(m),
   select:async(title,options)=>{dialogs.push({title,options});return selected?options.find(o=>o.includes('demo-ui')):undefined;},
   confirm:async(title,message)=>{confirmations++;assert.match(message,/第二行验证步骤/);return confirm;}}};
  const result=addProposal(emptyStore(),DEFAULT_CONFIG,{kind:'new',name:'demo-ui',description:'UI test',content:'第一行流程\n第二行验证步骤'});
  await persistStore(storePathFor(root),result.store);
  await command.handler('',ctx);assert.ok(notices.some(m=>m.includes('底栏')&&m.includes('/memory list')));
  await command.handler('approve',ctx);assert.equal(confirmations,0);assert.equal((await loadStore(storePathFor(root))).store.proposals.length,1);
  selected=true;await command.handler('approve',ctx);assert.equal(confirmations,1);
  assert.equal((await loadStore(storePathFor(root))).store.proposals.length,1); // select is not consent
  confirm=true;await command.handler('approve',ctx);assert.equal(confirmations,2);
  assert.match(await readFile(join(root,'.pi','skills','demo-ui','SKILL.md'),'utf8'),/第二行验证步骤/);
  assert.equal((await loadStore(storePathFor(root))).store.proposals.length,0);
  const next=addProposal((await loadStore(storePathFor(root))).store,DEFAULT_CONFIG,{kind:'new',name:'browse-ui',description:'Browser approval',content:'第二行验证步骤'});
  await persistStore(storePathFor(root),next.store);
  const choices=['待审批','browse-ui','审批此提案'];
  ctx.ui.select=async(_title,options)=>{const choice=choices.shift();return options.find(o=>o.includes(choice));};
  await command.handler('list',ctx);
  assert.equal(confirmations,3); // browser routes through the SAME explicit confirm gate
  assert.match(await readFile(join(root,'.pi','skills','browse-ui','SKILL.md'),'utf8'),/第二行验证步骤/);
  ctx.hasUI=false;const before=dialogs.length;const errors=[];const originalError=console.error;
  try { console.error=(m)=>errors.push(m); await command.handler('list',ctx); }
  finally { console.error=originalError; }
  assert.equal(dialogs.length,before);assert.ok(errors.some(m=>m.includes('交互界面')));
 } finally {if(old===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=old;await rm(root,{recursive:true,force:true});}
});
