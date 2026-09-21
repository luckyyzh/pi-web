/**
 * src/skills.ts — 项目级 skill 草稿校验与安全发布（纯 Node ESM，零运行时依赖，pi 无关）。
 *
 * 安全约束（v1.1，详见 README「边界与限制」）：
 * - 名称白名单正则（小写字母/数字/单连字符，1..64），从根上排除路径穿越/绝对路径/空字节。
 * - **写前/删前**校验整条路径链（skills 根、其父目录 .pi、name 目录）：非符号链接 +
 *   realpath 包含性（给定 projectRoot 时以项目根为基准）——publish 与 retire(rm) 共用，
 *   防止父路径符号链接把操作带出项目根；Windows junction 经 realpath 解析同样被拦。
 * - 文件创建使用 O_EXCL，绝不覆盖已存在条目；覆盖（审批确认后的 update）需先显式
 *   unlink 再以 O_EXCL 重建 —— 若竞态中出现任何条目（含符号链接）则失败而非跟随。
 * - 只操作本扩展登记（managedSkills）的 skill；清单之外的文件一律不触碰。
 */
import { lstat, mkdir, open, realpath, rm, stat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, join, relative, resolve } from "node:path";
import { isShadowWorkspacePath } from "./workspace.ts";

export const SKILL_DIR_NAME = "skills";
export const SKILL_FILE_NAME = "SKILL.md";
export const SKILL_NAME_RE = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9]))*$/;

/** 内容 hash（审批 TOCTOU：confirm 前后对比目标文件；发布登记用于识别手改）。 */
export function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

export function validateSkillName(name: unknown): string | null {
  if (typeof name !== "string") return "name 必须是字符串";
  if (name.length < 1 || name.length > 64) return "name 长度必须 1..64";
  if (!SKILL_NAME_RE.test(name)) {
    return "name 只能包含小写字母/数字/连字符，不能以连字符开头或结尾，不能连续连字符";
  }
  return null;
}

/** 校验并解析目标路径；返回绝对路径 { root, dir, file }，非法则抛错。 */
export function resolveSkillPaths(skillsRoot: string, name: string): { root: string; dir: string; file: string } {
  const err = validateSkillName(name);
  if (err) throw new Error(err);
  const root = resolve(skillsRoot);
  const dir = join(root, name);
  const file = join(dir, SKILL_FILE_NAME);
  const rel = relative(root, dir);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("skill 路径越界（路径穿越被拒绝）");
  return { root, dir, file };
}

/** 生成 SKILL.md 全文（frontmatter + 正文）。
 * description 用 JSON.stringify 包裹：JSON 字符串是合法的 YAML 双引号标量，
 * 防冒号 / # / 引号等字符破坏 frontmatter 解析。 */
