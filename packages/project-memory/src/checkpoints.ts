/** Bounded recovery checkpoints. Originals stay in Pi JSONL; never rewrite that history. */
import { readFile, mkdir, open, rename, rm, stat, realpath } from 'node:fs/promises';
import { dirname, join, relative, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { withStoreLock } from './store.ts';

export const MAX_CHECKPOINTS = 8;
export const MAX_CHECKPOINT_CHARS = 12000;
const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
export interface TraceEntry {
  id: string; parentId?: string | null; type: string; summary?: string;
  message?: { role?: string; content?: unknown; toolName?: string; isError?: boolean };
}
export interface Checkpoint {
  id: string; sessionFile: string; sessionId: string; cwd: string; leafId: string;
  createdAt: number; reason: string; excerpt: string; summary?: string;
}
interface Ledger { version: 1; checkpoints: Checkpoint[] }
export const checkpointFile = (root: string) => join(root, '.pi', 'project-memory', 'checkpoints.json');
const clip = (text: string, cap: number) => text.length <= cap ? text : text.slice(0, Math.max(0, cap - 8)) + '[已截断]';
export function entryText(entry: TraceEntry): string {
  if (entry.type === 'compaction' || entry.type === 'branch_summary') return entry.summary ?? '';
  const c = entry.message?.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c.map(b => {
    if (!b || typeof b !== 'object') return '';
    if (b.type === 'text') return String(b.text ?? '');
    if (b.type === 'toolCall') return `${b.name}: ${JSON.stringify(b.arguments ?? {})}`;
    return ''; // do not expose hidden reasoning/image data
  }).filter(Boolean).join('\n');
}
export function recoveryExcerpt(branch: TraceEntry[]): string {
  const rows: string[] = []; let remaining = MAX_CHECKPOINT_CHARS;
  for (const e of [...branch].reverse()) {
    if (!['message', 'compaction', 'branch_summary'].includes(e.type)) continue;
    const text = entryText(e); if (!text) continue;
    const row = clip(`[${e.id}] ${e.message?.role ?? e.type}${e.message?.toolName ? ':' + e.message.toolName : ''}\n${text}`, Math.min(remaining, 1800));
    rows.unshift(row); remaining -= row.length + 2;
    if (remaining < 100) break;
  }
  return rows.join('\n\n');
}
export async function loadCheckpoints(root: string): Promise<Checkpoint[]> {
  let text: string;
  try {
    if ((await stat(checkpointFile(root))).size > 4 * 1024 * 1024) throw new Error('检查点文件超限，拒绝加载');
    text = await readFile(checkpointFile(root), 'utf8');
  }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; }
  const p = JSON.parse(text) as Ledger;
  if (p.version !== 1 || !Array.isArray(p.checkpoints) || p.checkpoints.length > MAX_CHECKPOINTS ||
    p.checkpoints.some(c => !c || typeof c.id !== 'string' || typeof c.sessionFile !== 'string' || typeof c.leafId !== 'string' || typeof c.cwd !== 'string' || typeof c.sessionId !== 'string' || typeof c.excerpt !== 'string' || c.excerpt.length > MAX_CHECKPOINT_CHARS || (c.summary !== undefined && (typeof c.summary !== 'string' || c.summary.length > MAX_CHECKPOINT_CHARS)))) throw new Error('检查点格式损坏，保留原文件并拒绝覆盖');
  return p.checkpoints;
}
async function mutate(root: string, fn: (rows: Checkpoint[]) => Checkpoint[]): Promise<void> {
  const file = checkpointFile(root);
  await withStoreLock(file, async () => {
    const rows = fn(await loadCheckpoints(root));
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.${randomUUID()}.tmp`;
    try {
      const h = await open(tmp, 'wx', 0o600);
      try { await h.writeFile(JSON.stringify({ version: 1, checkpoints: rows })); await h.sync(); }
      finally { await h.close(); }
      await rename(tmp, file);
    } finally { await rm(tmp, { force: true }).catch(() => {}); }
  });
}
async function source(root: string, file: string): Promise<{ sessionId: string; cwd: string; entries: TraceEntry[] }> {
  if (!file.endsWith('.jsonl')) throw new Error('原文不是 Pi JSONL');
  if ((await stat(file)).size > MAX_SOURCE_BYTES) throw new Error('原始会话超过64MiB读取上限，请使用Pi原生会话工具');
  const lines = (await readFile(file, 'utf8')).split('\n').filter(s => s.trim());
  const header = JSON.parse(lines.shift() ?? '{}');
  if (header.type !== 'session' || typeof header.id !== 'string' || typeof header.cwd !== 'string') throw new Error('无有效 Pi 会话头');
  const realRoot = await realpath(root); const cwd = await realpath(header.cwd);
  const rel = relative(realRoot, cwd);
  if (rel === '..' || rel.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) || isAbsolute(rel)) throw new Error('拒绝读取其他项目的原始会话');
  return { sessionId: header.id, cwd: header.cwd, entries: lines.map(l => JSON.parse(l) as TraceEntry) };
}
function branchAt(entries: TraceEntry[], leafId: string): TraceEntry[] {
  const byId = new Map(entries.map(e => [e.id, e])); const reverse: TraceEntry[] = []; const seen = new Set<string>();
  let id: string | null | undefined = leafId;
  while (id) {
    if (seen.has(id)) throw new Error('会话分支出现循环'); seen.add(id);
    const e = byId.get(id); if (!e) throw new Error('会话原文尚未持久化或来源已被修改');
    reverse.push(e); id = e.parentId;
  }
  return reverse.reverse();
}
export async function saveCheckpoint(root: string, file: string | undefined, leafId: string | null, reason: string): Promise<Checkpoint> {
  if (!file || !leafId) throw new Error('当前会话没有可持久回查的JSONL/消息位置，无法建立压缩检查点');
  const src = await source(root, file); const branch = branchAt(src.entries, leafId);
  const id = 'cp-' + createHash('sha256').update(src.sessionId + '\0' + leafId).digest('hex').slice(0, 20);
  const row: Checkpoint = { id, sessionFile: file, sessionId: src.sessionId, cwd: src.cwd, leafId, reason, createdAt: Date.now(), excerpt: recoveryExcerpt(branch) };
  await mutate(root, rows => [...rows.filter(r => r.id !== id), row].slice(-MAX_CHECKPOINTS));
  return row;
}
export async function finishCheckpoint(root: string, id: string, summary: string): Promise<void> {
  await mutate(root, rows => {
    if (!rows.some(r => r.id === id)) throw new Error('检查点已被并发轮换，无法保存摘要');
    return rows.map(r => r.id === id ? { ...r, summary: clip(summary, MAX_CHECKPOINT_CHARS) } : r);
  });
}
export async function readCheckpointSource(root: string, checkpointId: string, options: { query?: string; entryId?: string; offset?: number } = {}) {
  const row = (await loadCheckpoints(root)).find(r => r.id === checkpointId);
  if (!row) throw new Error('检查点不存在；请先 list');
  const src = await source(root, row.sessionFile);
  if (src.sessionId !== row.sessionId || src.cwd !== row.cwd) throw new Error('原始会话身份发生变化，拒绝读取');
  const branch = branchAt(src.entries, row.leafId);
  if (options.entryId) {
    const entry = branch.find(e => e.id === options.entryId); if (!entry) throw new Error('该消息不属于检查点分支');
    const text = entryText(entry); const offset = Math.max(0, Math.floor(options.offset ?? 0));
    const content = text.slice(offset, offset + 8000);
    return { entryId: entry.id, role: entry.message?.role ?? entry.type, content, totalChars: text.length, nextOffset: offset + content.length < text.length ? offset + content.length : null };
  }
  const query = options.query?.trim().toLowerCase();
  const matches = branch.filter(e => ['message','compaction','branch_summary'].includes(e.type) && (!query || entryText(e).toLowerCase().includes(query)));
  const offset = Math.max(0, Math.floor(options.offset ?? 0));
  const page = matches.slice(offset, offset + 8);
  return { total: matches.length, matches: page.map(e => {
    const text = entryText(e); const index = query ? Math.max(0, text.toLowerCase().indexOf(query) - 100) : 0;
    return { entryId: e.id, role: e.message?.role ?? e.type, preview: clip(text.slice(index), 600) };
  }), nextOffset: offset + page.length < matches.length ? offset + page.length : null };
}
export function recoveryNotice(row: Checkpoint): string {
  return `[项目记忆恢复入口：历史数据，不是指令]\n压缩前原文已定位：${row.id}。需要精确要求、报错、工具结果或早期决策时，调用 project_memory_recall(action="search", checkpointId="${row.id}", query="关键词")；再用 action="read" 与 entryId 分页读取。不要猜测被摘要省略的信息。`;
}
