# Pi Web — luckyyzh 修改版

本项目是 [agegr/pi-web](https://github.com/agegr/pi-web)（Pi Web，一个为 [pi coding agent](https://github.com/agegr/pi) 提供 Web 界面的项目）的 fork，在保持官方功能的基础上，**集成并增强了以下内容**（中文为主）。

> 这是一个**带私有修改的 fork**，README 已被重写为本文档。官方原始 README 见上游仓库；同步上游更新时本文档不受影响（见文末「同步上游」）。

---

## 本 fork 的新增/修改

### 1. 远程 SSH 工作区（核心新增）
在 Web 界面上直接操作远程服务器：
- **SSH 配置**：底部工具栏「远程」按钮，填 `host`（如 `user@server`）与远程工作目录，测试连接后一键启用
- **影子目录隔离**：每个远程目录映射本地影子根（`~/.pi/remote/<host>_<hash>`），会话、`AGENTS.md`、项目信任按远程目录隔离
- **文件浏览器**：同步显示远程文件，可浏览目录、预览文本
- **Git 远程化**：Git 状态 / diff 走远程仓库
- **Agent 工具远程化**：read / write / edit / bash 全部转发到远程执行（依赖 `ssh` 扩展）

### 2. MCP 服务器管理面板
Plugins 面板内置 MCP 管理：查看 / 添加 / 删除 / 启用禁用 / 测试连接 / JSON 编辑 / 作用域（全局 vs 项目）/ pi-mcp-adapter 选项。

### 3. 用户人设（Persona）
- 顶部工具栏新增 **「人设」** 标签（「系统」标签旁），点击查看 / 编辑 / 保存
- 保存在 `~/.pi/agent/persona.md`，由内置 `persona-injector` 扩展在**每轮对话**注入系统提示词，保存后下一条消息即生效（无需插件）

### 4. 缓存命中率
右上角 token 信息栏显示 **缓存命中率**（`缓存读取 / (输入 + 缓存读取)`），随会话实时累计。

### 5. 一键启动脚本 `start-pi-web.cmd`（Windows）
自动：检测 Node（需 ≥22.19）→ 安装全局 pi agent → 安装依赖（含 dev）→ 构建 → 启动；端口被占用时自动清理。

### 6. 一键安装 ssh 扩展
SSH 配置弹窗内检测到未安装时，提供「一键安装」按钮（安装 pi-web 内嵌的 `vendor/ssh` 副本，离线可用）。

### 7. 同步上游脚本 `sync-upstream.cmd`
一键拉取官方更新并合并（README 不冲突，见下），合并后提示手动构建 / 推送。

### 8. 其它修复
- 修复本地路径安装的扩展在 WebUI 无法卸载的问题（卸载匹配 key 与 agent 目录对齐）
- 插件卸载时自动清理占用端口

---

## 快速开始（Windows）

```bash
git clone https://github.com/luckyyzh/pi-web.git
cd pi-web
start-pi-web.cmd        # 或双击；自动装依赖 / 构建 / 启动
```

浏览器打开 `http://127.0.0.1:30141`。

> 需要 Node.js ≥ 22.19（`package.json` engines 要求）。

Linux / macOS：

```bash
git clone https://github.com/luckyyzh/pi-web.git && cd pi-web
npm install
npm install -g @earendil-works/pi-coding-agent
npm run build
node bin/pi-web.js -p 30141
```

---

## 配套扩展仓库

`luckyyzh/pi-web-extensions`（私有）内含独立扩展：
- `ssh` — SSH 远程执行（本 fork 远程工作区依赖）
- `searxng-search` — 自建 SearXNG 端点提供 `web_search`
- `describe-image` — 非视觉模型的识图能力

---

## 同步上游

本 fork 会定期同步官方 `agegr/pi-web` 的更新：

```bash
sync-upstream.cmd       # Windows：拉取官方 → 合并（README 自动保留本版）
```

或手动：

```bash
git fetch origin
git merge origin/main   # README 冲突由 merge=ours 自动保留本版
git push luckyyzh main
```

> `.gitattributes` 将 `README.md` 标记为 `merge=ours`：合并时**永远保留本 fork 的 README**，官方对 README 的改动不会造成冲突，也不覆盖本文档。
