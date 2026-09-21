import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_CHECKPOINTS,
  MAX_CHECKPOINT_CHARS,
  checkpointFile,
  finishCheckpoint,
  loadCheckpoints,
  readCheckpointSource,
  saveCheckpoint,
} from "../src/checkpoints.ts";

async function fixture(entries) {
  const base = await mkdtemp(join(tmpdir(), "pm-checkpoints-"));
  const root = join(base, "project");
  const other = join(base, "other-project");
  await mkdir(root);
  await mkdir(other);
  const file = join(base, "pi-session.jsonl");
  const header = { type: "session", id: "session-real-1", cwd: root };
  const serialize = (h = header) => [h, ...entries].map(x => JSON.stringify(x)).join("\n") + "\n";
  await writeFile(file, serialize());
  return { base, root, other, file, header, serialize };
}

const message = (id, parentId, role, content, extra = {}) => ({
  type: "message", id, parentId, message: { role, content, ...extra },
});

test("save/read 定位压缩前分支，检索早期要求并按 entryId 分页读取 toolResult", async () => {
  const longToolResult = "TOOL-BEGIN:" + "结果数据".repeat(3500) + ":TOOL-END";
  const entries = [
    message("u1", null, "user", "早期用户要求：只修改检查点测试，关键词-北极星"),
    message("a1", "u1", "assistant", "准备调用工具"),
    message("tool1", "a1", "toolResult", longToolResult, { toolName: "read" }),
    message("other", "u1", "assistant", "另一分支的秘密内容"),
  ];
  const f = await fixture(entries);
  try {
    const cp = await saveCheckpoint(f.root, f.file, "tool1", "即将压缩");
    assert.equal(cp.leafId, "tool1");
    assert.match(cp.excerpt, /TOOL-BEGIN/);
    assert.match(cp.excerpt, /\[已截断\]$/);
    assert.doesNotMatch(cp.excerpt, /另一分支/);

    const search = await readCheckpointSource(f.root, cp.id, { query: "关键词-北极星" });
    assert.equal(search.total, 1);
    assert.equal(search.matches[0].entryId, "u1");

    const first = await readCheckpointSource(f.root, cp.id, { entryId: "tool1" });
    assert.equal(first.content.length, 8000);
    assert.equal(first.nextOffset, 8000);
    assert.equal(first.totalChars, longToolResult.length);
    const second = await readCheckpointSource(f.root, cp.id, { entryId: "tool1", offset: first.nextOffset });
    assert.equal(first.content + second.content, longToolResult);
    assert.equal(second.nextOffset, null);

    await assert.rejects(
      readCheckpointSource(f.root, cp.id, { entryId: "other" }),
      /不属于检查点分支/,
    );
  } finally {
    await rm(f.base, { recursive: true, force: true });
  }
});

test("read 拒绝被替换的 session header、其他项目 cwd 和缺失 source", async () => {
  const entries = [message("u1", null, "user", "原始要求")];
  const f = await fixture(entries);
  try {
    const cp = await saveCheckpoint(f.root, f.file, "u1", "identity");

    await writeFile(f.file, f.serialize({ ...f.header, id: "substituted-session" }));
    await assert.rejects(readCheckpointSource(f.root, cp.id), /身份发生变化/);

    await writeFile(f.file, f.serialize({ ...f.header, cwd: f.other }));
    await assert.rejects(readCheckpointSource(f.root, cp.id), /拒绝读取其他项目/);

    await rm(f.file);
    await assert.rejects(readCheckpointSource(f.root, cp.id), /ENOENT|no such file/i);
  } finally {
    await rm(f.base, { recursive: true, force: true });
  }
});

test("最多滚动保留 8 个 checkpoint，且绝不改写原始 JSONL", async () => {
  const entries = [];
  let parentId = null;
  for (let i = 0; i < MAX_CHECKPOINTS + 1; i++) {
    const id = `m${i}`;
    entries.push(message(id, parentId, "user", `request ${i}`));
    parentId = id;
  }
  const f = await fixture(entries);
  try {
    const original = await readFile(f.file);
    const made = [];
    for (const entry of entries) made.push(await saveCheckpoint(f.root, f.file, entry.id, `cp ${entry.id}`));
    const rows = await loadCheckpoints(f.root);
    assert.equal(rows.length, MAX_CHECKPOINTS);
    assert.equal(rows.some(x => x.id === made[0].id), false);
    assert.deepEqual(await readFile(f.file), original);
  } finally {
    await rm(f.base, { recursive: true, force: true });
  }
});

test("excerpt/summary 有硬上限，损坏 ledger 时拒绝覆盖原文件", async () => {
  const entries = [];
  let parentId = null;
  for (let i = 0; i < 12; i++) {
    const id = `long${i}`;
    entries.push(message(id, parentId, "user", `${i}:` + "长文本".repeat(2000)));
    parentId = id;
  }
  const f = await fixture(entries);
  try {
    const cp = await saveCheckpoint(f.root, f.file, parentId, "limits");
    assert.ok(cp.excerpt.length <= MAX_CHECKPOINT_CHARS);
    await finishCheckpoint(f.root, cp.id, "摘要".repeat(MAX_CHECKPOINT_CHARS));
    const [finished] = await loadCheckpoints(f.root);
    assert.ok(finished.summary.length <= MAX_CHECKPOINT_CHARS);
    assert.match(finished.summary, /\[已截断\]$/);

    const ledger = checkpointFile(f.root);
    const damaged = JSON.stringify({
      version: 1,
      checkpoints: [{ ...finished, excerpt: "x".repeat(MAX_CHECKPOINT_CHARS + 1) }],
    });
    await writeFile(ledger, damaged);
    await assert.rejects(
      saveCheckpoint(f.root, f.file, parentId, "must not overwrite"),
      /格式损坏，保留原文件并拒绝覆盖/,
    );
    assert.equal(await readFile(ledger, "utf8"), damaged);
  } finally {
    await rm(f.base, { recursive: true, force: true });
  }
});
