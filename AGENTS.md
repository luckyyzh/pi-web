# AGENTS.md — pi-web（luckyyzh fork）

本仓库是 [agegr/pi-web](https://github.com/agegr/pi-web) 的带私有修改 fork（Next.js 16 + React 19，Node ≥ 22.19），为 pi coding agent 提供 Web 界面。本文件是给 AI 编码代理的执行纪律，优先级高于通用习惯。

## 最高优先级：LLM 前缀缓存命中

用户对**缓存命中率**（`cacheRead / (input + cacheRead)`）非常敏感。任何改动如果可能改变发给 LLM 的请求前缀字节，必须先评估缓存影响，默认选择保缓存的方案。

### 前缀缓存的字节一致性规则

1. **system prompt 前缀不可动**：system prompt 的开头字节决定前缀缓存命中。禁止在 system prompt 前部插入时间戳、随机 ID、会话变量、动态内容。动态内容只能**追加**在 system prompt 尾部，且追加内容本身也要稳定（同一会话内不变）。
2. **消息历史不可重排/改写**：不得对历史消息做重排、截断、改写、重新序列化。压缩（compaction）是唯一允许改写历史的机制，且必须走 `session_before_compact` 扩展路径。
3. **thinkingLevel / reasoning 档位影响 wire 字节**：qwen 等 chat template 中 `enable_thinking` / `reasoning_effort` 会改变 system 块开头字节。切换档位会使前缀缓存失效——涉及档位跟随/覆盖的逻辑（如 `compaction-extension.ts` 缓存对齐模式）必须保持与会话当前档位一致，除非有明确理由。
4. **工具定义（tools）也是前缀的一部分**：新增/删除/重排工具、改工具描述文本，都会使前缀失效。工具列表的注册顺序保持稳定；新增工具优先追加在列表尾部。
5. **缓存对齐压缩（cacheAligned）**：`lib/compaction-extension.ts` 的缓存对齐模式依赖「压缩请求前缀 = 会话最近一次请求前缀」命中服务端 APC（vLLM 等）。改动该路径时必须保证：复用会话原 system prompt、字节一致的完整历史、尾部只追加一条摘要指令、thinkingLevel 跟随会话。任何破坏字节一致性的改动都要回退到常规压缩路径（返回 undefined 回退），不得静默发出前缀不一致的请求。
6. **persona 注入**：`persona-injector` 扩展每轮注入 `~/.pi/agent/persona.md`。persona 内容变化会使后续请求前缀失效一次（可接受），但注入位置必须在 system prompt 尾部，不得插入前部。
7. **评估清单**（改动涉及 LLM 请求构造时逐条过）：
   - [ ] 是否改变了 system prompt 前部字节？
   - [ ] 是否改变了历史消息序列或内容？
   - [ ] 是否改变了工具列表的顺序/内容？
   - [ ] 是否改变了 thinkingLevel / reasoning 的取值来源？
   - [ ] 新增的动态内容是否只在尾部且会话内稳定？

## 架构纪律：兼容、可插拔、低耦合

### 模块边界

- **`lib/`**：后端逻辑（Node）。每个功能一个文件 + 同名 `.test.mjs`。纯逻辑模块不 import `app/` 或 `components/`。
- **`app/api/`**：HTTP 路由，只做请求校验 + 调用 `lib/` + 返回 JSON。不在路由里写业务逻辑。
- **`components/` / `hooks/`**：前端。通过 `lib/agent-client.ts` 的 `sendAgentCommand` 访问后端，不直接拼 fetch。
- **`vendor/`**：内嵌扩展副本（ssh、searxng-search、describe-image），离线安装用。不修改 vendor 内代码，改动走配套扩展仓库 `luckyyzh/pi-web-extensions`。

### 可插拔：扩展优先

- 新功能优先做成 **InlineExtension**（`extensionFactories` 注册，见 `lib/rpc-manager.ts`、`lib/subagent-runtime.ts`），而不是改核心会话流程。参考 `compaction-extension.ts`、`subagent-extension.ts`、`remote-agent.ts` 的写法。
- 扩展必须**可关闭、可回退**：配置缺失/非法时不干预（走内置默认），失败时返回 undefined 回退常规路径并 `ctx.ui.notify` 警告，不得抛异常中断会话。
- 配置统一放 `~/.pi/agent/*.json`（如 `compaction-settings.json`），读取函数必须容错：文件缺失/损坏/字段非法 → 返回默认值。新增配置字段必须向后兼容（旧文件缺字段 = 默认值）。

### 兼容性

- **上游同步**：本 fork 定期 merge `upstream/main`（`sync-upstream.cmd`）。私有改动尽量集中在独立文件/独立扩展，减少 merge 冲突；`README.md` 已标记 `merge=ours` 永远保留本版。
- **接口兼容**：`/api/agent/[id]` 的 `{ success, data } / { error, code, accepted }` 契约、`sendAgentCommand` 的调用约定不得破坏。新增 API 字段用可选字段，不删不改已有字段语义。
- **会话文件兼容**：`~/.pi/agent/sessions/` 下的会话 JSONL 是 pi 上游格式，不得写入私有字段到消息结构里；私有元数据走独立文件（参考 `remote-workspace.ts` 的 metadata 目录模式）。
- **影子目录 key 稳定**：`~/.pi/remote/<host>_<hash>` 的 id 算法（`remoteWorkspaceId`）不得变更，变更会孤儿化已有远程会话。

### 低耦合

- 模块间通过**窄接口**通信：传数据对象/回调，不传整个 manager/context 再到处取属性。
- 禁止跨功能模块直接 import 内部实现（如 `session-*.ts` 之间、`subagent-*.ts` 之间）；共享逻辑下沉到独立小模块。
- 前端状态：组件间共享状态走 `lib/` 里的纯状态模块（如 `file-tab-state.ts`、`terminal-tab-state.ts` 模式），不在组件里互相 import 内部 state。
- 新增依赖要克制：能用 Node 内置 / 已有依赖解决的，不加新包。

## 工程约定

- **测试**：`npm test`（node --test，`*.test.mjs`）。改 `lib/` 逻辑必须带对应测试；不写过度测试（不测实现细节，测行为边界）。
- **构建**：`npm run build`（next build --webpack）。改完涉及 `app/`、`components/`、`lib/`（被前端 import 的）的代码要能构建通过。
- **Lint**：`npm run lint`。
- **i18n**：用户可见文案走 `lib/i18n/messages/{en,zh-CN}.ts`，两个语言文件同步加 key，不硬编码字符串到组件。
- **ADR**：架构级决策写 `docs/adr/NNNN-*.md`（已有 3 篇，编号递增）。
- **Windows 环境**：本机是 Windows + PowerShell。shell 命令注意 PowerShell 语法（不是 bash）；路径用反斜杠或正斜杠均可，避免 bash 专属写法。
- **端口**：dev/start 固定 `127.0.0.1:30141`，不要改。

## 本 fork 的核心私有模块（改动前先看对应文件头注释）

| 模块 | 文件 | 说明 |
|---|---|---|
| 缓存对齐压缩 | `lib/compaction-extension.ts` + `lib/compaction-settings.ts` | 前缀缓存敏感区，改动必须过上面的评估清单 |
| 远程 SSH 工作区 | `lib/remote-workspace.ts`、`lib/remote-agent.ts`、`lib/ssh.ts` | 影子目录隔离，id 算法不可变 |
| 子代理 | `lib/subagent-*.ts` | 多文件协作，注意 profile 优先级 |
| persona | `lib/persona.ts` + `vendor/persona-injector` | 注入位置固定在 system prompt 尾部 |
| 内置扩展安装 | `lib/bundled-extensions.ts` | 手动触发、一次性，不强制每次启动 |
| 会话统计/缓存命中率 | `lib/session-stats.ts`、`components/AppShell.tsx` | 命中率 = cacheRead/(input+cacheRead)，口径不要改 |

## 同步上游时的纪律

1. `sync-upstream.cmd` 或 `git merge upstream/main`，README 冲突自动保留本版。
2. merge 后检查：`lib/compaction-extension.ts` 里的 prompt 常量是否与上游 `dist/core/compaction` 一致（上游措辞变化时按需同步，保持逐字一致）。
3. 上游升级 `@earendil-works/pi-*` 版本后，跑 `npm test` + `npm run build`，重点回归压缩路径和远程工作区。
4. 不主动 rebase 私有提交；冲突解决优先保留 fork 行为。
