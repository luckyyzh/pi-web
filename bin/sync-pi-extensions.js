#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports -- 启动脚本使用 CommonJS。 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const REPOSITORY = 'https://github.com/luckyyzh/pi-web-extensions.git';
const MARKER = '.pi-web-extensions-installed';
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const sourceOf = (entry) => typeof entry === 'string' ? entry : entry.source;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function git(args, cwd) {
  await promisify(execFile)('git', args, {
    cwd, windowsHide: true, timeout: 120_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
}

async function packageManager(agentDir) {
  const { DefaultPackageManager, SettingsManager } = await import('@earendil-works/pi-coding-agent');
  const settings = SettingsManager.create(process.cwd(), agentDir, { projectTrusted: false });
  const manager = new DefaultPackageManager({ cwd: process.cwd(), agentDir, settingsManager: settings });
  const check = () => {
    if (settings.drainErrors().length) throw new Error('Cannot read/write Pi settings');
  };
  check();
  return {
    packages: () => settings.getGlobalSettings().packages || [],
    async install(source) {
      await manager.installAndPersist(source, { local: false });
      await settings.flush();
      check();
    },
  };
}

function matches(source, name) {
  const s = source.replace(/\\/g, '/');
  return s === name || s === `npm:${name}` || s.startsWith(`npm:${name}@`) || s.endsWith(`/${name}`);
}

const versionOf = (source) => {
  const match = /^npm:.*@([^@]+)$/.exec(source);
  return match ? match[1] : null;
};

// 仅替换官方基线/已知修复，未知本机修改报错；不会复制用户配置或历史。
function applyPatch(repo, agentDir, item) {
  const manifestFile = path.join(repo, item.patch);
  const patch = readJson(manifestFile);
  const installed = path.join(agentDir, 'npm', 'node_modules', item.name);
  const pkg = readJson(path.join(installed, 'package.json'));
  if (patch.package !== item.name || patch.version !== item.version || pkg.version !== item.version) throw new Error(`Patch version mismatch: ${item.name}`);
  const changes = patch.files.map((file) => {
    const target = path.join(installed, file.path);
    const bytes = fs.readFileSync(path.join(path.dirname(manifestFile), file.path));
    if (hash(bytes) !== file.after) throw new Error(`Invalid patch checksum: ${file.path}`);
    if (![file.before, file.after, ...(file.previous || [])].includes(hash(fs.readFileSync(target)))) {
      throw new Error(`Locally modified file; refusing to overwrite ${item.name}/${file.path}`);
    }
    return { target, bytes };
  });
  for (const { target, bytes } of changes) fs.writeFileSync(target, bytes);
}

async function syncExtensions({ mode = 'ensure', agentDir, repository = REPOSITORY, runGit = git, createManager = packageManager, log = console.log } = {}) {
  if (!['ensure', 'update'].includes(mode)) throw new Error('Usage: node bin/sync-pi-extensions.js [ensure|update]');
  agentDir = path.resolve((agentDir || process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent')).replace(/^~(?=$|[/\\])/, os.homedir()));
  const marker = path.join(agentDir, MARKER);
  // 普通启动只检查一个本地文件：不查版本、不调用 Git/npm、不加载 SDK。
  if (mode === 'ensure' && fs.existsSync(marker)) return;
  fs.mkdirSync(agentDir, { recursive: true });
  const repo = path.join(agentDir, 'pi-web-extensions');
  if (!fs.existsSync(repo)) {
    log('[extensions] Downloading extension repository...');
    await runGit(['clone', '--branch', 'main', '--single-branch', '--', repository, repo], agentDir);
  } else if (mode === 'update') {
    // Git 自身会拒绝冲突；不使用 reset/clean 丢弃本地改动。
    await runGit(['pull', '--ff-only', 'origin', 'main'], repo);
  }
  const manifest = readJson(path.join(repo, 'install-manifest.json'));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.packages)) throw new Error('Unsupported extension manifest');
  const manager = await createManager(agentDir);
  const patches = [];
  for (const item of manifest.packages) {
    const existing = manager.packages().find((entry) => matches(sourceOf(entry), item.name));
    const existingSource = existing ? sourceOf(existing) : '';
    // 清单钉住的版本变化时重装，自动拉取的新版本才能生效。
    const stale = !item.path && versionOf(existingSource) !== null && versionOf(existingSource) !== item.version;
    // 首次保留已有安装。本地扩展已有其它来源时不重复登记；update 显式更新清单中的 npm 包。
    const source = item.path ? path.join(repo, item.path) : `npm:${item.name}@${item.version}`;
    if (existing && (mode === 'ensure' || item.path || !existingSource.startsWith('npm:')) && !stale) {
      // 首次安装中途失败后重试，仍须完成已登记包的修复，不能只留下完成标记。
      if (item.patch && sourceOf(existing) === source) patches.push(item);
      continue;
    }
    log(`[extensions] Installing ${item.name}...`);
    await manager.install(source);
    if (item.patch) patches.push(item);
  }
  // 所有 npm 安装结束后再应用修复，避免后续依赖安装覆盖补丁。
  for (const item of patches) applyPatch(repo, agentDir, item);
  fs.writeFileSync(marker, 'installed\n');
  log('[extensions] Done. Use start-pi-web.cmd update to update manually.');
}

module.exports = { syncExtensions, applyPatch, MARKER };
if (require.main === module) {
  syncExtensions({ mode: process.argv[2] || 'ensure' }).catch((error) => {
    console.error(`[extensions] ${error.message}`);
    process.exitCode = 1;
  });
}
