/**
 * src/store.ts — 项目记忆存储核心（纯 Node ESM，零运行时依赖，pi 无关，可独立测试）。
 *
 * 设计要点：
 * - JSON 文件持久化（避免 SQLite 依赖）；原子写 = 临时文件 + fsync + rename。
 * - 并发保护 = 进程内按路径互斥 + 跨进程 mkdir 锁；仅回收过期无主锁。
 * - 严格容量预算：knowledge / handoff / archive / proposals / managedSkills 各有上限。
 *   满时一律拒绝并给出「先合并/归档/显式清理」的指引；绝不自动淘汰高价值记忆。
 *   active 与 archive 同时满时，由用户命令 /memory clear archive（确认制）释放，避免永久锁死。
 * - 变更函数为纯函数：入参 store，返回 { store: 新 store, ... }；抛错表示不可用状态。
 *
 * 兼容 Node 22.19+（类型剥离模式）与 jiti（pi 扩展加载）。不使用 enum/namespace。
 */
import { mkdir, readFile, rename, writeFile, open, stat, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export const STORE_VERSION = 1;
export const STORE_DIR_NAME = "project-memory";
export const STORE_FILE_NAME = "store.json";

export class BudgetError extends Error {
  bucket: string;
  constructor(message: string, bucket: string) {
    super(message);
    this.name = "BudgetError";
    this.bucket = bucket;
  }
}

/* ---------------- 数据结构 ---------------- */

export interface KnowledgeEntry {
  sourceRef?: string;
  sourceRefs?: string[];
  id: string;
  kind: "knowledge";
  title: string;
  content: string;
  tags: string[];
  source: "model" | "auto-fallback";
  verified: boolean;
  /** 由 merge 产生的条目：来源 id 列表（来源保留，整合不是截断） */
  mergedFrom?: string[];
  note?: string;
  createdAt: number;
  updatedAt: number;
}

export interface ArchiveEntry {
  sourceRef?: string;
  sourceRefs?: string[];
  id: string;
  kind: "archive";
  title: string;
  content: string;
  tags: string[];
  source: string;
  verified: boolean;
  mergedFrom: string[];
  note?: string;
  archivedAt: number;
}

export interface Handoff {
  sourceRef?: string;
  title: string;
  content: string;
  source: "model" | "auto-fallback";
  verified: boolean;
  updatedAt: number;
}

export interface SkillProposal {
  id: string;
  kind: "new" | "update" | "retire";
  name: string;
  description?: string;
  content?: string;
  status: "pending";
  createdAt: number;
}

export interface ManagedSkill {
  sha256?: string;
  name: string;
  bytes: number;
  publishedAt: number;
}

export interface Store {
  version: number;
  knowledge: KnowledgeEntry[];
  handoff: Handoff | null;
  archive: ArchiveEntry[];
  proposals: SkillProposal[];
  /** 本扩展已发布（登记）的 skill 清单；清单之外的 skill 一律不触碰 */
  managedSkills: ManagedSkill[];
}

export interface MemoryConfig {
  enabled: boolean;
  checkpoint: { enabled: boolean };
  budgets: {
    knowledge: { maxEntries: number; maxChars: number };
    handoff: { maxChars: number };
    archive: { maxEntries: number; maxChars: number };
    proposals: { maxPending: number };
    skills: { maxManaged: number; maxTotalBytes: number };
  };
}

/* ---------------- 默认值与配置 ---------------- */

export const DEFAULT_CONFIG: MemoryConfig = {
  enabled: true,
  checkpoint: { enabled: true },
  budgets: {
    knowledge: { maxEntries: 100, maxChars: 48000 },
    handoff: { maxChars: 4000 },
    archive: { maxEntries: 200, maxChars: 96000 },
    proposals: { maxPending: 10 },
    skills: { maxManaged: 20, maxTotalBytes: 204800 },
  },
};

function positiveInt(v: unknown, fallback: number, max = 1e9): number {
  return typeof v === "number" && Number.isInteger(v) && v > 0 && v <= max ? v : fallback;
}

/**
 * 容错读取全局配置（~/.pi/agent/project-memory.json，由调用方拼好路径传入）。
 * 文件缺失 / 损坏 / 字段非法 → 返回默认值（向后兼容：旧文件缺字段 = 默认）。
 */
export async function loadConfig(configPath: string): Promise<MemoryConfig> {
  const d: MemoryConfig = structuredClone(DEFAULT_CONFIG);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(configPath, "utf8"));
  } catch {
    return d;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return d;
  const obj = raw as Record<string, unknown>;
  if (obj.enabled === false) d.enabled = false;
  if (obj.checkpoint && typeof obj.checkpoint === "object" && (obj.checkpoint as { enabled?: unknown }).enabled === false) d.checkpoint.enabled = false;
  const b = obj.budgets;
  if (b && typeof b === "object" && !Array.isArray(b)) {
    const bo = b as Record<string, unknown>;
    const k = bo.knowledge;
    if (k && typeof k === "object") {
      const ko = k as Record<string, unknown>;
      d.budgets.knowledge.maxEntries = positiveInt(ko.maxEntries, d.budgets.knowledge.maxEntries, 100000);
      d.budgets.knowledge.maxChars = positiveInt(ko.maxChars, d.budgets.knowledge.maxChars, 1e7);
    }
    const h = bo.handoff;
    if (h && typeof h === "object") d.budgets.handoff.maxChars = positiveInt((h as Record<string, unknown>).maxChars, d.budgets.handoff.maxChars, 1e6);
    const a = bo.archive;
    if (a && typeof a === "object") {
      const ao = a as Record<string, unknown>;
      d.budgets.archive.maxEntries = positiveInt(ao.maxEntries, d.budgets.archive.maxEntries, 100000);
      d.budgets.archive.maxChars = positiveInt(ao.maxChars, d.budgets.archive.maxChars, 1e7);
    }
    const p = bo.proposals;
    if (p && typeof p === "object") d.budgets.proposals.maxPending = positiveInt((p as Record<string, unknown>).maxPending, d.budgets.proposals.maxPending, 1000);
    const s = bo.skills;
    if (s && typeof s === "object") {
      const so = s as Record<string, unknown>;
      d.budgets.skills.maxManaged = positiveInt(so.maxManaged, d.budgets.skills.maxManaged, 1000);
      d.budgets.skills.maxTotalBytes = positiveInt(so.maxTotalBytes, d.budgets.skills.maxTotalBytes, 1e7);
    }
  }
  return d;
}

