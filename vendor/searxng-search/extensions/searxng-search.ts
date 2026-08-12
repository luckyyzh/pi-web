/**
 * searxng-search.ts
 *
 * 全局扩展：通过自建 SearXNG 端点提供网络搜索能力
 * 描述：使用私有 SearXNG 实例（GET /search-api/search + X-Search-Token）的 web_search 工具
 *
 * 接入契约（与你的服务端一致）：
 *   端点  GET https://llm-local.cloud/search-api/search
 *   鉴权  HTTP 头 X-Search-Token: <token>（token 读环境变量 SEARXNG_TOKEN）
 *   参数  q(必填) format=json(固定) engines/language/pageno/time_range(可选)
 *   返回  { results: [{ title, url, content, engine, score }], ... }
 *
 * 安装：放到 ~/.pi/agent/extensions/，然后 /reload 或新开会话。
 * 环境变量：SEARXNG_URL（默认 https://llm-local.cloud/search-api/search）、SEARXNG_TOKEN
 * 也可用 /web-search config 持久化 url/token（覆盖环境变量）。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Type } from "typebox";

// ============================================================================
// 常量与配置
// ============================================================================
const DEFAULT_URL = "https://llm-local.cloud/search-api/search";
const CONFIG_PATH = join(homedir(), ".pi", "agent", "searxng-config.json");
const REQUEST_TIMEOUT_MS = 20_000; // 服务端抓取超时 10s，客户端留 20s

interface SearchConfig {
  url?: string;
  token?: string;
}

function loadConfig(): SearchConfig {
  let file: Partial<SearchConfig> = {};
  try {
    if (existsSync(CONFIG_PATH)) file = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    file = {};
  }
  return {
    url: file.url ?? process.env.SEARXNG_URL ?? DEFAULT_URL,
    token: file.token ?? process.env.SEARXNG_TOKEN,
  };
}

function saveConfig(partial: Partial<SearchConfig>): SearchConfig {
  const next: SearchConfig = { ...loadConfig(), ...partial };
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), "utf8");
  return next;
}

// ============================================================================
// 网络请求（尊重 HTTP(S)_PROXY 环境变量）
// ============================================================================
async function createFetch(): Promise<typeof fetch> {
  const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  if (!proxy) return fetch;
  try {
    const { ProxyAgent, setGlobalDispatcher } = await import("undici");
    setGlobalDispatcher(new ProxyAgent(proxy));
  } catch {
    /* 忽略：无 undici 则用裸 fetch */
  }
  return fetch;
}

// ============================================================================
// 调用 SearXNG
// ============================================================================
interface SearchParams {
  query: string;
  engines?: string;
  language?: string;
  pageno?: number;
  timeRange?: string;
  maxResults: number;
}

interface SearchResult {
  title?: string;
  url?: string;
  content?: string;
  engine?: string;
}

