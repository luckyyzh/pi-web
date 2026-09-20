#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports -- 启动脚本使用 CommonJS。 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

// 启动前自动更新：fork 与插件仓库有新提交时快进更新。
// 预期失败（无网络、本地改动、分支分叉）只警告，不阻塞启动。

const agentDir = path.resolve(
  (process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent'))
    .replace(/^~(?=$|[/\\])/, os.homedir()),
);

async function git(args, cwd) {
  return promisify(execFile)('git', args, {
    cwd, windowsHide: true, timeout: 60_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
}

const reason = (error) => String(error.message || error).split('\n').find(Boolean) || 'git error';

// 返回远端领先的提交数；null 表示 fetch 失败（无网络等）。
async function aheadOf(cwd, remote, branch) {
  try {
    await git(['fetch', remote, branch], cwd);
    const { stdout } = await git(['rev-list', '--count', `HEAD..${remote}/${branch}`], cwd);
    return Number.parseInt(stdout.trim(), 10) || 0;
  } catch (error) {
    console.log(`[updates] ${branch}: fetch ${remote} failed, keeping current version (${reason(error)})`);
    return null;
  }
}

// 有新提交时 pull --ff-only；成功返回 { before }，否则返回 null。
async function fastForward(cwd, remote, branch, label) {
  const ahead = await aheadOf(cwd, remote, branch);
  if (ahead === null) return null;
  if (!ahead) {
    console.log(`[updates] ${label}: up to date.`);
    return null;
  }
  const { stdout } = await git(['rev-parse', 'HEAD'], cwd);
  const before = stdout.trim();
  try {
    await git(['pull', '--ff-only', remote, branch], cwd);
  } catch (error) {
    console.log(`[updates] ${label}: cannot auto-update (${reason(error)}). Run git pull manually when ready.`);
    return null;
  }
  console.log(`[updates] ${label}: updated, ${ahead} new commit(s).`);
  return { before };
}

async function updatePiWeb() {
  const root = process.cwd();
  if (!fs.existsSync(path.join(root, '.git'))) {
    console.log('[updates] pi-web: not a git checkout, skipping.');
    return;
  }
  let branch = '';
  try {
    const { stdout } = await git(['rev-parse', '--abbrev-ref', 'HEAD'], root);
    branch = stdout.trim();
  } catch {
    console.log('[updates] pi-web: git unavailable, skipping.');
    return;
  }
  if (!branch) {
    console.log('[updates] pi-web: detached HEAD, skipping.');
    return;
  }
  const updated = await fastForward(root, 'origin', branch, 'pi-web');
  if (!updated) return;
  // 代码已变化：删 BUILD_ID 让启动脚本重新构建；依赖清单变化时强制重装。
  try {
    const { stdout } = await git(['diff', '--name-only', updated.before, 'HEAD'], root);
    const changed = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const buildId = path.join(root, '.next', 'BUILD_ID');
    if (fs.existsSync(buildId)) {
      fs.rmSync(buildId);
      console.log('[updates] pi-web: build will be re-created.');
    }
    if (changed.some((file) => file === 'package.json' || file === 'package-lock.json')) {
      const marker = path.join(root, 'node_modules', '@earendil-works', 'pi-coding-agent');
      if (fs.existsSync(marker)) {
        fs.rmSync(marker, { recursive: true, force: true });
        console.log('[updates] pi-web: dependencies changed, will be reinstalled.');
      }
    }
  } catch (error) {
    console.log(`[updates] pi-web: code updated, but stale artifacts were kept (${reason(error)}).`);
  }
}

async function updateExtensions() {
  const repo = path.join(agentDir, 'pi-web-extensions');
  if (!fs.existsSync(repo)) return; // 尚未安装时由 sync 负责克隆。
  const updated = await fastForward(repo, 'origin', 'main', 'extensions');
  if (!updated) return;
  // 删完成标记，让随后的 sync 重新安装清单包并应用新补丁。
  const marker = path.join(agentDir, '.pi-web-extensions-installed');
  if (fs.existsSync(marker)) fs.rmSync(marker);
}

const mode = process.argv[2] || 'ensure';
if (!['ensure', 'update'].includes(mode)) {
  console.error('[updates] Usage: node bin/check-updates.js [ensure|update]');
  process.exitCode = 1;
} else {
  (async () => {
    await updatePiWeb();
    // update 模式由 sync-pi-extensions.js 负责插件仓库更新，避免重复。
    if (mode === 'ensure') await updateExtensions();
  })().catch((error) => {
    console.error(`[updates] ${reason(error)}`);
    process.exitCode = 1;
  });
}
