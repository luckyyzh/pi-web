import type { Store, KnowledgeEntry, ArchiveEntry } from "./store.ts";

export interface Ui {
  select(title: string, options: string[]): Promise<string | undefined>;
}

export type LoadStore = () => Promise<Store>;

type Group = "knowledge" | "handoff" | "archive" | "proposals";
type Listed = { id: string; title: string };

const CLOSE = "关闭";
const BACK = "返回";
const PREV = "上一页";
const NEXT = "下一页";
const APPROVE = "审批此提案";
const PAGE_SIZE = 10;
const TEXT_PAGE_SIZE = 4000;

function groups(store: Store): { label: string; group: Group }[] {
  return [
    { label: `知识 (${store.knowledge.length})`, group: "knowledge" },
    { label: `交接 (${store.handoff ? 1 : 0})`, group: "handoff" },
    { label: `归档 (${store.archive.length})`, group: "archive" },
    { label: `待审批 skill (${store.proposals.length})`, group: "proposals" },
  ];
}

function listed(store: Store, group: Group): Listed[] {
  if (group === "handoff") return store.handoff ? [{ id: "handoff", title: store.handoff.title }] : [];
  if (group === "proposals") return store.proposals.map((item) => ({ id: item.id, title: item.name }));
  return store[group].map((item) => ({ id: item.id, title: item.title }));
}

function detail(store: Store, group: Group, id: string): string | undefined {
  if (group === "handoff") {
    const item = store.handoff;
    return item ? `${item.title}\n\n${item.content}` : undefined;
  }
  if (group === "proposals") {
    const item = store.proposals.find((entry) => entry.id === id);
    if (!item) return undefined;
    return [
      item.name,
      `id: ${item.id}`,
      `类型: ${item.kind}`,
      item.description ? `描述: ${item.description}` : "",
      item.content ?? "",
    ].filter(Boolean).join("\n\n");
  }
  const item = (store[group] as (KnowledgeEntry | ArchiveEntry)[]).find((entry) => entry.id === id);
  return item ? `${item.title}\n\nid: ${item.id}\n\n${item.content}` : undefined;
}

async function showDetail(ui: Ui, load: LoadStore, group: Group, id: string): Promise<string | "back" | undefined> {
  let page = 0;
  for (;;) {
    const text = detail(await load(), group, id);
    if (text === undefined) {
      const choice = await ui.select("已不存在", [BACK, CLOSE]);
      if (choice === undefined || choice === CLOSE) return undefined;
      return "back";
    }
    const pages = Math.max(1, Math.ceil(text.length / TEXT_PAGE_SIZE));
    page = Math.min(page, pages - 1);
    const title = text.slice(page * TEXT_PAGE_SIZE, (page + 1) * TEXT_PAGE_SIZE);
    const options: string[] = [];
    if (page > 0) options.push(PREV);
    if (page + 1 < pages) options.push(NEXT);
    if (group === "proposals") options.push(APPROVE);
    options.push(BACK, CLOSE);
    const choice = await ui.select(title, options);
    if (choice === undefined || choice === CLOSE) return undefined;
    if (choice === BACK) return "back";
    if (choice === PREV) page--;
    else if (choice === NEXT) page++;
    else if (choice === APPROVE && group === "proposals") return id;
  }
}

async function browseGroup(ui: Ui, load: LoadStore, group: Group): Promise<string | "back" | undefined> {
  let page = 0;
  for (;;) {
    const items = listed(await load(), group);
    const pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
    page = Math.min(page, pages - 1);
    const slice = items.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
    const mapped = slice.map((item, index) => ({
      label: `${page * PAGE_SIZE + index + 1}. ${item.title} [${item.id}]`,
      id: item.id,
    }));
    const options = mapped.map((item) => item.label);
    if (page > 0) options.push(PREV);
    if (page + 1 < pages) options.push(NEXT);
    options.push(BACK, CLOSE);
    const choice = await ui.select(`${groups(await load()).find((entry) => entry.group === group)!.label}${items.length ? ` · ${page + 1}/${pages}` : " · 空"}`, options);
    if (choice === undefined || choice === CLOSE) return undefined;
    if (choice === BACK) return "back";
    if (choice === PREV) { page--; continue; }
    if (choice === NEXT) { page++; continue; }
    const picked = mapped.find((entry) => entry.label === choice);
    if (!picked) continue;
    const result = await showDetail(ui, load, group, picked.id);
    if (typeof result === "string" && result !== "back") return result;
    if (result === undefined) return undefined;
  }
}

export async function browseMemory(ui: Ui, load: LoadStore): Promise<string | undefined> {
  for (;;) {
    const choices = groups(await load());
    const selected = await ui.select("项目记忆（只读）", [...choices.map((entry) => entry.label), CLOSE]);
    if (selected === undefined || selected === CLOSE) return undefined;
    const group = choices.find((entry) => entry.label === selected)?.group;
    if (!group) continue;
    const result = await browseGroup(ui, load, group);
    if (typeof result === "string" && result !== "back") return result;
    if (result === undefined) return undefined;
  }
}

export async function pickProposal(ui: Ui, load: LoadStore): Promise<string | undefined> {
  let page = 0;
  for (;;) {
    const proposals = (await load()).proposals;
    if (proposals.length === 0) {
      await ui.select("没有待审批的 skill 提案（只读）", [CLOSE]);
      return undefined;
    }
    const pages = Math.ceil(proposals.length / PAGE_SIZE);
    page = Math.min(page, pages - 1);
    const mapped = proposals.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((p, index) => ({
      label: `${page * PAGE_SIZE + index + 1}. ${p.name} (${p.kind}) [${p.id}]`, id: p.id,
    }));
    const options = [...mapped.map(item => item.label), ...(page > 0 ? [PREV] : []), ...(page + 1 < pages ? [NEXT] : []), CLOSE];
    const choice = await ui.select(`选择待审批 skill 提案 · ${page + 1}/${pages}（选择后仍需确认）`, options);
    if (choice === undefined || choice === CLOSE) return undefined;
    if (choice === PREV) { page--; continue; }
    if (choice === NEXT) { page++; continue; }
    return mapped.find(item => item.label === choice)?.id;
  }
}