async function search(cfg: SearchConfig, p: SearchParams): Promise<SearchResult[]> {
  if (!cfg.token) {
    throw new Error("未设置 SEARXNG_TOKEN（可 export SEARXNG_TOKEN=... 或用 /web-search config token <token>）");
  }
  const params = new URLSearchParams({
    q: p.query,
    format: "json",
  });
  if (p.engines) params.set("engines", p.engines);
  if (p.language) params.set("language", p.language);
  if (p.pageno && p.pageno > 1) params.set("pageno", String(p.pageno));
  if (p.timeRange) params.set("time_range", p.timeRange);

  const fetchImpl = await createFetch();
  const base = (cfg.url ?? DEFAULT_URL).replace(/\/+$/, "");
  const res = await fetchImpl(`${base}?${params.toString()}`, {
    headers: { "X-Search-Token": cfg.token, Accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (res.status === 401) throw new Error("鉴权失败：X-Search-Token 缺失或错误（HTTP 401）");
  if (!res.ok) throw new Error(`SearXNG 请求失败 HTTP ${res.status}`);

  const json = (await res.json()) as { results?: unknown[] };
  const results = Array.isArray(json.results) ? json.results : [];
  return results
    .map((r) => {
      const item = r as Record<string, unknown>;
      return {
        title: typeof item.title === "string" ? item.title : "",
        url: typeof item.url === "string" ? item.url : "",
        content:
          (typeof item.content === "string" ? item.content : "") ||
          (typeof item.snippet === "string" ? item.snippet : ""),
        engine: typeof item.engine === "string" ? item.engine : "",
      };
    })
    .filter((r) => r.title || r.url || r.content)
    .slice(0, p.maxResults);
}

function formatResults(results: SearchResult[]): string {
  if (results.length === 0) return "（无搜索结果，可尝试换关键词或指定 engines）";
  return results
    .map((r, i) => {
      const lines = [`${i + 1}. ${r.title || "(无标题)"}`];
      if (r.url) lines.push(`   URL: ${r.url}`);
      if (r.content) lines.push(`   ${r.content.slice(0, 300)}`);
      if (r.engine) lines.push(`   engine: ${r.engine}`);
      return lines.join("\n");
    })
    .join("\n\n");
}

// ============================================================================
// 扩展主体
// ============================================================================
export default function (pi: ExtensionAPI) {
  // ---------- 工具：web_search（模型可调用） ----------
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "通过私有 SearXNG 实例搜索互联网，返回标题/链接/摘要/引擎。用于获取最新信息、查文档、找资料。",
    promptSnippet: "Search the internet via a private SearXNG instance; returns title/link/snippet/engine",
    parameters: Type.Object({
      query: Type.String({ description: "搜索关键词" }),
      engines: Type.Optional(Type.String({
        description: "指定引擎，逗号分隔，可选：google,bing,duckduckgo,wikipedia,github。不填则全部并发查询",
      })),
      language: Type.Optional(Type.String({ description: "语言，如 zh-CN、en" })),
      timeRange: Type.Optional(Type.Union([
        Type.Literal("day"),
        Type.Literal("week"),
        Type.Literal("month"),
        Type.Literal("year"),
      ], { description: "时间范围（可选）" })),
      pageno: Type.Optional(Type.Number({ description: "页码，默认 1" })),
      maxResults: Type.Optional(Type.Number({ description: "返回条数上限（默认 8，最大 20）" })),
    }),
    async execute(_toolCallId, params: {
      query: string;
      engines?: string;
      language?: string;
      timeRange?: "day" | "week" | "month" | "year";
      pageno?: number;
      maxResults?: number;
    }, signal, _onUpdate, _ctx) {
      try {
        if (signal?.aborted) return { content: [{ type: "text" as const, text: "已取消" }], details: {} };
        const cfg = loadConfig();
        const results = await search(cfg, {
          query: params.query,
          engines: params.engines,
          language: params.language,
          pageno: params.pageno,
          timeRange: params.timeRange,
          maxResults: Math.min(Math.max(params.maxResults ?? 8, 1), 20),
        });
        return {
          content: [{ type: "text" as const, text: formatResults(results) }],
          details: { count: results.length },
        };
      } catch (error) {
        return {
          content: [{
            type: "text" as const,
            text: `web_search 出错：${error instanceof Error ? error.message : String(error)}`,
          }],
          details: { error: true },
        };
      }
    },
  });

  // ---------- 命令：/web-search（手动测试 + 配置） ----------
  pi.registerCommand("web-search", {
    description: "SearXNG 搜索：/web-search <关键词>；/web-search config url|token <值>",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/);
      const verb = parts[0];

      if (!verb) {
        const cfg = loadConfig();
        ctx.ui.notify(
          `SearXNG 配置：\n  url:   ${cfg.url}\n  token: ${cfg.token ? "已设置(隐藏)" : "未设置"}\n` +
            `用法：/web-search <关键词> 搜索；/web-search config url <地址> 或 config token <token> 持久化`,
          "info",
        );
        return;
      }

      if (verb === "config") {
        const key = parts[1];
        const value = parts.slice(2).join(" ");
        if (key === "url" && value) {
          saveConfig({ url: value });
          ctx.ui.notify(`SEARXNG_URL 已保存：${value}`, "info");
          return;
        }
        if (key === "token" && value) {
          saveConfig({ token: value });
          ctx.ui.notify("SEARXNG_TOKEN 已保存（本地 searxng-config.json）。", "info");
          return;
        }
        ctx.ui.notify("用法：/web-search config url <地址> | config token <token>", "info");
        return;
      }

      // 直接搜索
      try {
        const cfg = loadConfig();
        const results = await search(cfg, { query: args.trim(), maxResults: 8 });
        ctx.ui.notify(`SearXNG 结果：\n${formatResults(results).slice(0, 1500)}`, "info");
      } catch (error) {
        ctx.ui.notify(`搜索失败：${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
}