export function buildSkillMd({ name, description, body }: { name: string; description?: string; body?: string }): string {
  const err = validateSkillName(name);
  if (err) throw new Error(err);
  const desc = String(description ?? "").replace(/\r?\n/g, " ").trim().slice(0, 1024);
  if (!desc) throw new Error("description 不能为空");
  return `---\nname: ${name}\ndescription: ${JSON.stringify(desc)}\n---\n\n${String(body ?? "").trim()}\n`;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

function localDirname(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(0, i) : ".";
}

/**
 * 发布/退休共用的**写前/删前**路径链校验：
 * skills 根、其父目录（.pi）、name 目录 —— 每一级已存在的路径必须：
 * 1) 不是符号链接；2) realpath 与解析路径一致（无符号链接链/junction），
 *    给定 projectRoot 时还要求 realpath 落在项目根内。
 */
export async function assertPublishPathSafe(
  skillsRoot: string,
  name: string,
  projectRoot?: string,
): Promise<{ root: string; dir: string; file: string }> {
  const { root, dir, file } = resolveSkillPaths(skillsRoot, name);
  const base = projectRoot ? await realpath(projectRoot) : null;
  const chain = [root, localDirname(root), dir];
  for (const p of chain) {
    if (!(await pathExists(p))) continue;
    const st = await lstat(p);
    if (st.isSymbolicLink()) throw new Error(`拒绝：${p} 是符号链接（发布路径不安全）`);
    const real = await realpath(p);
    const resolved = resolve(p);
    if (real.toLowerCase() === resolved.toLowerCase()) continue;
    if (base) {
      const rel = relative(base, real).toLowerCase();
      if (rel.startsWith("..") || isAbsolute(rel)) {
        throw new Error(`拒绝：${p} 的 realpath（${real}）逃逸出项目根，操作被拒绝`);
      }
    } else {
      throw new Error(`拒绝：${p} 非常规路径（realpath 不一致，疑似符号链接链）`);
    }
  }
  return { root, dir, file };
}

/**
 * 回滚目标文件到审批前内容（best-effort；发布/退休中途失败时调用）。
 * 回滚失败会抛错，调用方需向用户报告可能的状态不一致。
 */
export async function rollbackSkillFile(skillsRoot: string, name: string, content: string): Promise<void> {
  const { file } = resolveSkillPaths(skillsRoot, name);
  await rm(file, { force: true }).catch(() => {});
  const openFresh = () => open(file, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_TRUNC, 0o644);
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await openFresh();
  } catch (firstErr) {
    await rm(file, { force: true }).catch(() => {});
    try {
      handle = await openFresh();
    } catch (secondErr) {
      throw new Error(
        `skill 回滚失败（${file}）：${secondErr instanceof Error ? secondErr.message : String(secondErr)}（首次错误：${firstErr instanceof Error ? firstErr.message : String(firstErr)}）`,
      );
    }
  }
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * 安全发布 skill 到 skillsRoot/<name>/SKILL.md。
 * options.overwrite: 审批确认后才允许替换已存在内容（仅 update 场景；new 绝不用）。
 * options.projectRoot: 给定后路径链 realpath 以项目根为包含性基准（审批流程应始终传入）。
 * 返回 { file, bytes }。任何可疑状态都抛错，绝不静默降级。
 */
export async function publishSkill(
  skillsRoot: string,
  name: string,
  skillMd: string,
  { overwrite = false, projectRoot }: { overwrite?: boolean; projectRoot?: string } = {},
): Promise<{ file: string; bytes: number }> {
  // 1) 写前路径链校验（skills 根 / .pi / name 目录）
  const { root, dir, file } = await assertPublishPathSafe(skillsRoot, name, projectRoot);

  // 2) skills 根与 name 目录：不存在则创建
  if (!(await pathExists(root))) await mkdir(root, { recursive: true });
  if (!(await pathExists(dir))) {
    await mkdir(dir).catch((e) => {
      if ((e as NodeJS.ErrnoException)?.code === "EEXIST") return; // 并发创建，随后重验
      throw e;
    });
  }
  // 2.5) 创建后重验（防 mkdir 窗口内被替换为符号链接）
  await assertPublishPathSafe(skillsRoot, name, projectRoot);

  // 3) 写文件（O_EXCL 语义）
  const exists = await pathExists(file);
  if (exists && !overwrite) {
    throw new Error(`skill "${name}" 已存在：${file}。new 审批绝不覆盖；如需替换请先处理现有 skill`);
  }
  if (exists) {
    const st = await lstat(file);
    if (st.isSymbolicLink() || !st.isFile()) throw new Error(`拒绝：${file} 是符号链接或非常规文件`);
    await rm(file, { force: true });
  }
  // unlink→create 之间存在理论竞态窗口：O_EXCL 保证此时若出现任何条目（含符号链接）则失败
  const handle = await open(file, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_TRUNC, 0o644);
  try {
    await handle.writeFile(skillMd, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }

  // 4) 发布后 sanity：常规文件检查（路径包含性已在写前验证）
  const st = await lstat(file);
  if (st.isSymbolicLink() || !st.isFile()) throw new Error(`发布校验失败：${file} 不是常规文件`);

  return { file, bytes: Buffer.byteLength(skillMd, "utf8") };
}

/**
 * pi-web 远程影子工作区检测：~/.pi/remote/<id> 下的 cwd 只是本地影子目录，不是远程仓库。
 * v1 保守策略：记忆照常（数据在影子目录本地持久化），skill 发布禁用；不做 SSH 耦合，不动 shadow id。
 */
export function isShadowWorkspace(projectRoot: string, { agentDir }: { agentDir?: string } = {}): boolean {
  if (!projectRoot) return false;
  return isShadowWorkspacePath(projectRoot, { agentDir });
}
