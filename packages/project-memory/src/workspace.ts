/**
 * src/workspace.ts — 工作区判定（纯函数，零依赖）。
 *
 * pi-web 的远程 SSH 工作区以「影子目录」形式存在：~/.pi/remote/<host>_<hash>/。
 * 它是本地目录，不是远程仓库本身。v1 保守策略：
 * - 该路径下运行时项目记忆照常（数据落在影子目录本地，不会同步回远程仓库）；
 * - skill 发布禁用（发布到影子目录 ≠ 发布到远程项目）。
 * 只做检测与明确提示，不引入 SSH 耦合，不改变 shadow id 规则。
 */
import { dirname, join, resolve, sep } from "node:path";
import { homedir } from "node:os";

/** agentDir 默认为 ~/.pi/agent（pi 运行时传入；测试可注入）。 */
export function remoteRootFor(agentDir?: string): string {
  const base = agentDir && String(agentDir).trim() ? String(agentDir) : join(homedir(), ".pi", "agent");
  return join(dirname(resolve(base)), "remote");
}

/** 判断 projectRoot 是否等于或位于远程影子根目录（~/.pi/remote/）内。 */
export function isShadowWorkspacePath(projectRoot: string, { agentDir }: { agentDir?: string } = {}): boolean {
  if (!projectRoot) return false;
  const remoteRoot = resolve(remoteRootFor(agentDir));
  const p = resolve(projectRoot);
  if (p === remoteRoot) return true;
  const withSep = remoteRoot.endsWith(sep) ? remoteRoot : remoteRoot + sep;
  return p.startsWith(withSep);
}
