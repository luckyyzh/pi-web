import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG, emptyStore, registerManagedSkill, saveHandoff, makeFallbackHandoff, entryChars, saveKnowledge, updateKnowledge, loadStore, mutateStore, withStoreLock } from '../src/store.ts';

test('skill updates cannot bypass byte budget; fingerprints retained', () => {
 const c = structuredClone(DEFAULT_CONFIG); c.budgets.skills.maxTotalBytes = 20;
 const s = registerManagedSkill(emptyStore(), c, { name: 'test', bytes: 10, sha256: 'a'.repeat(64) }).store;
 assert.throws(() => registerManagedSkill(s, c, { name: 'test', bytes: 21 }), /超限/);
 assert.equal(registerManagedSkill(s, c, { name: 'test', bytes: 15 }).store.managedSkills[0].sha256, 'a'.repeat(64));
});
test('small handoff budgets are enforced, including fallback', () => {
 for (const cap of [1, 20, 50, 100]) {
  const c = structuredClone(DEFAULT_CONFIG); c.budgets.handoff.maxChars = cap;
  assert.throws(() => saveHandoff(emptyStore(), c, { title: 'x'.repeat(cap), content: 'a' }));
  const { store } = makeFallbackHandoff(emptyStore(), c, 'x'.repeat(1000));
  assert.ok(!store.handoff || entryChars(store.handoff) <= cap);
 }
});
test('merge retains source references and ancestors, permits shrinking an over-count store', () => {
 const c = structuredClone(DEFAULT_CONFIG); let s = emptyStore(); const ids = [];
 for (let i = 0; i < 3; i++) { const r = saveKnowledge(s, c, { title: 't', content: 'c', sourceRef: `session-${i}` }); s = r.store; ids.push(r.entry.id); }
 c.budgets.knowledge.maxEntries = 2;
 const first = updateKnowledge(s, c, { action: 'merge', ids: ids.slice(0,2), title: 't', content: 'c' });
 const second = updateKnowledge(first.store, c, { action: 'merge', ids: [first.entry.id, ids[2]], title: 't', content: 'c' });
 assert.ok(ids.every(id => second.entry.mergedFrom.includes(id)));
 assert.deepEqual(second.entry.sourceRefs.sort(), ['session-0','session-1','session-2']);
 assert.equal(second.entry.verified, false);
});
test('corrupt/unsupported stores stay intact and cannot be silently replaced', async () => {
 const d = await mkdtemp(join(tmpdir(), 'pm-store-')); const p = join(d, 'store.json');
 try {
  for (const data of ['{broken', JSON.stringify({ ...emptyStore(), version: 2 }), JSON.stringify({ ...emptyStore(), knowledge: [null] })]) {
   await writeFile(p, data);
   await assert.rejects(loadStore(p));
   await assert.rejects(mutateStore(p, () => ({ store: emptyStore() }), DEFAULT_CONFIG));
   assert.equal(await readFile(p, 'utf8'), data);
  }
 } finally { await rm(d, { recursive: true, force: true }); }
});
test('old owned lock is not stolen; release does not remove changed owner', async () => {
 const d = await mkdtemp(join(tmpdir(), 'pm-lock-')); const p = join(d, 'store'); const lock = `${p}.lock`;
 try {
  await mkdir(lock); await writeFile(join(lock,'pid.json'), JSON.stringify({ pid: process.pid, token: 'other' }));
  await utimes(lock, new Date(0), new Date(0));
  await assert.rejects(withStoreLock(p, () => {}, { staleMs: 1, waitMs: 20, pollMs: 5 }), /超时/);
  await rm(lock, { recursive: true });
  await withStoreLock(p, () => writeFile(join(lock,'pid.json'), JSON.stringify({ pid: process.pid, token: 'replacement' })));
  assert.match(await readFile(join(lock,'pid.json'),'utf8'), /replacement/);
 } finally { await rm(d, { recursive: true, force: true }); }
});
