/**
 * src/search.ts — 轻量中文/英文混合搜索（纯函数，零依赖，可独立测试）。
 *
 * 策略：
 * - 查询按空白拆词；中英混杂词进一步拆成 CJK 块与拉丁块。
 * - 拉丁词：小写子串匹配（标题权重最高）。
 * - CJK 词：整短语命中给高分；未完整命中时按字符 bigram 命中率给部分分。
 * 确定性打分，无随机、无外部依赖、无分词器。
 */

export interface EntryLike {
  id?: string;
  title: string;
  content: string;
  tags?: string[];
}

export interface SearchResult<T extends EntryLike> {
  entry: T;
  score: number;
  matchedIn: string[];
}

const CJK_RANGES: Array<[number, number]> = [
  [0x3400, 0x4dbf], // CJK Ext A
  [0x4e00, 0x9fff], // CJK Unified
  [0xf900, 0xfaff], // CJK Compatibility
  [0x3040, 0x30ff], // 假名
  [0xac00, 0xd7af], // 谚文
];

const CJK_CLASS_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/;

export function isCJKCodePoint(cp: number): boolean {
  for (const [lo, hi] of CJK_RANGES) if (cp >= lo && cp <= hi) return true;
  return false;
}

/** 提取文本中的 CJK 字符连续块。 */
export function cjkRuns(text: string): string[] {
  const runs: string[] = [];
  let cur = "";
  for (const ch of String(text ?? "")) {
    if (isCJKCodePoint(ch.codePointAt(0) ?? 0)) cur += ch;
    else {
      if (cur) runs.push(cur);
      cur = "";
    }
  }
  if (cur) runs.push(cur);
  return runs;
}

/** 生成 bigram 集合（长度 1 的 run 退化为单字）。 */
export function cjkGrams(text: string): Set<string> {
  const set = new Set<string>();
  for (const run of cjkRuns(text)) {
    if (run.length === 1) {
      set.add(run);
      continue;
    }
    for (let i = 0; i + 2 <= run.length; i++) set.add(run.slice(i, i + 2));
  }
  return set;
}

export interface QueryTerm {
  text: string;
  kind: "cjk" | "latin";
  grams: string[];
}

/** 查询拆词。 */
export function tokenizeQuery(query: string): QueryTerm[] {
  const terms: QueryTerm[] = [];
  for (const raw of String(query ?? "").split(/\s+/)) {
    if (!raw) continue;
    const latinParts = raw.split(CJK_CLASS_RE);
    for (const part of latinParts) {
      const word = part.trim().toLowerCase();
      if (word) terms.push({ text: word, kind: "latin", grams: [] });
    }
    for (const run of cjkRuns(raw)) terms.push({ text: run, kind: "cjk", grams: [...cjkGrams(run)] });
  }
  return terms;
}

function lower(text: unknown): string {
  return String(text ?? "").toLowerCase();
}

/** 对单个条目打分。标题权重最高，其次 tags，最后正文。 */
export function scoreEntry(entry: EntryLike, terms: QueryTerm[]): { score: number; matchedIn: Set<string> } {
  if (!terms.length) return { score: 0, matchedIn: new Set() };
  const title = lower(entry.title);
  const content = lower(entry.content);
  const tags = lower((entry.tags ?? []).join(" "));

  let score = 0;
  const matchedIn = new Set<string>();
  for (const term of terms) {
    if (term.kind === "latin") {
      if (title.includes(term.text)) {
        score += 8;
        matchedIn.add("title");
      }
      if (tags.includes(term.text)) {
        score += 6;
        matchedIn.add("tags");
      }
      if (content.includes(term.text)) {
        score += 4;
        matchedIn.add("content");
      }
      continue;
    }
    if (title.includes(term.text)) {
      score += 12;
      matchedIn.add("title");
    }
    const fullContent = content.includes(term.text);
    if (fullContent) {
      score += 8;
      matchedIn.add("content");
    }
    if (tags.includes(term.text)) {
      score += 6;
      matchedIn.add("tags");
    }
    if (!fullContent && term.grams.length > 0) {
      let hits = 0;
      for (const g of term.grams) if (content.includes(g)) hits++;
      if (hits > 0) {
        score += (hits / term.grams.length) * 3;
        matchedIn.add("content");
      }
    }
  }
  return { score, matchedIn };
}

/** 搜索条目列表；返回按分数降序、score>0、最多 limit 条。 */
export function searchEntries<T extends EntryLike>(entries: T[], query: string, { limit = 8 }: { limit?: number } = {}): SearchResult<T>[] {
  const terms = tokenizeQuery(query);
  if (!terms.length) return [];
  const cap = Math.max(1, Math.min(50, Math.floor(limit) || 8));
  const results: SearchResult<T>[] = [];
  for (const entry of entries) {
    const { score, matchedIn } = scoreEntry(entry, terms);
    if (score > 0) results.push({ entry, score, matchedIn: [...matchedIn] });
  }
  results.sort((a, b) => b.score - a.score || String(a.entry.id ?? "").localeCompare(String(b.entry.id ?? "")));
  return results.slice(0, cap);
}

/** 截取包含首个命中位置的上下文片段（用于展示）。 */
export function snippetAround(text: string, query: string, { width = 120 }: { width?: number } = {}): string {
  const s = String(text ?? "");
  const lowerS = s.toLowerCase();
  const terms = tokenizeQuery(query);
  let idx = -1;
  for (const term of terms) {
    const i = lowerS.indexOf(term.text.toLowerCase());
    if (i >= 0 && (idx < 0 || i < idx)) idx = i;
  }
  if (idx < 0) return s.slice(0, width);
  const start = Math.max(0, idx - Math.floor(width / 2));
  const end = Math.min(s.length, start + width);
  return (start > 0 ? "…" : "") + s.slice(start, end).replace(/\s+/g, " ") + (end < s.length ? "…" : "");
}
