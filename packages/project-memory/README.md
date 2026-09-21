# project-memory — pi 项目记忆扩展（项目知识 + 工作交接）

为 pi coding agent 提供**按项目隔离**的持久记忆：项目知识（架构决策、踩坑、构建/测试命令等）
与工作交接（当前任务状态），外加**需用户审批**的项目级 skill 草稿发布。

- **无全局记忆**：数据只落在当前项目的 git 仓库根下，跨项目不共享。
- **缓存友好**：不改 system prompt、不改写历史、不动态增删工具、不自动 `/reload`。
- **容量有界**：knowledge / handoff / archive / 提案 / 已发布 skill 全部有预算，满了拒绝并指引显式整合，绝不悄悄淘汰。
- **知识显式保存，压缩自动保护**：项目知识由模型主动保存；压缩自动建立原文检查点，并将原压缩摘要保存为交接。无定时学习，无额外模型调用。

## 第一版实际边界（重要）

- 长期知识保存/检索仍由模型执行：`project_memory_save` 在里程碑被模型调用（或用户要求）时发生；
  工具描述已内置「里程碑保存、任务开始检索、满容量先 merge/archive」的指引，但这不是自动记忆。
- **退出兜底不是保存保证**：进程退出（quit）时，若项目存储中完全没有交接，只写一条
  「原始、未核实」的兜底记录（最后一条用户消息的摘录，bounded）；模型没主动保存的内容不会被总结。
- 压缩前先验证原始 JSONL 与当前分支叶节点已落盘，再建立恢复检查点。失败时取消压缩（含 overflow），明确报错，不静默继续无保护压缩。正常路径不修改原压缩请求，也不额外调用模型。
- 压缩成功后复用 Pi 的压缩摘要更新有界交接，并追加一条短恢复入口消息；不覆盖检查点建立后被并发显式更新的交接。摘要有损，细节依靠原文回查。
- 新会话交接 = **一条持久自定义消息**，只在「首次启动（无续接会话）或 /new」时注入一次；
  /resume 不重复注入；不随后续保存变化。
- **远程影子工作区（pi-web `~/.pi/remote/<id>`）保守策略**：检测到 cwd 在影子目录下时，
  记忆照常工作（数据存影子目录本地，不会同步回远程仓库），但 **skill 发布被禁用**（发布到影子目录
  ≠ 发布到远程项目）。v1 不做 SSH 耦合、不改动 shadow id。
- skill 发布只写 `<项目根>/.pi/skills/<name>/SKILL.md` 单文件（不含脚本/资源文件）；
  批准**不自动 /reload**，需手动 `/reload` 或 `/new` 生效（避免破坏前缀缓存）。
- 不删除本扩展未登记的 skill；retire 只删除自己发布的 SKILL.md（目录内其他文件不受影响）。

## 安装（全局安装，全局加载）

扩展按**全局**安装/加载；记忆数据仍按项目根隔离。本仓库交付时**不会**替你安装或改配置。

方式一（推荐）：`pi install` 到全局（用户设置）：

```powershell
pi install C:\绝对路径\pi-web\packages\project-memory
```

方式二：放入全局扩展目录（目录含 `package.json` 的 `pi.extensions` 清单）：

```powershell
Copy-Item -Recurse C:\绝对路径\pi-web\packages\project-memory $env:USERPROFILE\.pi\agent\extensions\project-memory
```

安装后重启 pi（或 `/reload`）即可。卸载：`pi remove <安装源>` 并删除上述扩展目录；
项目数据在 `<项目根>/.pi/project-memory/`，按需删除。

> 全局安装后，在**未受信项目**中扩展不启用（工具报「项目未受信」）；受信项目正常加载。

## 配置

统一配置：`~/.pi/agent/project-memory.json`（缺失/损坏/字段非法 → 全部用默认值，向后兼容）。

