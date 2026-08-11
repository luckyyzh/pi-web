/**
 * SSH Remote Execution Extension
 *
 * 远程执行模式：read/write/edit/bash 转发到远程机器执行。
 *
 * 启用方式（两种，接口兼容）：
 *   CLI:   pi --ssh user@host 或 pi --ssh user@host:/remote/path（映射基准 = 本地 cwd）
 *   webUI: /ssh user@host 或 /ssh user@host:/remote/path；/ssh off 退出；/ssh 查看状态
 *          （映射基准 = 影子根 ~/.pi/remote/<host>_<hash>/，与 pi-web 后端一致）
 *
 * webUI 场景配置持久化在 ~/.pi/agent/ssh-config.json（pi-web 前端/后端也读写同一文件）：
 *   { "enabled": boolean, "host": "user@host", "path": "/remote/dir" | "" }
 *
 * Requirements:
 *   - SSH key-based auth (no password prompts)
 *   - bash on remote
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	type BashOperations,
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
	type EditOperations,
	type ReadOperations,
	type WriteOperations,
} from "@earendil-works/pi-coding-agent";

const CONFIG_PATH = join(homedir(), ".pi", "agent", "ssh-config.json");
const REMOTE_BASE = join(homedir(), ".pi", "remote");

interface SshConfig {
	enabled: boolean;
	host: string; // user@host
	path: string; // "" = 登录后所在目录(pwd)
}

function loadSshConfig(): SshConfig {
	try {
		if (existsSync(CONFIG_PATH)) {
			const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
			return {
				enabled: !!raw.enabled,
				host: typeof raw.host === "string" ? raw.host : "",
				path: typeof raw.path === "string" ? raw.path : "",
			};
		}
	} catch {
		/* ignore */
	}
	return { enabled: false, host: "", path: "" };
}

function saveSshConfig(cfg: SshConfig): void {
	try {
		writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf8");
	} catch {
		/* ignore */
	}
}

/** 影子根（与 pi-web lib/ssh.ts 算法一致，保证两端映射相同） */
function shadowRootFor(host: string, remotePath: string): string {
	const hash = createHash("sha256").update(host).update("\0").update(remotePath).digest("hex").slice(0, 12);
	const safeHost = host.replace(/[^a-zA-Z0-9._-]/g, "_");
	return join(REMOTE_BASE, `${safeHost}_${hash}`);
}

function sshExec(remote: string, command: string): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const child = spawn("ssh", [remote, command], { stdio: ["ignore", "pipe", "pipe"] });
		const chunks: Buffer[] = [];
		const errChunks: Buffer[] = [];
		child.stdout.on("data", (data) => chunks.push(data));
		child.stderr.on("data", (data) => errChunks.push(data));
		child.on("error", reject);
		child.on("close", (code) => {
			if (code !== 0) {
				reject(new Error(`SSH failed (${code}): ${Buffer.concat(errChunks).toString()}`));
			} else {
				resolve(Buffer.concat(chunks));
			}
		});
	});
}

/**
 * 解析 "user@host" 或 "user@host:/path"：
 *   - 含 ':' → 指定远程目录
 *   - 不含 ':' → 远程执行 pwd 取登录目录
 */
async function resolveRemote(arg: string): Promise<{ remote: string; remoteCwd: string }> {
	if (arg.includes(":")) {
		const [remote, path] = arg.split(":");
		return { remote, remoteCwd: path };
	}
	const remote = arg;
	const pwd = (await sshExec(remote, "pwd")).toString().trim();
	return { remote, remoteCwd: pwd };
}

/**
 * 远程 ops。base = 本地映射基准（CLI 模式 = process.cwd()；webUI 模式 = 影子根）。
 * 工具收到的路径以 base 开头 → 替换为 remoteCwd。
 */
function createRemoteReadOps(remote: string, remoteCwd: string, base: string): ReadOperations {
	const toRemote = (p: string) => p.replace(base, remoteCwd);
	return {
		readFile: (p) => sshExec(remote, `cat ${JSON.stringify(toRemote(p))}`),
		access: (p) => sshExec(remote, `test -r ${JSON.stringify(toRemote(p))}`).then(() => {}),
		detectImageMimeType: async (p) => {
			try {
				const r = await sshExec(remote, `file --mime-type -b ${JSON.stringify(toRemote(p))}`);
				const m = r.toString().trim();
				return ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(m) ? m : null;
			} catch {
				return null;
			}
		},
	};
}

