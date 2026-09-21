/**
 * test/skills.test.js — skill 名称校验、SKILL.md 构建、安全发布（穿越/符号链接/覆盖）。
 */
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile, lstat, stat, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { relative, resolve } from "node:path";
import { assertPublishPathSafe, buildSkillMd, publishSkill, resolveSkillPaths, sha256Hex, validateSkillName } from "../src/skills.ts";
import { isShadowWorkspacePath, remoteRootFor } from "../src/workspace.ts";

async function makeDir() {
  return mkdtemp(join(tmpdir(), "pm-skills-"));
}

const MD = buildSkillMd({ name: "demo-skill", description: "演示 skill", body: "# Demo\n\n步骤 1" });

test("validateSkillName: 合法/非法边界", () => {
  assert.equal(validateSkillName("ok-name"), null);
  assert.equal(validateSkillName("a"), null);
  assert.equal(validateSkillName("pdf2"), null);
  assert.equal(validateSkillName(".."), "name 只能包含小写字母/数字/连字符，不能以连字符开头或结尾，不能连续连字符");
  assert.match(validateSkillName("../evil") ?? "", /只能包含/);
  assert.match(validateSkillName("/abs/path") ?? "", /只能包含/);
  assert.match(validateSkillName("a--b") ?? "", /只能包含/);
  assert.match(validateSkillName("-a") ?? "", /只能包含/);
  assert.match(validateSkillName("a-") ?? "", /只能包含/);
  assert.match(validateSkillName("UPPER") ?? "", /只能包含/);
  assert.match(validateSkillName("a b") ?? "", /只能包含/);
  assert.match(validateSkillName("中".repeat(10)) ?? "", /只能包含/);
  assert.match(validateSkillName("a".repeat(65)) ?? "", /长度/);
  assert.equal(validateSkillName("a".repeat(64)), null);
  assert.match(validateSkillName(123) ?? "", /字符串/);
});

test("resolveSkillPaths: 落在 skillsRoot 内", () => {
  const root = makeDirSyncish();
  const { dir, file } = resolveSkillPaths(root, "my-skill");
  assert.equal(dir, join(root, "my-skill"));
  assert.equal(file, join(root, "my-skill", "SKILL.md"));
  assert.throws(() => resolveSkillPaths(root, "../evil"), /只能包含|越界/);
});

function makeDirSyncish() {
  // 用 os.tmpdir 下的固定子目录做纯路径断言（不写盘）
  return join(tmpdir(), "pm-path-check", "skills");
}

test("buildSkillMd: frontmatter 形状；description 用 JSON 引号包裹（防冒号/#/引号破坏 YAML）", () => {
  const md = buildSkillMd({ name: "x-skill", description: "line1\nline2", body: "body" });
  assert.ok(md.startsWith('---\nname: x-skill\ndescription: "line1 line2"\n---\n\nbody\n'));
  const colon = buildSkillMd({ name: "x-skill", description: "use: when #tag needed \"quoted\"", body: "b" });
  assert.ok(colon.includes('description: "use: when #tag needed \\"quoted\\""'));
  const long = buildSkillMd({ name: "x-skill", description: "字".repeat(2000), body: "b" });
  const descLine = long.split("\n")[2];
  assert.ok(descLine.length <= "description: ".length + 1024 + 2);
  assert.throws(() => buildSkillMd({ name: "x-skill", description: "  ", body: "b" }), /description/);
});

test("sha256Hex: 确定性", () => {
  assert.equal(sha256Hex("abc"), sha256Hex("abc"));
  assert.notEqual(sha256Hex("abc"), sha256Hex("abd"));
  assert.match(sha256Hex("abc"), /^[0-9a-f]{64}$/);
});

test("assertPublishPathSafe: 真实路径链通过；符号链接/目录联接（junction）拒绝", async (t) => {
  const root = await makeDir();
  const skillsRoot = join(root, ".pi", "skills");
  await mkdir(skillsRoot, { recursive: true });
  const good = await assertPublishPathSafe(skillsRoot, "ok-skill", root);
  assert.equal(good.file, join(skillsRoot, "ok-skill", "SKILL.md"));
  // name 目录为符号链接（或 Windows junction）→ 拒绝（retire 的 rm 与 publish 的写共用该校验）
  const outside = join(root, "outside");
  await mkdir(outside, { recursive: true });
  let created = false;
  try {
    await symlink(outside, join(skillsRoot, "evil"), "dir");
    created = true;
  } catch {
    // Windows 无开发者模式时 symlink 不可用 → 退回 junction（NTFS 无需特权）
    if (process.platform === "win32") {
      try {
        execFileSync("cmd", ["/c", "mklink", "/J", join(skillsRoot, "evil"), outside], { stdio: "ignore" });
        created = true;
      } catch {
        created = false;
      }
    }
  }
  if (!created) {
    t.skip("当前环境无法创建符号链接/junction");
    await rm(root, { recursive: true, force: true });
    return;
  }
  await assert.rejects(() => assertPublishPathSafe(skillsRoot, "evil", root), /符号链接|realpath/);
  // 逃逸目标未被触碰
  const files = await (await import("node:fs/promises")).readdir(outside);
  assert.equal(files.length, 0);
  await rm(root, { recursive: true, force: true });
});