```jsonc
{
  "enabled": true,                    // false = 整个扩展停用（工具报错提示未启用）
  "checkpoint": { "enabled": true }, // false = 关闭压缩自动保护，恢复普通压缩
  "budgets": {
    "knowledge": { "maxEntries": 100, "maxChars": 48000 },
    "handoff":   { "maxChars": 4000 },
    "archive":   { "maxEntries": 200, "maxChars": 96000 },
    "proposals": { "maxPending": 10 },
    "skills":    { "maxManaged": 20, "maxTotalBytes": 204800 }
  }
}
```

容量语义：

- **knowledge 满** → 保存被拒绝，工具提示先 `project_memory_update(action:"merge")` 合并或
  `project_memory_archive` 归档旧条目。
- **archive 满** → 归档被拒绝，提示用户显式清理（`/memory clear archive` 或 `/memory delete <id>`）。
  **active 与 archive 同时满**时，用 `/memory clear archive`（确认制）释放，避免永久锁死。
- **知识不自动淘汰**：knowledge/archive/skills 删除需用户确认。临时恢复检查点采用独立的最近8个滚动保留机制，只轮换索引/摘录，不删除Pi原会话。
- **已发布 skill** 受 `maxManaged`（个数）+ `maxTotalBytes`（总字节）双重上限，满则拒绝新发布，
  需先审批一个 retire 提案。

## 数据位置

`<git 仓库根>/.pi/project-memory/store.json`

- 在 git 仓库**子目录**启动 pi 时，数据仍归到仓库根（`git rev-parse --show-toplevel`）；
  非 git 目录则按 cwd 隔离。
- 原子写（tmp + fsync + rename）；进程内互斥 + 跨进程 mkdir 锁，等待最多 8s。只自动回收过期无主锁；带 owner 的锁不因超时被抢占。崩溃残留锁需确认没有写入进程后人工删除 `store.json.lock`。
- store.json 损坏或版本不支持时拒绝读写、保留原文件，不自动清空。请先备份再人工恢复。
- 保存附带会话文件来源；merge 保留有界的祖先 id 与会话来源（最多 64/32），不保留每个旧版本全文。模型记录默认未核实。

## 压缩恢复机制

`<项目根>/.pi/project-memory/checkpoints.json` 保存最近8个检查点，每个包含：会话路径及身份、分支叶节点、近期原文摘录（最多12,000字符）、压缩摘要副本（最多12,000字符）。不是原会话的完整备份。

流程：原始JSONL持久化校验 → 检查点原子落盘 → 原Pi压缩 → 摘要保存为交接 → 新增一条短原文回查入口。压缩失败时保留之前的检查点，不伪造成功摘要。

回查流程：`project_memory_recall(action:"list")` → `search(checkpointId,query)` → `read(checkpointId,entryId,offset)`。
- 每页最多8个搜索命中（每项600字符），原文每页最多8,000字符；使用 nextOffset 续读。
- search 为大小写不敏感的字面匹配，不是语义搜索。
- 只接受已登记检查点ID，校验会话头、项目归属和分支，不接受任意路径；不会读取其他分支的消息。
- 原文来自 Pi JSONL，包含用户/助手文本和工具调用/结果；不返回隐藏思考或图片二进制。
- 为防无界I/O，单个会话文件上限64MiB；超限、文件丢失、源项目移动或数据损坏会明确报错。无持久会话（如 --no-session）不能使用该保护，需要显式关闭 checkpoint。
- 不删除原始Pi会话；检查点轮换后，旧原文仍可用Pi的会话管理功能查看。原文被外部删除则无法恢复，需要自行备份Pi sessions目录。
- 自动交接最多4,000字符，可能截断摘要；最多保留800字符旧交接参考，不是无损整合。恢复入口负责让模型回查被省略的细节。

本版保证的是“压缩前验证可回查来源、失败明确阻止、成功后提供恢复入口”，不是保证摘要绝不遗漏，也不是保证模型每次都会主动检索。故障排除后重试 /compact；确认愿意使用普通压缩时可设 checkpoint.enabled=false 并 /reload。

## 工具（LLM 调用）