function createRemoteWriteOps(remote: string, remoteCwd: string, base: string): WriteOperations {
	const toRemote = (p: string) => p.replace(base, remoteCwd);
	return {
		writeFile: async (p, content) => {
			const b64 = Buffer.from(content).toString("base64");
			await sshExec(remote, `echo ${JSON.stringify(b64)} | base64 -d > ${JSON.stringify(toRemote(p))}`);
		},
		mkdir: (dir) => sshExec(remote, `mkdir -p ${JSON.stringify(toRemote(dir))}`).then(() => {}),
	};
}

function createRemoteEditOps(remote: string, remoteCwd: string, base: string): EditOperations {
	const r = createRemoteReadOps(remote, remoteCwd, base);
	const w = createRemoteWriteOps(remote, remoteCwd, base);
	return { readFile: r.readFile, access: r.access, writeFile: w.writeFile };
}

function createRemoteBashOps(remote: string, remoteCwd: string, base: string): BashOperations {
	const toRemote = (p: string) => p.replace(base, remoteCwd);
	return {
		exec: (command, cwd, { onData, signal, timeout }) =>
			new Promise((resolve, reject) => {
				const cmd = `cd ${JSON.stringify(toRemote(cwd))} && ${command}`;
				const child = spawn("ssh", [remote, cmd], { stdio: ["ignore", "pipe", "pipe"] });
				let timedOut = false;
				const timer = timeout
					? setTimeout(() => {
							timedOut = true;
							child.kill();
						}, timeout * 1000)
					: undefined;
				child.stdout.on("data", onData);
				child.stderr.on("data", onData);
				child.on("error", (e) => {
					if (timer) clearTimeout(timer);
					reject(e);
				});
				const onAbort = () => child.kill();
				signal?.addEventListener("abort", onAbort, { once: true });
				child.on("close", (code) => {
					if (timer) clearTimeout(timer);
					signal?.removeEventListener("abort", onAbort);
					if (signal?.aborted) reject(new Error("aborted"));
					else if (timedOut) reject(new Error(`timeout:${timeout}`));
					else resolve({ exitCode: code });
				});
			}),
	};
}