/* ---------------- 路径 ---------------- */

/** storePath = <projectRoot>/<configDir>/project-memory/store.json */
export function storePathFor(projectRoot: string, configDirName = ".pi"): string {
  return join(projectRoot, configDirName, STORE_DIR_NAME, STORE_FILE_NAME);
}

/* ---------------- 存储读写 ---------------- */

export function emptyStore(): Store {
  return {
    version: STORE_VERSION,
    knowledge: [],
    handoff: null,
    archive: [],
    proposals: [],
    managedSkills: [],
  };
}

/**
 * 加载 store。损坏或未知版本时保留原文件并拒绝读写，避免静默重置。
 * 返回 { store, corrupted }。
 */
export async function loadStore(storePath: string): Promise<{ store: Store; corrupted: boolean }> {
  let text: string;
  try {
    text = await readFile(storePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return { store: emptyStore(), corrupted: false };
    throw err;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    const p = parsed as Partial<Store>;
    if (p.version !== STORE_VERSION) throw new Error("不支持的存储版本");
    for (const bucket of [p.knowledge, p.archive, p.proposals, p.managedSkills]) {
      if (!Array.isArray(bucket) || bucket.some(e => !e || typeof e !== "object")) throw new Error("无效的存储结构");
    }
    for (const e of [...p.knowledge!, ...p.archive!]) {
      if (typeof e.id !== "string" || typeof e.title !== "string" || typeof e.content !== "string" || !Array.isArray(e.tags) || e.tags.some(t => typeof t !== "string")) throw new Error("无效记忆条目");
    }
    if (p.handoff !== null && (!p.handoff || typeof p.handoff.title !== "string" || typeof p.handoff.content !== "string")) throw new Error("无效交接");
    for (const e of p.proposals!) if (typeof e.id !== "string" || typeof e.name !== "string" || !["new", "update", "retire"].includes(e.kind)) throw new Error("无效提案");
    for (const e of p.managedSkills!) if (typeof e.name !== "string" || !Number.isFinite(e.bytes) || e.bytes < 0) throw new Error("无效skill登记");
    const store = emptyStore();
    store.knowledge = Array.isArray(p.knowledge) ? (p.knowledge as KnowledgeEntry[]) : [];
    store.handoff = p.handoff && typeof p.handoff === "object" ? (p.handoff as Handoff) : null;
    store.archive = Array.isArray(p.archive) ? (p.archive as ArchiveEntry[]) : [];
    store.proposals = Array.isArray(p.proposals) ? (p.proposals as SkillProposal[]) : [];
    store.managedSkills = Array.isArray(p.managedSkills) ? (p.managedSkills as ManagedSkill[]) : [];
    return { store, corrupted: false };
  } catch (error) {
    // Leave the source untouched: even a second read/write must not silently reset it.
    throw new Error(`记忆文件损坏或版本不支持，已拒绝读写；请备份并修复 ${storePath}: ${String(error)}`);
  }
}

/** 原子写：tmp + fsync + rename（崩溃后 tmp 由 cleanupStaleTmp 回收）。 */
export async function persistStore(storePath: string, store: Store): Promise<void> {
  if (store.version !== STORE_VERSION) throw new Error("拒绝写入未知存储版本");
  await mkdir(dirnameOf(storePath), { recursive: true });
  const tmp = `${storePath}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  const handle = await open(tmp, "w");
  try {
    await handle.writeFile(JSON.stringify(store, null, 2) + "\n", "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, storePath);
}

/** 清理残留 tmp 文件（崩溃恢复辅助）。返回删除数量。 */
export async function cleanupStaleTmp(storePath: string, { maxAgeMs = 10 * 60 * 1000 } = {}): Promise<number> {
  const dir = dirnameOf(storePath);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return 0;
  }
  const prefix = `${basenameOf(storePath)}.tmp-`;
  let removed = 0;
  const now = Date.now();
  for (const name of entries) {
    if (!name.startsWith(prefix)) continue;
    try {
      const st = await stat(join(dir, name));
      if (now - st.mtimeMs > maxAgeMs) {
        await rm(join(dir, name), { force: true });
        removed++;
      }
    } catch {
      /* ignore */
    }
  }
  return removed;
}

function dirnameOf(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(0, i) : ".";
}

function basenameOf(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}

/* ---------------- 容量预算 ---------------- */

export function entryChars(entry: { title?: string; content?: string; tags?: string[] }): number {
  return String(entry.title ?? "").length + String(entry.content ?? "").length + (entry.tags ?? []).join(" ").length;
}

export interface BucketUsage {
  entries: number;
  chars: number;
  maxEntries: number;
  maxChars: number;
  full: boolean;
}

export interface StoreUsage {
  knowledge: BucketUsage;
  archive: BucketUsage;
  handoff: { chars: number; maxChars: number };
  proposals: { pending: number; maxPending: number };
  skills: { managed: number; bytes: number; maxManaged: number; maxTotalBytes: number };
}

export function storeUsage(store: Store, config: MemoryConfig): StoreUsage {
  const makeBucket = (items: { title?: string; content?: string; tags?: string[] }[], budget: { maxEntries: number; maxChars: number }): BucketUsage => {
    const chars = items.reduce((sum, e) => sum + entryChars(e), 0);
    return { entries: items.length, chars, maxEntries: budget.maxEntries, maxChars: budget.maxChars, full: items.length >= budget.maxEntries || chars >= budget.maxChars };
  };
  return {
    knowledge: makeBucket(store.knowledge, config.budgets.knowledge),
    archive: makeBucket(store.archive, config.budgets.archive),
    handoff: { chars: store.handoff ? entryChars(store.handoff) : 0, maxChars: config.budgets.handoff.maxChars },
    proposals: { pending: store.proposals.length, maxPending: config.budgets.proposals.maxPending },
    skills: {
      managed: store.managedSkills.length,
      bytes: store.managedSkills.reduce((s, m) => s + (Number(m.bytes) || 0), 0),
      maxManaged: config.budgets.skills.maxManaged,
      maxTotalBytes: config.budgets.skills.maxTotalBytes,
    },
  };
}

function checkBudget(store: Store, config: MemoryConfig, bucket: "knowledge" | "archive", addedChars: number, addedEntries: number): void {
  const b = config.budgets[bucket];
  const items = store[bucket];
  if (items.length + addedEntries > b.maxEntries) {
    const guidance =
      bucket === "knowledge"
        ? "请先用 project_memory_update(action:\"merge\") 合并旧条目，或 project_memory_archive 归档旧条目；archive 满时用 /memory clear archive 显式清理。"
        : "归档预算已满。请用户显式清理：/memory clear archive 或 /memory delete <归档id>（不会自动淘汰）。";
    throw new BudgetError(`${bucket} 条目数已满（${items.length}/${b.maxEntries}）。${guidance}`, bucket);
  }
  const totalChars = items.reduce((sum, e) => sum + entryChars(e), 0) + addedChars;
  if (totalChars > b.maxChars) {
    throw new BudgetError(`${bucket} 字符预算已满（约 ${totalChars}/${b.maxChars}）。请先合并/归档旧条目释放空间，勿直接重试保存。`, bucket);
  }
}

/* ---------------- 基础校验 ---------------- */

const ID_PREFIXES: Record<string, string> = { knowledge: "k", archive: "a", proposal: "p" };

export function newId(kind: string): string {
  return `${ID_PREFIXES[kind] ?? "x"}-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
}

function requireText(value: unknown, field: string, maxLen: number): string {
  if (typeof value !== "string") throw new Error(`${field} 必须是字符串`);
  const v = value.trim();
  if (!v) throw new Error(`${field} 不能为空`);
  if (v.length > maxLen) throw new Error(`${field} 过长（${v.length} > ${maxLen}），请精简`);
  return v;
}

function requireTagList(tags: unknown): string[] {
  if (tags === undefined) return [];
  if (!Array.isArray(tags)) throw new Error("tags 必须是字符串数组");
  return tags
    .map((t) => {
      if (typeof t !== "string") throw new Error("tags 元素必须是字符串");
      return t.trim().slice(0, 64);
    })
    .filter(Boolean);
}

function findIn(store: Store, bucket: "knowledge" | "archive" | "proposals", id: string): { item: Store["knowledge"][number] | undefined; index: number } {
  const list = store[bucket] as KnowledgeEntry[];
  const index = list.findIndex((e) => e.id === id);
  return { item: index >= 0 ? list[index] : undefined, index };
}

/* ---------------- 变更操作（纯函数） ---------------- */

export interface SaveInput {
  sourceRef?: string;
  title: string;
  content: string;
  tags?: string[];
  source?: "model" | "auto-fallback";
  verified?: boolean;
}

/** 保存一条项目知识。 */
export function saveKnowledge(store: Store, config: MemoryConfig, input: SaveInput): { store: Store; entry: KnowledgeEntry } {
  const t = requireText(input.title, "title", 200);
  const c = requireText(input.content, "content", 20000);
  const tg = requireTagList(input.tags);
  checkBudget(store, config, "knowledge", entryChars({ title: t, content: c, tags: tg }), 1);
  const next = structuredClone(store);
  const entry: KnowledgeEntry = {
    id: newId("knowledge"),
    kind: "knowledge",
    title: t,
    content: c,
    tags: tg,
    source: input.source ?? "model",
    verified: input.verified ?? false,
    sourceRef: input.sourceRef === undefined ? undefined : requireText(input.sourceRef, "sourceRef", 2048),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  next.knowledge.push(entry);
  return { store: next, entry };
}

export interface UpdateInput {
  action: "replace" | "merge";
  id?: string;
  ids?: string[];
  title?: string;
  content?: string;
  tags?: string[];
  note?: string;
}

/**
 * 更新知识条目：
 * - "replace": 修改单条（title/content/tags 任一，省略字段保持原值）。
 * - "merge": 将 ids（>=2）合并为新的一条；新条目 mergedFrom 保留全部来源 id。
 *   原子性：校验全部通过才修改；任一 id 不存在/重复/预算不足 → 抛错且 store 不变。
 */
export function updateKnowledge(store: Store, config: MemoryConfig, input: UpdateInput): { store: Store; entry: KnowledgeEntry } {
  if (input.action === "replace") {
    if (!input.id) throw new Error("replace 需要 id");
    const { item, index } = findIn(store, "knowledge", input.id);
    if (!item) throw new Error(`未找到知识条目 ${input.id}`);
    const old = item as KnowledgeEntry;
    const t = input.title !== undefined ? requireText(input.title, "title", 200) : old.title;
    const c = input.content !== undefined ? requireText(input.content, "content", 20000) : old.content;
    const tg = input.tags !== undefined ? requireTagList(input.tags) : old.tags;
    checkBudget(store, config, "knowledge", entryChars({ title: t, content: c, tags: tg }) - entryChars(old), 0);
    const next = structuredClone(store);
    const entry: KnowledgeEntry = { ...old, title: t, content: c, tags: tg, updatedAt: Date.now() };
    next.knowledge[index] = entry;
    return { store: next, entry };
  }
  if (input.action === "merge") {
    if (!Array.isArray(input.ids) || input.ids.length < 2) throw new Error("merge 需要 ids（至少 2 个现有条目 id）");
    const t = requireText(input.title, "title", 200);
    const c = requireText(input.content, "content", 20000);
    const tg = requireTagList(input.tags);
    const picked: { item: KnowledgeEntry; index: number }[] = [];
    for (const iid of input.ids) {
      const { item, index } = findIn(store, "knowledge", iid);
      if (!item) throw new Error(`未找到知识条目 ${iid}`);
      picked.push({ item: item as KnowledgeEntry, index });
    }
    if (new Set(picked.map((x) => x.item.id)).size !== picked.length) throw new Error("merge ids 有重复");
    const removedChars = picked.reduce((s, x) => s + entryChars(x.item), 0);
    checkBudget(store, config, "knowledge", entryChars({ title: t, content: c, tags: tg }) - removedChars, 1 - picked.length);
    const next = structuredClone(store);
    for (const { index } of [...picked].sort((a, b) => b.index - a.index)) next.knowledge.splice(index, 1);
    const entry: KnowledgeEntry = {
      id: newId("knowledge"),
      kind: "knowledge",
      title: t,
      content: c,
      tags: tg,
      source: "model",
      verified: false,
      mergedFrom: [...new Set(picked.flatMap(({ item }) => [item.id, ...(item.mergedFrom ?? [])]))].slice(-64),
      sourceRefs: [...new Set(picked.flatMap(({ item }) => [item.sourceRef, ...(item.sourceRefs ?? [])]).filter((s): s is string => !!s))].slice(-32),
      note: typeof input.note === "string" && input.note.trim() ? input.note.trim().slice(0, 200) : undefined,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    next.knowledge.push(entry);
    return { store: next, entry };
  }
  throw new Error('action 必须是 "replace" 或 "merge"');
}

/**
 * 整合归档：把 knowledge 条目移入 archive（真正的整合，不是截断）。
 * - 单条：1:1 移动（保留原字段 + mergedFrom=[id]）。
 * - 多条：合并为一条归档记录，内容含各来源全文，mergedFrom 保留来源 id，note 为整合说明。
 * archive 满 → 拒绝（指引显式清理命令），不自动淘汰。
 */
export function archiveKnowledge(store: Store, config: MemoryConfig, { ids, note }: { ids: string[]; note?: string }): { store: Store; entry: ArchiveEntry } {
  if (!Array.isArray(ids) || ids.length < 1) throw new Error("archive 需要 ids（至少 1 个知识条目 id）");
  const picked: { item: KnowledgeEntry; index: number }[] = [];
  for (const iid of ids) {
    const { item, index } = findIn(store, "knowledge", iid);
    if (!item) throw new Error(`未找到知识条目 ${iid}`);
    picked.push({ item: item as KnowledgeEntry, index });
  }
  if (new Set(picked.map((x) => x.item.id)).size !== picked.length) throw new Error("ids 有重复");
  const noteText = typeof note === "string" && note.trim() ? note.trim().slice(0, 500) : undefined;
  const mergedFrom = [...new Set(picked.flatMap(({ item }) => [item.id, ...(item.mergedFrom ?? [])]))].slice(-64);
  let archiveEntry: ArchiveEntry;
  if (picked.length === 1) {
    const it = picked[0].item;
    archiveEntry = {
      id: newId("archive"),
      kind: "archive",
      title: it.title,
      content: it.content,
      tags: it.tags,
      source: it.source,
      verified: it.verified,
      sourceRef: it.sourceRef,
      sourceRefs: it.sourceRefs,
      mergedFrom,
      note: noteText,
      archivedAt: Date.now(),
    };
  } else {
    archiveEntry = {
      id: newId("archive"),
      kind: "archive",
      title: `归档整合：${picked.map((x) => x.item.title).join("；").slice(0, 200)}`,
      content: picked.map((x) => `### ${x.item.title}\n${x.item.content}`).join("\n\n"),
      tags: [...new Set(picked.flatMap((x) => x.item.tags))],
      source: "model",
      verified: false,
      sourceRefs: [...new Set(picked.flatMap(({ item }) => [item.sourceRef, ...(item.sourceRefs ?? [])]).filter((s): s is string => !!s))].slice(-32),
      mergedFrom,
      note: noteText,
      archivedAt: Date.now(),
    };
  }
  checkBudget(store, config, "archive", entryChars(archiveEntry), 1);
  const next = structuredClone(store);
  for (const { index } of [...picked].sort((a, b) => b.index - a.index)) next.knowledge.splice(index, 1);
  next.archive.push(archiveEntry);
  return { store: next, entry: archiveEntry };
}

/** 保存工作交接（单条覆盖式，bounded）。超长直接拒绝并要求精简。 */
export function saveHandoff(store: Store, config: MemoryConfig, input: SaveInput): { store: Store; entry: Handoff } {
  const t = requireText(input.title, "title", 200);
  if (t.length >= config.budgets.handoff.maxChars) throw new BudgetError("handoff 标题超过容量，请精简", "handoff");
  const c = requireText(input.content, "content", config.budgets.handoff.maxChars - t.length);
  const next = structuredClone(store);
  const entry: Handoff = {
    title: t,
    content: c,
    source: input.source ?? "model",
    verified: input.verified ?? false,
    sourceRef: input.sourceRef === undefined ? undefined : requireText(input.sourceRef, "sourceRef", 2048),
    updatedAt: Date.now(),
  };
  next.handoff = entry;
  return { store: next, entry };
}

/**
 * 退出兜底：仅当 store 中完全没有 handoff 时，用最近一条用户消息生成
 * 标记为「原始、未核实」的兜底交接。已有显式 handoff 时绝不覆盖。
 */
export function makeFallbackHandoff(store: Store, config: MemoryConfig, lastUserText: string): { store: Store; created: boolean } {
  if (store.handoff) return { store, created: false };
  const text = String(lastUserText ?? "").trim();
  if (!text) return { store, created: false };
  const title = "自动兜底交接（未核实，仅原始记录）";
  const prefix = "未核实的最后用户消息摘录：\n";
  const cap = config.budgets.handoff.maxChars - title.length - prefix.length;
  if (cap < 1) return { store, created: false };
  const clipped = text.length > cap && cap >= 4 ? text.slice(0, cap - 4) + "[截断]" : text.slice(0, cap);
  const next = structuredClone(store);
  next.handoff = {
    title,
    content: prefix + clipped,
    source: "auto-fallback",
    verified: false,
    updatedAt: Date.now(),
  };
  return { store: next, created: true };
}

/* ---------------- 提案（skill 草稿只存 JSON，审批前不落盘） ---------------- */

export interface ProposalInput {
  kind: "new" | "update" | "retire";
  name: string;
  description?: string;
  content?: string;
}

export function addProposal(store: Store, config: MemoryConfig, input: ProposalInput): { store: Store; proposal: SkillProposal } {
  if (!["new", "update", "retire"].includes(input.kind)) throw new Error('kind 必须是 "new" | "update" | "retire"');
  if (store.proposals.length >= config.budgets.proposals.maxPending) {
    throw new BudgetError(
      `待审批提案数已满（${store.proposals.length}/${config.budgets.proposals.maxPending}）。请先 /memory approve 或 /memory reject 处理现有提案。`,
      "proposals",
    );
  }
  const name = requireText(input.name, "name", 64);
  let desc: string | undefined;
  let body: string | undefined;
  if (input.kind === "retire") {
    const managed = store.managedSkills.find((m) => m.name === name);
    if (!managed) throw new Error(`skill "${name}" 不是本扩展已发布的 skill，无法提交退休提案`);
  } else {
    if (input.kind === "update") {
      const managed = store.managedSkills.find((m) => m.name === name);
      if (!managed) throw new Error(`skill "${name}" 不是本扩展已发布的 skill，无法提交更新提案；新 skill 请用 kind "new"`);
    }
    desc = requireText(input.description, "description", 1024).replace(/\s*\n\s*/g, " ");
    body = requireText(input.content, "content", 20000);
  }
  const proposal: SkillProposal = {
    id: newId("proposal"),
    kind: input.kind,
    name,
    description: desc,
    content: body,
    status: "pending",
    createdAt: Date.now(),
  };
  const next = structuredClone(store);
  next.proposals.push(proposal);
  return { store: next, proposal };
}

export function removeProposal(store: Store, id: string): { store: Store } {
  const i = store.proposals.findIndex((p) => p.id === id);
  if (i < 0) throw new Error(`未找到提案 ${id}`);
  const next = structuredClone(store);
  next.proposals.splice(i, 1);
  return { store: next };
}

export function removeEntry(store: Store, bucket: "knowledge" | "archive" | "proposals", id: string): { store: Store } {
  const i = (store[bucket] as { id: string }[]).findIndex((e) => e.id === id);
  if (i < 0) throw new Error(`未找到 ${bucket} 条目 ${id}`);
  const next = structuredClone(store);
  (next[bucket] as { id: string }[]).splice(i, 1);
  return { store: next };
}

export function clearBucket(store: Store, bucket: "knowledge" | "archive" | "proposals"): { store: Store } {
  const next = structuredClone(store);
  (next[bucket] as unknown[]) = [];
  return { store: next };
}

/* ---------------- 已发布 skill 清单（bounded：数量 + 总字节） ---------------- */

/** 登记/更新已发布 skill。预算不足时抛 BudgetError（先退休旧 skill 或精简内容）。 */
export function registerManagedSkill(store: Store, config: MemoryConfig, { name, bytes, sha256 }: { name: string; bytes: number; sha256?: string }): { store: Store } {
  if (sha256 !== undefined && !/^[a-f0-9]{64}$/.test(sha256)) throw new Error("Invalid skill sha256");
  const b = String(name).length > 0 ? Math.max(0, Math.floor(Number(bytes) || 0)) : 0;
  const existing = store.managedSkills.find((m) => m.name === name);
  if (existing) {
    if (storeUsage(store, config).skills.bytes - existing.bytes + b > config.budgets.skills.maxTotalBytes) throw new BudgetError("skill 总字节超限，请精简或退休旧技能", "skills");
    const next = structuredClone(store);
    next.managedSkills = next.managedSkills.map((m) => (m.name === name ? { ...m, bytes: b, sha256: sha256 ?? m.sha256, publishedAt: Date.now() } : m));
    return { store: next };
  }
  const u = storeUsage(store, config);
  if (u.skills.managed >= config.budgets.skills.maxManaged) {
    throw new BudgetError(
      `已发布 skill 数量已满（${u.skills.managed}/${config.budgets.skills.maxManaged}）。请先审批一个 retire 提案退休旧 skill。`,
      "skills",
    );
  }
  if (u.skills.bytes + b > config.budgets.skills.maxTotalBytes) {
    throw new BudgetError(
      `已发布 skill 总字节超限（约 ${u.skills.bytes + b}/${config.budgets.skills.maxTotalBytes}）。请精简内容或先退休旧 skill。`,
      "skills",
    );
  }
  const next = structuredClone(store);
  next.managedSkills.push({ name, bytes: b, sha256, publishedAt: Date.now() });
  return { store: next };
}

export function unregisterManagedSkill(store: Store, name: string): { store: Store } {
  const i = store.managedSkills.findIndex((m) => m.name === name);
  if (i < 0) return { store };
  const next = structuredClone(store);
  next.managedSkills.splice(i, 1);
  return { store: next };
}

/* ---------------- 锁（进程内互斥 + 跨进程 mkdir 锁） ---------------- */

const inProcessLocks = new Map<string, Promise<void>>();

export interface LockOptions {
  staleMs?: number;
  waitMs?: number;
  pollMs?: number;
}

async function acquireCrossProcess(lockDir: string, { staleMs = 15000, waitMs = 8000, pollMs = 60 }: LockOptions = {}): Promise<string> {
  // 锁目录的父目录可能尚不存在（首次写入前）
  await mkdir(dirnameOf(lockDir), { recursive: true }).catch(() => {});
  const started = Date.now();
  for (;;) {
    let held = false;
    try {
      await stat(lockDir);
      held = true;
    } catch {
      held = false;
    }
    if (!held) {
      try {
        await mkdir(lockDir); // 原子抢占
        const token = randomBytes(16).toString("hex");
        try {
          await writeFile(join(lockDir, "pid.json"), JSON.stringify({ pid: process.pid, token, at: Date.now() }), "utf8");
        } catch (error) {
          await rm(lockDir, { recursive: true, force: true });
          throw error;
        }
        return token;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code !== "EEXIST" && code !== "EPERM" && code !== "EACCES") throw err; // 真实 IO 错误
        // 竞态：别人先创建了 → 走下方等待逻辑
      }
    }
    let stale = false;
    try {
      const st = await stat(lockDir);
      stale = Date.now() - st.mtimeMs > staleMs;
    } catch {
      stale = false;
    }
    if (stale) {
      // Never steal a lock with an owner record: long I/O is not proof of death.
      // A crashed owner requires explicit operator cleanup after checking no writer remains.
      try { await readFile(join(lockDir, "pid.json"), "utf8"); stale = false; } catch { /* legacy ownerless lock */ }
      if (stale) {
        await rm(lockDir, { recursive: true, force: true }).catch(() => {});
        continue;
      }
    }
    if (Date.now() - started > waitMs) {
      throw new Error(`获取 store 锁超时（${waitMs}ms），可能有其他 pi 实例正在写入；请稍后重试`);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

async function releaseCrossProcess(lockDir: string, token: string): Promise<void> {
  try {
    const owner = JSON.parse(await readFile(join(lockDir, "pid.json"), "utf8"));
    if (owner.token === token && owner.pid === process.pid) await rm(lockDir, { recursive: true, force: true });
  } catch { /* Do not remove another owner's lock. */ }
}

/**
 * 串行化对同一 store 的「读-改-写」窗口：
 * - 进程内：按 storePath 排队（同一 pi 会话内并行工具调用）。
 * - 跨进程：mkdir 原子锁 + 过期回收（多个 pi 实例/子进程同项目）。
 */
export async function withStoreLock<T>(storePath: string, fn: () => Promise<T> | T, options: LockOptions = {}): Promise<T> {
  const prev = inProcessLocks.get(storePath) ?? Promise.resolve();
  let releaseSelf!: () => void;
  const gate = new Promise<void>((r) => (releaseSelf = r));
  inProcessLocks.set(storePath, prev.then(() => gate));
  await prev;
  try {
    const lockDir = `${storePath}.lock`;
    const token = await acquireCrossProcess(lockDir, options);
    try {
      return await fn();
    } finally {
      await releaseCrossProcess(lockDir, token);
    }
  } finally {
    releaseSelf();
  }
}

/**
 * 在锁内完成「加载 → 变更 → 原子持久化」。
 * mutator(store) 必须返回 { store: 新 Store, ...extras }。
 * 返回 { ...extras, corrupted, path }。
 */
export async function mutateStore<T extends { store: Store }>(
  storePath: string,
  mutator: (store: Store) => T | Promise<T>,
  config: MemoryConfig,
  options: LockOptions = {},
): Promise<Omit<T, "store"> & { corrupted: boolean; path: string }> {
  return withStoreLock(storePath, async () => {
    const { store, corrupted } = await loadStore(storePath);
    const result = await mutator(store);
    if (!result || typeof result !== "object" || !(result as { store?: unknown }).store) throw new Error("mutator 必须返回 { store }");
    await persistStore(storePath, result.store);
    const { store: _savedStore, ...extras } = result;
    void _savedStore;
    return { ...extras, corrupted, path: storePath } as Omit<T, "store"> & { corrupted: boolean; path: string };
  }, options);
}
