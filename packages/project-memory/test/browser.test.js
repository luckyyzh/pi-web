import test from "node:test";
import assert from "node:assert/strict";
import { browseMemory, pickProposal } from "../src/browser.ts";

function store(overrides = {}) {
  return { version: 1, knowledge: [], handoff: null, archive: [], proposals: [], managedSkills: [], ...overrides };
}
function uiQueue(queue) {
  const calls = [];
  return {
    calls,
    async select(title, options) {
      calls.push({ title, options });
      const next = queue.shift();
      return typeof next === "function" ? next(title, options) : next;
    },
  };
}
const knowledge = (id, title, content = "body") => ({ id, kind: "knowledge", title, content, tags: [], source: "model", verified: true, createdAt: 1, updatedAt: 1 });

test("分组后按标题打开全文，并可取消关闭", async () => {
  const data = store({ knowledge: [knowledge("k1", "标题", "第一行\n第二行")] });
  const ui = uiQueue([
    (_t, o) => o.find((x) => x.startsWith("知识")),
    (_t, o) => o.find((x) => x.includes("标题")),
    undefined,
  ]);
  assert.equal(await browseMemory(ui, async () => data), undefined);
  assert.match(ui.calls[2].title, /标题\n\nid: k1\n\n第一行\n第二行/);
});

test("正文每4000字符分页并保留换行", async () => {
  const body = "a".repeat(3990) + "\n" + "b".repeat(100);
  const data = store({ knowledge: [knowledge("long", "长文", body)] });
  const ui = uiQueue([
    (_t, o) => o[0],
    (_t, o) => o[0],
    (_t, o) => (assert.ok(o.includes("下一页")), "下一页"),
    (title) => (assert.ok(title.includes("b")), undefined),
  ]);
  await browseMemory(ui, async () => data);
  assert.equal(ui.calls[2].title.length, 4000);
});

test("列表每10条分页，重复标题仍映射正确id", async () => {
  const entries = Array.from({ length: 11 }, (_, i) => knowledge(`k${i}`, i >= 9 ? "重复" : `t${i}`));
  const data = store({ knowledge: entries });
  const ui = uiQueue([
    (_t, o) => o[0],
    (_t, o) => (assert.equal(o.filter((x) => /^\d+\./.test(x)).length, 10), "下一页"),
    (_t, o) => o.find((x) => x.includes("[k10]")),
    (title) => (assert.match(title, /id: k10/), undefined),
  ]);
  await browseMemory(ui, async () => data);
});

test("提案详情只返回id供父调用审批", async () => {
  const data = store({ proposals: [{ id: "p2", kind: "new", name: "same", description: "d", content: "full", status: "pending", createdAt: 1 }] });
  const ui = uiQueue([
    (_t, o) => o.find((x) => x.startsWith("待审批")),
    (_t, o) => o.find((x) => x.includes("[p2]")),
    (_t, o) => (assert.ok(o.includes("审批此提案")), "审批此提案"),
  ]);
  assert.equal(await browseMemory(ui, async () => data), "p2");
});

test("pickProposal重复标题按序号和id映射，取消与空列表安全", async () => {
  const data = store({ proposals: [
    { id: "p1", kind: "new", name: "same", status: "pending", createdAt: 1 },
    { id: "p2", kind: "new", name: "same", status: "pending", createdAt: 2 },
  ] });
  const ui = uiQueue([(_t, o) => o.find((x) => x.includes("[p2]"))]);
  assert.equal(await pickProposal(ui, async () => data), "p2");
  assert.equal(await pickProposal(uiQueue([undefined]), async () => data), undefined);
  const emptyUi = uiQueue(["关闭"]);
  assert.equal(await pickProposal(emptyUi, async () => store()), undefined);
  assert.match(emptyUi.calls[0].title, /没有待审批/);
});

test("选中后条目被删除会显示已不存在", async () => {
  let reads = 0;
  const present = store({ knowledge: [knowledge("gone", "会消失")] });
  const ui = uiQueue([
    (_t, o) => o[0],
    (_t, o) => o.find((x) => x.includes("gone")),
    (title) => (assert.equal(title, "已不存在"), undefined),
  ]);
  await browseMemory(ui, async () => (++reads <= 3 ? present : store()));
});
