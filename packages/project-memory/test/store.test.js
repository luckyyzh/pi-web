/**
 * test/store.test.js — 存储核心：预算、整合（merge/archive）、原子写、锁、配置容错。
 * 运行：npm --prefix packages/project-memory test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BudgetError,
  DEFAULT_CONFIG,
  archiveKnowledge,
  clearBucket,
  clearHandoff,
  emptyStore,
  loadConfig,
  loadStore,
  makeFallbackHandoff,
  mutateStore,
  persistStore,
  removeEntry,
  saveHandoff,
  saveKnowledge,
  storePathFor,
  storeUsage,
  updateKnowledge,
  withStoreLock,
  addProposal,
  registerManagedSkill,
  unregisterManagedSkill,
  removeProposal,
} from "../src/store.ts";

async function makeDir() {
  return mkdtemp(join(tmpdir(), "pm-store-"));
}

function smallConfig(overrides = {}) {
  const c = structuredClone(DEFAULT_CONFIG);
  Object.assign(c.budgets.knowledge, { maxEntries: 3, maxChars: 600 }, overrides.knowledge ?? {});
  if (overrides.handoff) Object.assign(c.budgets.handoff, overrides.handoff);
  if (overrides.archive) Object.assign(c.budgets.archive, overrides.archive);
  if (overrides.proposals) Object.assign(c.budgets.proposals, overrides.proposals);
  if (overrides.skills) Object.assign(c.budgets.skills, overrides.skills);
  return c;
}

/* ---------------- 配置容错 ---------------- */

test("loadConfig: 文件缺失 → 默认值", async () => {
  const dir = await makeDir();
  const cfg = await loadConfig(join(dir, "nope.json"));
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.budgets.knowledge.maxEntries, DEFAULT_CONFIG.budgets.knowledge.maxEntries);
});

test("loadConfig: 损坏文件 → 默认值", async () => {
  const dir = await makeDir();
  const p = join(dir, "cfg.json");
  await writeFile(p, "{not json", "utf8");
  const cfg = await loadConfig(p);
  assert.deepEqual(cfg, DEFAULT_CONFIG);
});

test("loadConfig: 部分字段 + 非法字段 → 合法值生效、非法值回退默认（向后兼容）", async () => {
  const dir = await makeDir();
  const p = join(dir, "cfg.json");
  await writeFile(p, JSON.stringify({ enabled: false, budgets: { knowledge: { maxEntries: 7, maxChars: "bad" } } }), "utf8");
  const cfg = await loadConfig(p);
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.budgets.knowledge.maxEntries, 7);
  assert.equal(cfg.budgets.knowledge.maxChars, DEFAULT_CONFIG.budgets.knowledge.maxChars);
});

/* ---------------- 保存与预算 ---------------- */

test("saveKnowledge: 正常保存并计入预算", () => {
  const cfg = smallConfig();
  const { store, entry } = saveKnowledge(emptyStore(), cfg, { title: "构建命令", content: "npm test 跑全部测试", tags: ["ci"] });
  assert.equal(store.knowledge.length, 1);
  assert.match(entry.id, /^k-/);
  assert.equal(entry.verified, false);
  const u = storeUsage(store, cfg);
  assert.equal(u.knowledge.entries, 1);
});

test("saveKnowledge: 条目数满 → BudgetError 且指引合并/归档", () => {
  const cfg = smallConfig();
  let store = emptyStore();
  for (let i = 0; i < 3; i++) store = saveKnowledge(store, cfg, { title: `t${i}`, content: "x" }).store;
  assert.throws(
    () => saveKnowledge(store, cfg, { title: "t3", content: "x" }),
    (e) => e instanceof BudgetError && /合并|归档/.test(e.message),
  );
  assert.equal(store.knowledge.length, 3); // store 未被修改
});

test("saveKnowledge: 字符预算满 → 拒绝", () => {
  const cfg = smallConfig();
  let store = emptyStore();
  store = saveKnowledge(store, cfg, { title: "big", content: "字".repeat(590) }).store;
  assert.throws(() => saveKnowledge(store, cfg, { title: "big2", content: "字".repeat(50) }), BudgetError);
});

test("saveHandoff: 超长拒绝；覆盖式更新", () => {
  const cfg = smallConfig({ handoff: { maxChars: 100 } });
  let store = emptyStore();
  store = saveHandoff(store, cfg, { title: "任务", content: "进行中" }).store;
  assert.equal(store.handoff.verified, false);
  store = saveHandoff(store, cfg, { title: "任务2", content: "换任务了" }).store;
  assert.equal(store.handoff.title, "任务2");
  assert.throws(() => saveHandoff(store, cfg, { title: "任务", content: "字".repeat(200) }), /过长/);
});

/* ---------------- 整合：merge / archive（来源保留，原子） ---------------- */