test("publishSkill: 正常发布；重复发布无 overwrite → 拒绝", async () => {
  const root = await makeDir();
  const skillsRoot = join(root, ".pi", "skills");
  const { file, bytes } = await publishSkill(skillsRoot, "demo-skill", MD);
  assert.equal(file, join(skillsRoot, "demo-skill", "SKILL.md"));
  assert.ok(bytes > 0);
  const onDisk = await readFile(file, "utf8");
  assert.equal(onDisk, MD);
  await assert.rejects(() => publishSkill(skillsRoot, "demo-skill", MD), /已存在/);
  // overwrite 成功后内容被替换
  const MD2 = buildSkillMd({ name: "demo-skill", description: "v2 描述", body: "# v2" });
  const r2 = await publishSkill(skillsRoot, "demo-skill", MD2, { overwrite: true });
  assert.equal(await readFile(r2.file, "utf8"), MD2);
  await rm(root, { recursive: true, force: true });
});

test("publishSkill: 目标目录是符号链接 → 拒绝（防逃逸）", async (t) => {
  const root = await makeDir();
  const skillsRoot = join(root, ".pi", "skills");
  const outside = join(root, "outside");
  await mkdir(outside, { recursive: true });
  const fakeDir = join(skillsRoot, "evil");
  await mkdir(skillsRoot, { recursive: true });
  let linked = false;
  try {
    await symlink(outside, fakeDir, "dir");
    linked = true;
  } catch {
    linked = false; // 无权限创建符号链接（如 Windows 未开启开发者模式）
  }
  if (linked) {
    await assert.rejects(() => publishSkill(skillsRoot, "evil", MD), /符号链接/);
    // 逃逸目标未被写入
    const files = await (await import("node:fs/promises")).readdir(outside);
    assert.equal(files.length, 0);
  } else {
    t.skip("当前环境无法创建符号链接");
  }
  await rm(root, { recursive: true, force: true });
});

test("publishSkill: skills 根是符号链接 → 拒绝", async (t) => {
  const root = await makeDir();
  const realSkills = join(root, "real-skills");
  await mkdir(realSkills, { recursive: true });
  const piDir = join(root, ".pi");
  await mkdir(piDir, { recursive: true });
  let linked = false;
  try {
    await symlink(realSkills, join(piDir, "skills"), "dir");
    linked = true;
  } catch {
    linked = false;
  }
  if (linked) {
    await assert.rejects(() => publishSkill(join(piDir, "skills"), "demo-skill", MD), /符号链接/);
  } else {
    t.skip("当前环境无法创建符号链接");
  }
  await rm(root, { recursive: true, force: true });
});

test("publishSkill: 已存在条目为符号链接（O_EXCL 竞态模拟）→ 拒绝", async (t) => {
  const root = await makeDir();
  const skillsRoot = join(root, ".pi", "skills");
  const skillDir = join(skillsRoot, "demo-skill");
  await mkdir(skillDir, { recursive: true });
  const target = join(skillDir, "SKILL.md");
  let linked = false;
  try {
    await writeFile(join(root, "payload"), "evil", "utf8");
    await symlink(join(root, "payload"), target, "file");
    linked = true;
  } catch {
    linked = false;
  }
  if (linked) {
    // 无 overwrite：先被「已存在」拒绝；有 overwrite：符号链接被拒绝而非跟随
    await assert.rejects(() => publishSkill(skillsRoot, "demo-skill", MD), /已存在/);
    await assert.rejects(() => publishSkill(skillsRoot, "demo-skill", MD, { overwrite: true }), /符号链接/);
    const st = await lstat(target);
    assert.ok(st.isSymbolicLink(), "符号链接不应被替换/跟随");
  } else {
    t.skip("当前环境无法创建符号链接");
  }
  await rm(root, { recursive: true, force: true });
});

test("publishSkill: 发布后 realpath 包含性校验通过", async () => {
  const root = await makeDir();
  const skillsRoot = join(root, ".pi", "skills");
  const { file } = await publishSkill(skillsRoot, "demo-skill", MD);
  const realRoot = await realpath(skillsRoot);
  const realFile = await realpath(file);
  const rel = relative(realRoot, realFile).toLowerCase();
  assert.ok(!rel.startsWith("..") && !rel.startsWith("\\") && !rel.startsWith("/"), `realpath 应落在 skills 根内: ${realFile}`);
  const st = await stat(file);
  assert.ok(st.isFile() && !st.isSymbolicLink());
  await rm(root, { recursive: true, force: true });
});

/* ---------------- 影子工作区检测 ---------------- */

test("isShadowWorkspacePath: 命中 ~/.pi/remote 下任意深度；相邻前缀不误伤", () => {
  const agentDir = join("/home/u", ".pi", "agent");
  const remoteRoot = remoteRootFor(agentDir);
  assert.equal(remoteRoot, resolve(join("/home/u", ".pi", "remote")));
  assert.equal(isShadowWorkspacePath(join(remoteRoot, "host_abc123"), { agentDir }), true);
  assert.equal(isShadowWorkspacePath(join(remoteRoot, "host_abc123", "src", "deep"), { agentDir }), true);
  assert.equal(isShadowWorkspacePath(remoteRoot, { agentDir }), true);
  // 普通本地项目根 → 不是影子
  assert.equal(isShadowWorkspacePath("/home/u/projects/demo", { agentDir }), false);
  // 相似前缀（/home/u/.pi-remote）→ 不是
  assert.equal(isShadowWorkspacePath(join("/home/u", ".pi-remote", "x"), { agentDir }), false);
  assert.equal(isShadowWorkspacePath(join("/home/u", "remote"), { agentDir }), false);
  assert.equal(isShadowWorkspacePath("", { agentDir }), false);
});