export default function (pi: ExtensionAPI) {
	pi.registerFlag("ssh", { description: "SSH remote: user@host or user@host:/path", type: "string" });

	const localCwd = process.cwd();
	const localRead = createReadTool(localCwd);
	const localWrite = createWriteTool(localCwd);
	const localEdit = createEditTool(localCwd);
	const localBash = createBashTool(localCwd);

	// 远程模式状态：base = 本地映射基准（CLI=localCwd / webUI=shadowRoot）
	let resolvedSsh: { remote: string; remoteCwd: string; base: string } | null = null;

	const getSsh = () => resolvedSsh;

	function makeRemoteTools(ssh: { remote: string; remoteCwd: string; base: string }): {
		read: ReturnType<typeof createReadTool>;
		write: ReturnType<typeof createWriteTool>;
		edit: ReturnType<typeof createEditTool>;
		bash: ReturnType<typeof createBashTool>;
	} {
		return {
			read: createReadTool(ssh.base, { operations: createRemoteReadOps(ssh.remote, ssh.remoteCwd, ssh.base) }),
			write: createWriteTool(ssh.base, { operations: createRemoteWriteOps(ssh.remote, ssh.remoteCwd, ssh.base) }),
			edit: createEditTool(ssh.base, { operations: createRemoteEditOps(ssh.remote, ssh.remoteCwd, ssh.base) }),
			bash: createBashTool(ssh.base, { operations: createRemoteBashOps(ssh.remote, ssh.remoteCwd, ssh.base) }),
		};
	}

	pi.registerTool({
		...localRead,
		async execute(id, params, signal, onUpdate, _ctx) {
			const ssh = getSsh();
			if (ssh) {
				return makeRemoteTools(ssh).read.execute(id, params, signal, onUpdate);
			}
			return localRead.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localWrite,
		async execute(id, params, signal, onUpdate, _ctx) {
			const ssh = getSsh();
			if (ssh) {
				return makeRemoteTools(ssh).write.execute(id, params, signal, onUpdate);
			}
			return localWrite.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localEdit,
		async execute(id, params, signal, onUpdate, _ctx) {
			const ssh = getSsh();
			if (ssh) {
				return makeRemoteTools(ssh).edit.execute(id, params, signal, onUpdate);
			}
			return localEdit.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localBash,
		async execute(id, params, signal, onUpdate, _ctx) {
			const ssh = getSsh();
			if (ssh) {
				return makeRemoteTools(ssh).bash.execute(id, params, signal, onUpdate);
			}
			return localBash.execute(id, params, signal, onUpdate);
		},
	});

	// 启用/禁用远程模式；同步状态栏
	function setSshMode(
		ssh: { remote: string; remoteCwd: string; base: string } | null,
		ui?: { setStatus: (k: string, v?: string) => void; theme: { fg: (c: string, s: string) => string } },
	): void {
		resolvedSsh = ssh;
		try {
			if (ssh) {
				ui?.setStatus("ssh", ui.theme.fg("accent", `SSH: ${ssh.remote}:${ssh.remoteCwd}`));
			} else {
				ui?.setStatus("ssh", undefined);
			}
		} catch {
			/* ignore */
		}
	}

	// 会话开始：CLI flag 优先；否则读 ssh-config.json（webUI 场景）
	pi.on("session_start", async (_event, ctx) => {
		const arg = pi.getFlag("ssh") as string | undefined;
		try {
			if (arg) {
				// CLI 模式：映射基准 = 本地 cwd
				const ssh = await resolveRemote(arg);
				setSshMode({ ...ssh, base: localCwd }, ctx.ui);
				ctx.ui.notify(`SSH mode: ${ssh.remote}:${ssh.remoteCwd}`, "info");
			} else {
				const cfg = loadSshConfig();
				if (cfg.enabled && cfg.host) {
					const ssh = await resolveRemote(cfg.path ? `${cfg.host}:${cfg.path}` : cfg.host);
					// webUI 模式：映射基准 = 影子根
					setSshMode({ ...ssh, base: shadowRootFor(cfg.host, cfg.path || "/") }, ctx.ui);
					ctx.ui.notify(`SSH mode: ${ssh.remote}:${ssh.remoteCwd}`, "info");
				}
			}
		} catch (error) {
			ctx.ui.notify(`SSH 连接失败：${error instanceof Error ? error.message : String(error)}`, "error");
		}
	});

	// 命令：/ssh（webUI 可用的模式切换）
	pi.registerCommand("ssh", {
		description: "SSH 远程执行：/ssh user@host 或 /ssh user@host:/path 启用；/ssh off 退出；/ssh 查看状态",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/);
			const arg = parts[0];

			if (!arg) {
				if (resolvedSsh) {
					ctx.ui.notify(`SSH mode: ${resolvedSsh.remote}:${resolvedSsh.remoteCwd}`, "info");
				} else {
					ctx.ui.notify(
						"SSH 未启用。用法：\n  /ssh user@host         启用（远程目录取 pwd）\n  /ssh user@host:/path   启用（指定远程目录）\n  /ssh off               退出 SSH 模式",
						"info",
					);
				}
				return;
			}

			if (arg === "off") {
				saveSshConfig({ enabled: false, host: loadSshConfig().host, path: "" });
				setSshMode(null, ctx.ui);
				ctx.ui.notify("已退出 SSH 模式", "info");
				return;
			}

			try {
				const ssh = await resolveRemote(arg);
				const [host, path] = arg.includes(":") ? [arg.split(":")[0], arg.split(":")[1]] : [arg, ""];
				saveSshConfig({ enabled: true, host, path });
				setSshMode({ ...ssh, base: shadowRootFor(host, path || "/") }, ctx.ui);
				ctx.ui.notify(`SSH mode: ${ssh.remote}:${ssh.remoteCwd}`, "info");
			} catch (error) {
				ctx.ui.notify(`SSH 连接失败：${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});

	// Handle user ! commands via SSH
	pi.on("user_bash", (_event) => {
		const ssh = getSsh();
		if (!ssh) return; // No SSH, use local execution
		return { operations: createRemoteBashOps(ssh.remote, ssh.remoteCwd, ssh.base) };
	});

	// Replace local cwd with remote cwd in system prompt
	pi.on("before_agent_start", async (event) => {
		const ssh = getSsh();
		if (ssh) {
			// system prompt 里 cwd 是正斜杠格式
			const cwdInPrompt = ssh.base.replace(/\\/g, "/");
			const modified = event.systemPrompt.replace(
				`Current working directory: ${cwdInPrompt}`,
				`Current working directory: ${ssh.remoteCwd} (via SSH: ${ssh.remote})`,
			);
			return { systemPrompt: modified };
		}
	});
}