test("updateKnowledge merge: 多 id → 一条新记录，mergedFrom 保留来源，原子", () => {
  const cfg = smallConfig();
  let store = emptyStore();
  const e1 = saveKnowledge(store, cfg, { title: "旧A", content: "内容A" });
  store = e1.store;
  const e2 = saveKnowledge(store, cfg, { title: "旧B", content: "内容B" });
  store = e2.store;
  const before = store.knowledge.length;
  const { store: next, entry } = updateKnowledge(store, cfg, {
    action: "merge",
    ids: [e1.entry.id, e2.entry.id],
    title: "合并AB",
    content: "A+B 的整合结论",
    note: "去重",
  });
  assert.equal(next.knowledge.length, before - 1);
  assert.deepEqual(entry.mergedFrom, [e1.entry.id, e2.entry.id]);
  assert.equal(entry.note, "去重");
  assert.equal(next.knowledge.find((e) => e.id === e1.entry.id), undefined);
  // 原子性：任一 id 不存在 → 抛错且 store 不变
  assert.throws(
    () => updateKnowledge(store, cfg, { action: "merge", ids: [e1.entry.id, "k-不存在"], title: "x", content: "y" }),
    /未找到/,
  );
  assert.throws(
    () => updateKnowledge(store, cfg, { action: "merge", ids: [e1.entry.id, e2.entry.id, e1.entry.id], title: "x", content: "y" }),
    /重复/,
  );
});

test("updateKnowledge replace: 只改给定字段", () => {
  const cfg = smallConfig();
  let store = emptyStore();
  const e = saveKnowledge(store, cfg, { title: "T", content: "C", tags: ["a"] });
  store = e.store;
  const { store: next, entry } = updateKnowledge(store, cfg, { action: "replace", id: e.entry.id, content: "C2" });
  assert.equal(entry.title, "T");
  assert.deepEqual(entry.tags, ["a"]);
  assert.equal(entry.content, "C2");
  assert.equal(next.knowledge.length, 1);
});

test("archiveKnowledge: 单条 1:1 移动；多条合并为一条（来源保留）", () => {
  const cfg = smallConfig();
  let store = emptyStore();
  const e1 = saveKnowledge(store, cfg, { title: "K1", content: "旧事实1", tags: ["x"] });
  store = e1.store;
  const e2 = saveKnowledge(store, cfg, { title: "K2", content: "旧事实2", tags: ["y"] });
  store = e2.store;
  const { store: next, entry } = archiveKnowledge(store, cfg, { ids: [e1.entry.id, e2.entry.id], note: "历史决策" });
  assert.equal(next.knowledge.length, 0);
  assert.equal(next.archive.length, 1);
  assert.deepEqual(entry.mergedFrom, [e1.entry.id, e2.entry.id]);
  assert.ok(entry.content.includes("旧事实1") && entry.content.includes("旧事实2"));
  assert.equal(entry.note, "历史决策");

  // 单条移动
  const e3 = saveKnowledge(next, cfg, { title: "K3", content: "单条" });
  const { store: next2 } = archiveKnowledge(e3.store, cfg, { ids: [e3.entry.id] });
  assert.equal(next2.archive.length, 2);
  const single = next2.archive.find((a) => a.mergedFrom[0] === e3.entry.id);
  assert.equal(single.content, "单条");
});

test("archiveKnowledge: archive 满 → 拒绝，knowledge 不被修改（不自动淘汰）", () => {
  const cfg = smallConfig({ archive: { maxEntries: 1, maxChars: 100000 } });
  let store = emptyStore();
  const e1 = saveKnowledge(store, cfg, { title: "A1", content: "内容A" });
  store = e1.store;
  const e2 = saveKnowledge(store, cfg, { title: "A2", content: "内容B" });
  store = e2.store;
  store = archiveKnowledge(store, cfg, { ids: [e1.entry.id] }).store;
  assert.throws(
    () => archiveKnowledge(store, cfg, { ids: [e2.entry.id] }),
    (e) => e instanceof BudgetError && /clear archive|delete/.test(e.message),
  );
  assert.equal(store.knowledge.length, 1); // 未被移动
});

test("removeEntry / clearBucket / removeProposal", () => {
  const cfg = smallConfig();
  let store = emptyStore();
  const e = saveKnowledge(store, cfg, { title: "T", content: "C" });
  store = e.store;
  store = removeEntry(store, "knowledge", e.entry.id).store;
  assert.equal(store.knowledge.length, 0);
  assert.throws(() => removeEntry(store, "knowledge", "nope"), /未找到/);
  store = saveKnowledge(store, cfg, { title: "T2", content: "C2" }).store;
  store = clearBucket(store, "knowledge").store;
  assert.equal(store.knowledge.length, 0);
  const p = addProposal(store, cfg, { kind: "new", name: "my-skill", description: "d", content: "b" });
  store = p.store;
  store = removeProposal(store, p.proposal.id).store;
  assert.equal(store.proposals.length, 0);
});

