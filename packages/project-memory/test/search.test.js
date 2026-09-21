/**
 * test/search.test.js — 中文/英文混合搜索行为。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { searchEntries, scoreEntry, snippetAround, tokenizeQuery, cjkGrams } from "../src/search.ts";

const entries = [
  { id: "k-1", title: "数据库连接池配置", content: "项目使用 pg-boss 做任务队列，连接池大小 20，超时 30s。", tags: ["数据库", "配置"] },
  { id: "k-2", title: "构建命令", content: "npm run build 走 webpack；CI 需要 Node 22。", tags: ["ci", "build"] },
  { id: "k-3", title: "环境变量约定", content: "API key 放在 .env.local，禁止提交。", tags: ["env"] },
  { id: "k-4", title: "Login Page Styles", content: "The login page uses tailwind tokens; dark mode via class strategy.", tags: ["ui"] },
];

test("tokenizeQuery: 中英混杂词拆分", () => {
  const terms = tokenizeQuery("连接池 v2 API");
  const kinds = terms.map((t) => t.kind).sort();
  assert.deepEqual(kinds, ["cjk", "latin", "latin"]);
  const cjk = terms.find((t) => t.kind === "cjk");
  assert.equal(cjk.text, "连接池");
  assert.deepEqual([...cjk.grams].sort(), ["接池", "连接"]);
  // 单字 CJK 退化为单字 gram
  const single = tokenizeQuery("池");
  assert.deepEqual(single[0].grams, ["池"]);
});

test("中文整短语命中 → 高分且排第一", () => {
  const r = searchEntries(entries, "连接池", { limit: 8 });
  assert.ok(r.length >= 1);
  assert.equal(r[0].entry.id, "k-1");
  assert.ok(r[0].score >= 8);
});

test("中文部分命中（bigram）→ 有分但低于整短语", () => {
  // "数据库超时"：内容含 数据库（标题）与 超时（内容），但整短语不连续
  const r = searchEntries(entries, "数据库超时", { limit: 8 });
  assert.ok(r.some((x) => x.entry.id === "k-1"));
  // 纯 bigram 场景：查询「据连」在正文不连续出现 → bigram 命中给部分分
  const full = scoreEntry(entries[0], tokenizeQuery("数据库连接池")).score;
  const partial = scoreEntry(entries[0], tokenizeQuery("据连超时")).score;
  assert.ok(full > partial, `整短语(${full}) 应高于 bigram 部分命中(${partial})`);
  assert.ok(partial > 0);
});

test("无关查询 → 空结果", () => {
  assert.deepEqual(searchEntries(entries, "量子纠缠"), []);
  assert.deepEqual(searchEntries(entries, ""), []);
});

test("英文大小写不敏感；标题权重更高", () => {
  const r = searchEntries(entries, "login page", { limit: 8 });
  assert.equal(r[0].entry.id, "k-4");
  // 标题命中分 > 仅正文命中分
  const titleHit = scoreEntry({ title: "build", content: "irrelevant" }, tokenizeQuery("build")).score;
  const contentHit = scoreEntry({ title: "irrelevant", content: "about build" }, tokenizeQuery("build")).score;
  assert.ok(titleHit > contentHit);
});

test("tags 参与匹配", () => {
  const r = searchEntries(entries, "env", { limit: 8 });
  assert.ok(r.some((x) => x.entry.id === "k-3" && x.matchedIn.includes("tags")));
});

test("limit 生效且按分数降序", () => {
  const all = searchEntries(entries, "build", { limit: 1 });
  assert.equal(all.length, 1);
  const many = searchEntries([...entries, ...entries.map((e, i) => ({ ...e, id: `x${i}` }))], "build", { limit: 3 });
  assert.ok(many.length <= 3);
  for (let i = 1; i < many.length; i++) assert.ok(many[i - 1].score >= many[i].score);
});

test("snippetAround: 命中处截取并带省略号", () => {
  const s = snippetAround("aaaaaaaaaaaaaaaaaaaa连接池bbbbbbbbbbbbbbbbbbbb", "连接池", { width: 20 });
  assert.ok(s.includes("连接池"));
  assert.ok(s.startsWith("…") && s.endsWith("…"));
  const noHit = snippetAround("no match here", "xyz", { width: 5 });
  assert.equal(noHit, "no ma");
});

test("cjkGrams: 长 run 生成连续 bigram", () => {
  assert.deepEqual([...cjkGrams("数据库")].sort(), ["据库", "数据"]);
});
