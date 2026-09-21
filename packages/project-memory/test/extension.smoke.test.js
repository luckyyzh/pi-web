/**
 * test/extension.smoke.test.js — 扩展入口冒烟测试（jiti 加载 TS + mock ExtensionAPI）。
 * 验证：工具/命令注册、git 子目录项目根、保存/搜索/合并/归档、新会话交接注入（一次持久消息）、
 * 退出兜底、skill 提案→用户确认发布（含拒绝路径）、影子工作区禁用发布。
 * jiti 缺失时自动跳过（核心逻辑测试不依赖 jiti）。
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_CONFIG, emptyStore, registerManagedSkill } from "../src/store.ts";

// store 能力探测：registerManagedSkill 是否支持 sha256（store 侧补丁落地前后均可运行）
const probeReg = registerManagedSkill(emptyStore(), DEFAULT_CONFIG, { name: "probe", bytes: 1, sha256: "a".repeat(64) });
const supportsSha = !!probeReg.store.managedSkills[0] && probeReg.store.managedSkills[0].sha256 === "a".repeat(64);
// pi 的 agent 目录环境变量（APP_NAME=pi → PI_CODING_AGENT_DIR）；用于测试隔离，不动用户真实 home
const ENV_AGENT_DIR = "PI_CODING_AGENT_DIR";

let jitiImport;
try {
  const mod = await import("jiti");
  const createJiti = mod.createJiti ?? mod.default?.createJiti;
  if (!createJiti) throw new Error("no createJiti");
  const jiti = createJiti(import.meta.url, { interopDefault: true });
  jitiImport = (p) => jiti.import(p);
} catch (err) {
  jitiImport = null;
  console.log(`skip jiti smoke: ${err.message}`);
}

const run = jitiImport ? test : test.skip;

let agentDir;
let tmpRoot; // git 仓库根（mock git rev-parse 返回它）
let cwd; // 子目录（验证 git 子目录 → 项目根解析）

before(async () => {
  if (!jitiImport) return;
  const base = await mkdtemp(join(tmpdir(), "pm-ext-"));
  agentDir = join(base, "agent");
  await mkdir(agentDir, { recursive: true });
  tmpRoot = join(base, "repo");
  cwd = join(tmpRoot, "src", "sub");
  await mkdir(cwd, { recursive: true });
  process.env[ENV_AGENT_DIR] = agentDir; // 隔离配置目录（不动用户真实 home）
});

function makeMockPi(projectRoot) {
  const tools = new Map();
  const commands = new Map();
  const handlers = new Map();
  const messages = [];
  return {
    tools,
    commands,
    handlers,
    messages,
    on: (event, fn) => {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(fn);
    },
    registerTool: (def) => void tools.set(def.name, def),
    registerCommand: (name, def) => void commands.set(name, def),
    sendMessage: (msg) => void messages.push(msg),
    exec: async (cmd, args) => {
      if (cmd === "git" && args[0] === "rev-parse") return { code: 0, stdout: `${projectRoot}\n`, stderr: "" };
      return { code: 1, stdout: "", stderr: "unknown" };
    },
    getActiveTools: () => [],
    setActiveTools: () => {},
    getAllTools: () => [],
  };
}

function makeCtx(overrides = {}) {
  const notifications = [];
  const widgets = [];
  return {
    cwd: overrides.cwd ?? cwd,
    mode: "tui",
    hasUI: overrides.hasUI ?? true,
    isProjectTrusted: () => overrides.trusted ?? true,
    sessionManager: { getEntries: () => overrides.entries ?? [], getSessionFile: () => null },
    ui: {
      notify: (text, level) => notifications.push({ text, level }),
      confirm: async (...args) => {
        const c = overrides.confirm;
        if (typeof c === "function") return c(...args); // 支持 mock 回调（如审批期间并发改写）
        return c ?? false;
      },
      select: async () => undefined,
      input: async () => undefined,
      setStatus: () => {},
      setWidget: (id, lines) => widgets.push(lines),
    },
    signal: undefined,
    _notifications: notifications,
    _widgets: widgets,
  };
}

function fire(pi, event, payload, ctx) {
  const fns = pi.handlers.get(event) ?? [];
  return Promise.all(fns.map((fn) => fn(payload, ctx)));
}

run("扩展冒烟：注册、存储、交接、审批、影子禁用", async (t) => {
  const { default: factory } = await jitiImport("../extensions/index.ts");
  const pi = makeMockPi(tmpRoot);
  factory(pi);

  await t.test("注册 6 个工具 + /memory 命令 + 生命周期 handler", () => {
    assert.deepEqual(
      [...pi.tools.keys()].sort(),
      ["project_memory_archive", "project_memory_propose_skill", "project_memory_save", "project_memory_search", "project_memory_update", "project_memory_recall"].sort(),
    );
    assert.ok(pi.commands.has("memory"));
    for (const ev of ["session_start", "session_compact", "session_shutdown"]) assert.ok(pi.handlers.has(ev));
    // 工具描述必须包含显式使用指引（里程碑/检索/满容量）
    const save = pi.tools.get("project_memory_save");
    assert.match(save.description, /milestone/);
    assert.match(save.promptGuidelines.join("\n"), /budget full/);
    assert.match(save.promptGuidelines.join("\n"), /NOT consolidation/);
  });

  const storeFile = join(tmpRoot, ".pi", "project-memory", "store.json");
  let handoffSaved;

  await t.test("session_start（startup，无 previousSessionFile）+ save/search（git 子目录 → 项目根）", async () => {
    const ctx = makeCtx();
    await fire(pi, "session_start", { reason: "startup", previousSessionFile: undefined }, ctx);
    // 空库 → 不注入交接消息
    assert.equal(pi.messages.length, 0);

    const saveTool = pi.tools.get("project_memory_save");
    const r1 = await saveTool.execute("t1", { kind: "knowledge", title: "构建命令", content: "npm test 跑全部测试", tags: ["ci"] }, undefined, undefined, ctx);
    assert.match(r1.content[0].text, /已保存项目知识/);
    assert.ok(r1.details.id);

    // 项目根解析到 git 根（而非子目录 cwd）
    const onDisk = JSON.parse(await readFile(storeFile, "utf8"));
    assert.equal(onDisk.knowledge.length, 1);
    const r2 = await pi.tools.get("project_memory_search").execute("t2", { query: "构建" }, undefined, undefined, ctx);
    assert.match(r2.content[0].text, /k-/);
    assert.match(r2.content[0].text, /npm test/);

    handoffSaved = await saveTool.execute("t3", { kind: "handoff", title: "登录页重构进行中", content: "已完成 token 替换，剩下暗色模式。" }, undefined, undefined, ctx);
    assert.match(handoffSaved.content[0].text, /已更新工作交接/);
  });

  await t.test("错误 kind → 抛错（isError 语义），会话不中断", async () => {
    const ctx = makeCtx();
    await assert.rejects(
      () => pi.tools.get("project_memory_save").execute("t4", { kind: "bogus", title: "x", content: "y" }, undefined, undefined, ctx),
      /kind 必须是/,
    );
  });

  await t.test("新会话（/new）注入一条持久交接消息；resume 不重复注入", async () => {
    const ctxNew = makeCtx();
    await fire(pi, "session_start", { reason: "new", previousSessionFile: join(tmpRoot, "old.jsonl") }, ctxNew);
    assert.equal(pi.messages.length, 1, "应恰好注入一条交接消息");
    const msg = pi.messages[0];
    assert.equal(msg.customType, "project-memory-handoff");
    assert.match(String(msg.content), /登录页重构进行中/);
    assert.equal(msg.display, true);

    const ctxResume = makeCtx();
    await fire(pi, "session_start", { reason: "resume", previousSessionFile: join(tmpRoot, "s.jsonl") }, ctxResume);
    assert.equal(pi.messages.length, 1, "resume 不应重复注入");
  });

  await t.test("merge 与 archive：来源保留；archive 内容含来源全文", async () => {
    const ctx = makeCtx();
    const saveTool = pi.tools.get("project_memory_save");
    const a = await saveTool.execute("t5", { kind: "knowledge", title: "旧决策A", content: "用 pnpm 而不是 npm" }, undefined, undefined, ctx);
    const b = await saveTool.execute("t6", { kind: "knowledge", title: "旧决策B", content: "CI 用 Node 22" }, undefined, undefined, ctx);
    const idA = a.details.id;
    const idB = b.details.id;
    const m = await pi.tools.get("project_memory_update").execute("t7", { action: "merge", ids: [idA, idB], title: "包管理决策", content: "pnpm + Node 22 CI" }, undefined, undefined, ctx);
    assert.match(m.content[0].text, /来源保留/);
    const arch = await pi.tools.get("project_memory_archive").execute("t8", { ids: [m.details.id], note: "历史" }, undefined, undefined, ctx);
    assert.match(arch.content[0].text, /已归档/);
    const onDisk = JSON.parse(await readFile(storeFile, "utf8"));
    // 仅剩最初那条「构建命令」（合并后的条目已归档）
    assert.equal(onDisk.knowledge.length, 1);
    assert.match(onDisk.knowledge[0].title, /构建命令/);
    assert.equal(onDisk.archive.length, 1);
    assert.deepEqual([...onDisk.archive[0].mergedFrom].sort(), [m.details.id, idA, idB].sort());
  });

  await t.test("session_shutdown(quit)：已有显式 handoff → 不覆盖", async () => {
    const ctx = makeCtx({ entries: [{ type: "message", message: { role: "user", content: "帮我修登录页" } }] });
    await fire(pi, "session_shutdown", { reason: "quit" }, ctx);
    const onDisk = JSON.parse(await readFile(storeFile, "utf8"));
    // store 侧 verified 默认已改为 false（显式保存亦为 false）
    assert.equal(onDisk.handoff.verified, false);
    assert.equal(onDisk.handoff.source, "model");
    assert.match(onDisk.handoff.title, /登录页重构进行中/);
  });

  await t.test("session_shutdown(quit)：无 handoff → 写原始未核实兜底（bounded）", async () => {
    const root2 = join(tmpRoot, "second-project");
    await mkdir(root2, { recursive: true });
    const pi2 = makeMockPi(root2);
    factory(pi2);
    const ctx = makeCtx({
      cwd: root2,
      entries: [
        { type: "message", message: { role: "user", content: "帮我修一下登录页的样式" } },
        { type: "message", message: { role: "assistant", content: "好的" } },
      ],
    });
    await fire(pi2, "session_start", { reason: "startup" }, ctx);
    await fire(pi2, "session_shutdown", { reason: "quit" }, ctx);
    const onDisk = JSON.parse(await readFile(join(root2, ".pi", "project-memory", "store.json"), "utf8"));
    assert.equal(onDisk.handoff.verified, false);
    assert.equal(onDisk.handoff.source, "auto-fallback");
    assert.match(onDisk.handoff.content, /帮我修一下登录页的样式/);
  });

  await t.test("skill 提案 → 用户确认发布（SKILL.md 落盘、清单登记、提案移除）", async () => {
    const ctx = makeCtx();
    const p = await pi.tools.get("project_memory_propose_skill").execute(
      "t9",
      { action: "new", name: "demo-skill", description: "演示 skill", content: "# Demo\n\n步骤" },
      undefined,
      undefined,
      ctx,
    );
    assert.match(p.content[0].text, /提案/);
    const pid = p.details.proposal.id;

    // 提案阶段：磁盘上不应出现 skill 文件
    const skillFile = join(tmpRoot, ".pi", "skills", "demo-skill", "SKILL.md");
    const notYet = await readFile(skillFile, "utf8").then(
      () => "exists",
      () => "absent",
    );
    assert.equal(notYet, "absent", "审批前不得落盘");

    // 用户确认发布
    const ctxApprove = makeCtx({ confirm: true });
    await pi.commands.get("memory").handler(`approve ${pid}`, ctxApprove);
    const md = await readFile(skillFile, "utf8");
    assert.match(md, /^---\nname: demo-skill\ndescription: "演示 skill"\n---/);
    const onDisk = JSON.parse(await readFile(storeFile, "utf8"));
    assert.equal(onDisk.proposals.length, 0);
    assert.equal(onDisk.managedSkills.length, 1);
    assert.equal(onDisk.managedSkills[0].name, "demo-skill");
  });

  await t.test("approve 拒绝（confirm=false）→ 提案保留、不落盘", async () => {
    const ctx = makeCtx();
    const p = await pi.tools.get("project_memory_propose_skill").execute(
      "t10",
      { action: "new", name: "another-skill", description: "另一个", content: "正文" },
      undefined,
      undefined,
      ctx,
    );
    const pid = p.details.proposal.id;
    const ctxReject = makeCtx({ confirm: false });
    await pi.commands.get("memory").handler(`approve ${pid}`, ctxReject);
    const onDisk = JSON.parse(await readFile(storeFile, "utf8"));
    assert.equal(onDisk.proposals.length, 1, "拒绝后提案应保留");
    assert.equal(
      await readFile(join(tmpRoot, ".pi", "skills", "another-skill", "SKILL.md"), "utf8").then(() => "exists", () => "absent"),
      "absent",
    );
  });

  await t.test("无 UI 时 approve → 拒绝（不发布）", async () => {
    const ctx = makeCtx();
    const p = await pi.tools.get("project_memory_propose_skill").execute(
      "t11",
      { action: "new", name: "no-ui-skill", description: "x", content: "y" },
      undefined,
      undefined,
      ctx,
    );
    const pid = p.details.proposal.id;
    const ctxNoUi = makeCtx({ hasUI: false, confirm: true });
    await pi.commands.get("memory").handler(`approve ${pid}`, ctxNoUi);
    const onDisk = JSON.parse(await readFile(storeFile, "utf8"));
    assert.ok(onDisk.proposals.some((p) => p.id === pid), "无 UI 时该提案应保留（拒绝审批）");
    assert.equal(
      await readFile(join(tmpRoot, ".pi", "skills", "no-ui-skill", "SKILL.md"), "utf8").then(() => "exists", () => "absent"),
      "absent",
    );
  });

  await t.test("retire 提案：未登记 skill 不可提案", async () => {
    const ctx = makeCtx();
    await assert.rejects(
      () => pi.tools.get("project_memory_propose_skill").execute("t12", { action: "retire", name: "ghost-skill" }, undefined, undefined, ctx),
      /不是本扩展已发布/,
    );
  });

  const itHash = (name, fn) => t.test(name, { skip: supportsSha ? false : "待 store sha256 支持" }, fn);

  await itHash("retire：审批后删除 SKILL.md 并移出清单", async () => {
    const ctx = makeCtx();
    const p = await pi.tools.get("project_memory_propose_skill").execute("t13", { action: "retire", name: "demo-skill" }, undefined, undefined, ctx);
    const pid = p.details.proposal.id;
    const ctxApprove = makeCtx({ confirm: true });
    await pi.commands.get("memory").handler(`approve ${pid}`, ctxApprove);
    const skillFile = join(tmpRoot, ".pi", "skills", "demo-skill", "SKILL.md");
    assert.equal(await readFile(skillFile, "utf8").then(() => "exists", () => "absent"), "absent");
    const onDisk = JSON.parse(await readFile(storeFile, "utf8"));
    assert.equal(onDisk.managedSkills.length, 0);
  });

  await t.test("approve new：磁盘已存在非 managed skill → 绝不覆盖（文件原样、提案保留）", async () => {
    const foreign = join(tmpRoot, ".pi", "skills", "collide-skill", "SKILL.md");
    await mkdir(dirname(foreign), { recursive: true });
    const foreignContent = "---\nname: collide-skill\ndescription: 外部手写\n---\n\n外部内容\n";
    await writeFile(foreign, foreignContent, "utf8");
    const ctx = makeCtx();
    const p = await pi.tools.get("project_memory_propose_skill").execute("c1", { action: "new", name: "collide-skill", description: "d", content: "b" }, undefined, undefined, ctx);
    const pid = p.details.proposal.id;
    await pi.commands.get("memory").handler(`approve ${pid}`, makeCtx({ confirm: true }));
    const onDisk = JSON.parse(await readFile(storeFile, "utf8"));
    assert.ok(onDisk.proposals.some((x) => x.id === pid), "提案应保留");
    assert.equal(await readFile(foreign, "utf8"), foreignContent, "外部文件内容必须原样保留");
  });

  await t.test("审批期间提案被并发修改 → 拒绝，不落盘", async () => {
    const ctx = makeCtx();
    const p = await pi.tools.get("project_memory_propose_skill").execute("c2", { action: "new", name: "mutate-skill", description: "d", content: "b" }, undefined, undefined, ctx);
    const pid = p.details.proposal.id;
    const ctxMut = makeCtx({
      confirm: async () => {
        const raw = JSON.parse(await readFile(storeFile, "utf8"));
        const prop = raw.proposals.find((x) => x.id === pid);
        prop.content = "被并发改写";
        await writeFile(storeFile, JSON.stringify(raw, null, 2) + "\n", "utf8");
        return true;
      },
    });
    await pi.commands.get("memory").handler(`approve ${pid}`, ctxMut);
    const target = join(tmpRoot, ".pi", "skills", "mutate-skill", "SKILL.md");
    assert.equal(await readFile(target, "utf8").then(() => "exists", () => "absent"), "absent", "提案不一致时不得落盘");
  });

  await t.test("审批期间预算被并发占满 → 拒绝，不落盘", async () => {
    const raw0 = JSON.parse(await readFile(storeFile, "utf8"));
    const maxManaged = 20;
    while (raw0.managedSkills.length < maxManaged) {
      raw0.managedSkills.push({ name: `filler-${raw0.managedSkills.length}`, bytes: 1, publishedAt: Date.now() });
    }
    await writeFile(storeFile, JSON.stringify(raw0, null, 2) + "\n", "utf8");
    const ctx = makeCtx();
    const p = await pi.tools.get("project_memory_propose_skill").execute("c3", { action: "new", name: "budget-skill", description: "d", content: "b" }, undefined, undefined, ctx);
    const pid = p.details.proposal.id;
    await pi.commands.get("memory").handler(`approve ${pid}`, makeCtx({ confirm: true }));
    const target = join(tmpRoot, ".pi", "skills", "budget-skill", "SKILL.md");
    assert.equal(await readFile(target, "utf8").then(() => "exists", () => "absent"), "absent", "预算满时不得发布");
    // 恢复：清理 filler，避免影响后续测试
    const raw1 = JSON.parse(await readFile(storeFile, "utf8"));
    raw1.managedSkills = raw1.managedSkills.filter((m) => !m.name.startsWith("filler-"));
    await writeFile(storeFile, JSON.stringify(raw1, null, 2) + "\n", "utf8");
  });

  await t.test("retire：文件已被外部删除 → 仅清理 managed 记录", async () => {
    const ctx = makeCtx();
    const raw = JSON.parse(await readFile(storeFile, "utf8"));
    raw.managedSkills.push({ name: "ghost-clean", bytes: 10, publishedAt: Date.now() });
    await writeFile(storeFile, JSON.stringify(raw, null, 2) + "\n", "utf8");
    const p = await pi.tools.get("project_memory_propose_skill").execute("c4", { action: "retire", name: "ghost-clean" }, undefined, undefined, ctx);
    const pid = p.details.proposal.id;
    await pi.commands.get("memory").handler(`approve ${pid}`, makeCtx({ confirm: true }));
    const onDisk = JSON.parse(await readFile(storeFile, "utf8"));
    assert.equal(onDisk.managedSkills.some((m) => m.name === "ghost-clean"), false, "记录应被清理");
    assert.equal(onDisk.proposals.some((x) => x.id === pid), false, "提案应被移除");
  });

  await itHash("update：磁盘文件被手改（hash 不符）→ 拒绝且不动文件", async () => {
    const ctx = makeCtx();
    const p = await pi.tools.get("project_memory_propose_skill").execute("c5", { action: "new", name: "upd-skill", description: "d", content: "b" }, undefined, undefined, ctx);
    await pi.commands.get("memory").handler(`approve ${p.details.proposal.id}`, makeCtx({ confirm: true }));
    const target = join(tmpRoot, ".pi", "skills", "upd-skill", "SKILL.md");
    const orig = await readFile(target, "utf8");
    await writeFile(target, orig + "\n手改一行\n", "utf8"); // 外部手改
    const pu = await pi.tools.get("project_memory_propose_skill").execute("c6", { action: "update", name: "upd-skill", description: "d2", content: "b2" }, undefined, undefined, ctx);
    await pi.commands.get("memory").handler(`approve ${pu.details.proposal.id}`, makeCtx({ confirm: true }));
    assert.equal(await readFile(target, "utf8"), orig + "\n手改一行\n", "手改内容必须保留");
    const onDisk = JSON.parse(await readFile(storeFile, "utf8"));
    assert.ok(onDisk.proposals.some((x) => x.id === pu.details.proposal.id), "提案保留");
  });

  await t.test("/memory status：显示预算用量（widget）", async () => {
    const ctx = makeCtx();
    await pi.commands.get("memory").handler("status", ctx);
    const last = ctx._widgets.at(-1);
    assert.ok(Array.isArray(last) && last.length > 0);
    assert.match(last.join("\n"), /knowledge:/);
    assert.match(last.join("\n"), /archive:/);
  });
});

run("扩展冒烟：影子工作区禁用 skill 发布（记忆仍可用）", async () => {
  const { default: factory } = await jitiImport("../extensions/index.ts");
  const shadowCwd = join(agentDir, "..", "remote", "host_abc123", "work");
  await mkdir(shadowCwd, { recursive: true });
  const pi = makeMockPi(shadowCwd);
  factory(pi);
  const ctx = makeCtx({ cwd: shadowCwd });
  await fire(pi, "session_start", { reason: "startup" }, ctx);

  // 知识保存仍可用（数据落在影子目录本地）
  const r = await pi.tools.get("project_memory_save").execute("s1", { kind: "knowledge", title: "T", content: "C" }, undefined, undefined, ctx);
  assert.match(r.content[0].text, /已保存/);

  // skill 发布被禁用
  await assert.rejects(
    () => pi.tools.get("project_memory_propose_skill").execute("s2", { action: "new", name: "x-skill", description: "d", content: "b" }, undefined, undefined, ctx),
    /影子工作区/,
  );
});

run("扩展冒烟：enabled:false 配置关闭全部功能", async () => {
  const { default: factory } = await jitiImport("../extensions/index.ts");
  await writeFile(join(agentDir, "project-memory.json"), JSON.stringify({ enabled: false }), "utf8");
  try {
    const root3 = await mkdtemp(join(tmpdir(), "pm-off-"));
    const pi = makeMockPi(root3);
    factory(pi);
    const ctx = makeCtx({ cwd: root3 });
    await fire(pi, "session_start", { reason: "startup" }, ctx);
    await assert.rejects(
      () => pi.tools.get("project_memory_save").execute("o1", { kind: "knowledge", title: "T", content: "C" }, undefined, undefined, ctx),
      /未启用/,
    );
  } finally {
    await rm(join(agentDir, "project-memory.json"), { force: true });
  }
});