/* ---------------- 退出兜底 ---------------- */

test("makeFallbackHandoff: 仅当无 handoff 时创建，标记未核实，截断", () => {
  const cfg = smallConfig({ handoff: { maxChars: 300 } });
  let store = emptyStore();
  const { store: s2, created } = makeFallbackHandoff(store, cfg, "帮我修一下登录页的样式问题");
  assert.equal(created, true);
  assert.equal(s2.handoff.verified, false);
  assert.equal(s2.handoff.source, "auto-fallback");
  // 已有 handoff → 绝不覆盖
  const explicit = saveHandoff(s2, cfg, { title: "显式", content: "显式交接" }).store;
  const { created: created2 } = makeFallbackHandoff(explicit, cfg, "另一条用户消息");
  assert.equal(created2, false);
  // 截断
  const { store: s3 } = makeFallbackHandoff(emptyStore(), cfg, "字".repeat(500));
  assert.ok(s3.handoff.content.length <= 300);
  assert.ok(s3.handoff.content.includes("截断"));
  // 空文本 → 不创建
  assert.equal(makeFallbackHandoff(emptyStore(), cfg, "   ").created, false);
});

test("clearHandoff: 只清 handoff 槽位；空槽位 no-op 返回原对象", () => {
  const cfg = smallConfig();
  let store = saveHandoff(emptyStore(), cfg, { title: "进行中", content: "修登录页" }).store;
  store = saveKnowledge(store, cfg, { title: "事实", content: "x" }).store;
  const cleared = clearHandoff(store).store;
  assert.equal(cleared.handoff, null);
  assert.equal(cleared.knowledge.length, 1, "不影响其它桶");
  assert.equal(clearHandoff(cleared).store, cleared, "空槽位不克隆、不落盘");
});

/* ---------------- 持久化：原子写 / 损坏备份 / 往返 ---------------- */

test("persistStore/loadStore: 往返一致；原子替换不留 tmp", async () => {
  const dir = await makeDir();
  const p = storePathFor(dir, ".pi");
  const store = saveKnowledge(emptyStore(), DEFAULT_CONFIG, { title: "T", content: "C" }).store;
  await persistStore(p, store);
  const { store: loaded, corrupted } = await loadStore(p);
  assert.equal(corrupted, false);
  assert.equal(loaded.knowledge.length, 1);
  // 二次写入（模拟更新）
  const next = saveKnowledge(loaded, DEFAULT_CONFIG, { title: "T2", content: "C2" }).store;
  await persistStore(p, next);
  const { store: loaded2 } = await loadStore(p);
  assert.equal(loaded2.knowledge.length, 2);
  const files = await readdir(dir);
  assert.equal(files.filter((f) => f.includes(".tmp-")).length, 0, "不应残留 tmp");
});

test("loadStore: 损坏 JSON → 保留原文件并拒绝",  async () => {
  const dir = await makeDir();
  const p = storePathFor(dir, ".pi");
  await mkdir(dirnameOf(p), { recursive: true });
  await writeFile(p, "{broken", "utf8");
  await assert.rejects(loadStore(p), /损坏/);
  assert.equal(await readFile(p, "utf8"), "{broken");
});

test("mutateStore: 读-改-写往返 + corrupted 透传", async () => {
  const dir = await makeDir();
  const p = storePathFor(dir, ".pi");
  const res = await mutateStore(p, (store) => saveKnowledge(store, DEFAULT_CONFIG, { title: "T", content: "C" }), DEFAULT_CONFIG);
  assert.equal(res.corrupted, false);
  assert.equal(res.entry.id.length > 0, true);
  const { store } = await loadStore(p);
  assert.equal(store.knowledge.length, 1);
});

/* ---------------- 锁 ---------------- */

test("withStoreLock: 并发读-改-写无丢失更新（进程内互斥）", async () => {
  const dir = await makeDir();
  const p = storePathFor(dir, ".pi");
  const N = 25;
  const jobs = Array.from({ length: N }, (_, i) =>
    mutateStore(p, (store) => saveKnowledge(store, DEFAULT_CONFIG, { title: `t${i}`, content: "x" }), DEFAULT_CONFIG),
  );
  await Promise.all(jobs);
  const { store } = await loadStore(p);
  assert.equal(store.knowledge.length, N, `期望 ${N} 条，实际 ${store.knowledge.length}（丢失更新）`);
});