| 工具 | 作用 |
|---|---|
| `project_memory_save` | `kind:"knowledge"` 保存项目事实；`kind:"handoff"` 写工作交接（下次新会话注入）。显式、bounded、不自动学习。 |
| `project_memory_search` | 中/英文混合搜索（子串 + CJK bigram）。`scope:"active"`（默认，知识+交接）/`"all"`（含归档）。 |
| `project_memory_update` | `action:"replace"` 改单条；`action:"merge"` 多条 → 一条新记录，`mergedFrom` 保留来源 id（真正的整合，非截断；原子）。 |
| `project_memory_archive` | 整合归档：单条 1:1 移动；多条合并为一条归档记录（含来源全文 + note）。archive 满则拒绝。 |
| `project_memory_recall` | list 检查点、search 压缩前原文、read 按消息ID分页读取。只读、项目/分支隔离。 |
| `project_memory_propose_skill` | 起草项目 skill（`new`/`update`/`retire`）。草稿只存 JSON，**不落盘**；发布必须用户 `/memory approve`。影子工作区禁用。 |

## 命令（用户）

```
/memory                      # 状态面板：Web 端点击底栏 project-memory-out 展开
/memory list                 # 弹窗浏览：按分类/标题选择，无需记条目 ID
/memory checkpoints          # 列出最近压缩恢复检查点
/memory search <关键词>       # 中文/英文搜索
/memory show <id>            # 查看条目（知识/归档/提案）
/memory delete <id>          # 删除（需 UI 确认；无 UI 拒绝）
/memory clear <bucket>       # 清空 knowledge|archive|proposals（需 UI 确认）
/memory approve [pid]        # 无 pid 打开待审批选择弹窗；选择后展示全文并二次确认
/memory reject <pid>         # 拒绝（丢弃）提案
```

### 浏览 UI（无需条目 ID）

`/memory list` 使用 Pi 原生选择弹窗，支持 Pi Web 和终端交互模式：
- 先选项目知识、工作交接、归档或待审批技能，再按标题选择。
- 列表每页10条，正文按4,000字符分页；支持上一页、下一页、返回和关闭。
- 待审批提案详情可进入审批，但“选择提案”本身不是批准；必须在后续全文确认弹窗中确认。
- 取消/关闭不改数据，不触发模型回合，不往会话历史追加浏览内容。
- 无交互UI的 print/json 模式不打开浏览/审批弹窗。

`/memory` 仍提供简洁状态面板。Web 默认将面板折叠在底栏，提示会明确指出展开位置；希望直接浏览请用 `/memory list`。

### skill 审批流程（防滥用设计）

1. 模型调用 `project_memory_propose_skill` → 提案进入 store（不写任何 skill 文件）。
2. 用户运行 `/memory approve` 按名称选择（也可从 `/memory list` 进入提案详情），或直接 `/memory approve <pid>` → `ctx.ui.confirm` 二次确认（显示名称/类型/目标路径/完整正文/覆盖警告）。
3. 批准 → 安全写入 `<项目根>/.pi/skills/<name>/SKILL.md`（名称白名单正则、路径包含性 + realpath
   校验、O_EXCL 创建、符号链接一律拒绝），登记进 managedSkills 清单。
4. 批准**不自动 reload**：提示手动 `/reload` 或 `/new` 生效。

约束：本扩展不提供模型审批工具；无 UI（print/json 模式）时审批直接拒绝；提案数有上限（默认 10）。

审批安全细节（v1.1）：

- **new 绝不覆盖**：目标路径已存在（无论是否本扩展管理）→ 拒绝；update/retire 仅限已发布（managed）
  skill，且磁盘内容 hash 必须与批准时登记的 sha256 一致（手改 → 拒绝；旧数据无 hash → 保守拒绝并给
  人工处理指引；文件已被外部删除的 retire → 仅清理记录的显式模式）。
- **TOCTOU 防护**：confirm 前快照提案 + 目标文件 hash；confirm 后在 store 锁内重新验证提案完全一致、
  managed 状态、预算、目标文件未变，发布/登记同锁完成（防并发超额）。