test("withStoreLock: 跨进程锁被占用 → 等待并在持有方释放后成功", async () => {
  const dir = await makeDir();
  const p = storePathFor(dir, ".pi");
  const lockDir = `${p}.lock`;
  // 模拟另一个进程持有锁 700ms
  await mkdir(lockDir, { recursive: true });
  const timer = setTimeout(() => {
    import("node:fs/promises").then((fs) => fs.rm(lockDir, { recursive: true, force: true }));
  }, 700);
  const t0 = Date.now();
  const res = await withStoreLock(p, async () => "ok", { staleMs: 60_000, waitMs: 5000, pollMs: 50 });
  const elapsed = Date.now() - t0;
  assert.equal(res, "ok");
  assert.ok(elapsed >= 600, `应等待锁释放（实际 ${elapsed}ms）`);
  clearTimeout(timer);
});

test("withStoreLock: 过期锁（stale）被回收后获取成功", async () => {
  const dir = await makeDir();
  const p = storePathFor(dir, ".pi");
  const lockDir = `${p}.lock`;
  await mkdir(lockDir, { recursive: true });
  // 把锁的 mtime 调到 2 分钟前 → 视为过期
  const old = new Date(Date.now() - 2 * 60 * 1000);
  const { utimes } = await import("node:fs/promises");
  await utimes(lockDir, old, old);
  const res = await withStoreLock(p, async () => "ok", { staleMs: 1000, waitMs: 2000, pollMs: 50 });
  assert.equal(res, "ok");
  await stat(lockDir).then(
    () => assert.fail("锁应已释放"),
    () => {},
  );
});

test("withStoreLock: 等待超时 → 明确报错", async () => {
  const dir = await makeDir();
  const p = storePathFor(dir, ".pi");
  const lockDir = `${p}.lock`;
  await mkdir(lockDir, { recursive: true });
  await assert.rejects(
    () => withStoreLock(p, async () => "never", { staleMs: 60_000, waitMs: 300, pollMs: 50 }),
    /锁超时/,
  );
  await import("node:fs/promises").then((fs) => fs.rm(lockDir, { recursive: true, force: true }));
});

/* ---------------- 提案与 managed skills 预算 ---------------- */

test("addProposal: 数量上限；update/retire 仅限已登记 skill", () => {
  const cfg = smallConfig({ proposals: { maxPending: 1 } });
  let store = emptyStore();
  const p1 = addProposal(store, cfg, { kind: "new", name: "skill-a", description: "d", content: "b" });
  store = p1.store;
  // 提案数满 → 拒绝
  assert.throws(() => addProposal(store, cfg, { kind: "new", name: "skill-b", description: "d", content: "b" }), BudgetError);
  // 腾出名额后：update 未登记 skill → 拒绝
  store = removeProposal(store, p1.proposal.id).store;
  assert.throws(() => addProposal(store, cfg, { kind: "update", name: "skill-a", description: "d", content: "b" }), /不是本扩展已发布/);
  // 登记后 update 可以
  store = registerManagedSkill(store, cfg, { name: "skill-a", bytes: 100 }).store;
  const p2 = addProposal(store, cfg, { kind: "update", name: "skill-a", description: "d2", content: "b2" });
  assert.equal(p2.proposal.kind, "update");
  store = p2.store;
  // retire 未登记 → 拒绝；已登记 → 可以（腾出名额后验证）
  store = removeProposal(store, p2.proposal.id).store;
  assert.throws(() => addProposal(store, cfg, { kind: "retire", name: "ghost" }), /不是本扩展已发布/);
  const p3 = addProposal(store, cfg, { kind: "retire", name: "skill-a" });
  assert.equal(p3.proposal.kind, "retire");
});

test("registerManagedSkill: 数量与总字节双上限，满则拒绝", () => {
  const cfg = smallConfig({ skills: { maxManaged: 2, maxTotalBytes: 1000 } });
  let store = emptyStore();
  store = registerManagedSkill(store, cfg, { name: "a", bytes: 400 }).store;
  store = registerManagedSkill(store, cfg, { name: "b", bytes: 400 }).store;
  assert.throws(() => registerManagedSkill(store, cfg, { name: "c", bytes: 1 }), (e) => e instanceof BudgetError && /数量已满/.test(e.message));
  // 字节上限
  const store2 = registerManagedSkill(emptyStore(), cfg, { name: "big", bytes: 900 }).store;
  assert.throws(() => registerManagedSkill(store2, cfg, { name: "small", bytes: 200 }), (e) => e instanceof BudgetError && /字节/.test(e.message));
  // 更新已登记（bytes 变化）不占新名额
  const store3 = registerManagedSkill(store2, cfg, { name: "big", bytes: 100 }).store;
  assert.equal(store3.managedSkills.length, 1);
  assert.equal(store3.managedSkills[0].bytes, 100);
  // unregister
  const store4 = unregisterManagedSkill(store3, "big").store;
  assert.equal(store4.managedSkills.length, 0);
});

function dirnameOf(p) {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(0, i) : ".";
}