- **路径安全**：写前/删前校验 skills 根、.pi、name 目录整条路径链（非符号链接 + realpath 包含性，
  覆盖 Windows junction），防父路径逃逸出项目根；文件创建用 O_EXCL。
- **完整内容审批**：确认对话框展示将写入的 SKILL.md 全文（不截断预览）。
- **frontmatter 安全**：description 用 JSON 引号包裹（YAML 双引号标量），冒号/#/引号不会破坏解析。
- **失败回滚**：文件操作失败 → 恢复审批前内容（文件被并发修改则绝不覆盖，只报错请人工检查）。
- **非跨文件原子事务**：skill 文件写入与 store 登记是两步。若文件操作成功而 store 最终写入失败（罕见），
  扩展做 best-effort 补偿回滚（new 删文件 / update 恢复旧内容 / retire 恢复文件）；补偿也失败或进程在两步间
  崩溃时，可能残留「文件已变、记录未变」状态 —— 用 `/memory reject <pid>` + 人工核对文件处理；不声称跨文件原子性。

这是本扩展发布流程的审批门，不是操作系统沙箱：其他 write/bash 工具或本地程序仍可能直接写项目文件。不要将它当作对所有工具的安全隔离。
记忆内容是不可信的参考资料，不能覆盖用户指令、AGENTS.md、人设或当前代码证据；本扩展不提供凭证扫描，勿保存密钥。

第一版没有定时 LLM dream：整合由当前会话模型通过 merge 执行，满容量时强制先维护。多条 archive 是原文分组存档，不等于语义提炼；merge 才接受模型生成的整合文本。

## 测试

本包独立测试（不依赖仓库根 `npm test`，根测试 glob 不扫描 `packages/`）：

```powershell
npm --prefix packages/project-memory test
npm --prefix packages/project-memory run typecheck
```

- 运行器：`node --experimental-strip-types --test`（仓库 engines 要求 Node ≥ 22.19，本机 v24 原生支持类型剥离）。
- 扩展核心无额外运行时依赖；开发测试依赖 jiti、TypeScript 和 Node 类型。完整测试必须安装开发依赖，不应跳过入口与缓存回归测试。
- 根 `tsconfig.json` 排除此独立 Pi 包：它使用 Pi/jiti 的 TS 导入方式，单独 typecheck，不进入 Next.js 构建。

测试覆盖：预算/合并/归档原子性、中文搜索打分、
原子写/损坏拒绝（保留原文件）/并发锁（进程内+跨进程+过期回收+超时）、skill 名称与路径安全
（穿越/符号链接/junction/覆盖竞态/YAML 安全 frontmatter）、
影子工作区检测、扩展冒烟（注册、git 子目录项目根、交接注入一次、退出兜底、
审批发布/拒绝/无 UI/retire/防覆盖碰撞/审批期间篡改与预算并发/手改后 update 拒绝/enabled:false）。

## 已知限制（v1）

- skill 仅单文件（SKILL.md）；不支持脚本/资源附属文件与子目录。
- 搜索为轻量子串 + bigram 打分，无 BM25/向量；默认展示命中片段。将条目 id 作为 query 可读取全文（最多 20,000 字符）；归档需 scope:"all"。
- Windows 上目录 junction 等 reparse 点的检测依赖 `lstat` + realpath 包含性校验，
  存在 unlink→create 的理论竞态窗口（O_EXCL 兜底：窗口内出现任何条目即失败，不会跟随符号链接）。
- 多 pi 实例写同一项目：锁等待最多 ~8s，超时返回明确错误（不会损坏数据）。
- 审批的「文件已写、store 未写成功」极端残留状态（补偿回滚也失败/进程崩溃）需人工核对，见审批安全细节。
- 影子工作区（`~/.pi/remote/*`）记忆为本地持久化，**不**同步到远程仓库。
- `/resume` 不会重新注入交接（续接会话自带历史）；如需刷新交接请手动 `project_memory_save(kind:"handoff")`。
- 退出兜底仅覆盖「完全没有任何交接」的场景，且标记未核实；不承诺退出时保存模型上下文。
