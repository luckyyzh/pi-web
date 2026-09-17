# 扩展首次安装和手动更新

```bat
start-pi-web.cmd                     REM 首次安装扩展并启动，以后不检查更新
start-pi-web.cmd 30200 MyAgent       REM 独立实例
start-pi-web.cmd update              REM 只更新扩展，不启动服务
start-pi-web.cmd update MyAgent      REM 更新指定实例的扩展
```

扩展代码、Skill、npm 固定版本清单及后台任务补丁维护在
[luckyyzh/pi-web-extensions](https://github.com/luckyyzh/pi-web-extensions)。

## 脚本做什么

1. 首次将仓库克隆到当前 `PI_CODING_AGENT_DIR/pi-web-extensions`，按 `install-manifest.json` 安装。
2. 全部成功后写入 `.pi-web-extensions-installed` 标记。普通启动只检查这个文件，不运行 Git/npm 或查询扩展更新。
3. `update` 执行 `git pull --ff-only`，将清单中的 npm 包安装到指定版本并应用必要补丁。不是盲目升级 npm latest，也不更新 Pi Web/全局 Pi CLI。

未设置 `PI_CODING_AGENT_DIR` 时使用 `~/.pi/agent`；指定实例名时使用 `~/.pi/pi-web-instances/<实例名>`。各实例首次标记、包安装和 settings 登记独立。更新不操作服务和端口，建议退出目标实例后更新，再自行启动以清除模块缓存。

## 保留的边界

- 首次保留已有安装。已有其它路径的本地扩展不覆盖或重复登记；`update` 会明确更新清单中的 npm 包。
- 只修改包登记，不复制密钥、模型/MCP/SSH 配置、浏览器登录态、会话、人设或备份。搜索/识图仍沿用历史 `~/.pi/agent` 配置位置，第三方配置不保证实例隔离。
- 保留旧 SSH 源码，但不默认安装；继续使用 Pi Web 内置 SSH 工作区。
- 后台任务修复有版本和 SHA-256 校验，未知文件修改会报错。Git 冲突交给用户处理，不执行 reset/clean。失败不留下首次完成标记，可处理后重试；不做整批回滚或自动恢复。
- 浏览器插件另需 agent-browser CLI（>=0.35，推荐0.37）和浏览器，录屏另需 ffmpeg；本脚本不安装这些系统工具。
- 同一实例请不要同时运行多个安装/update 窗口。

CMD 使用 UTF-8 无 BOM、CRLF；先执行 `chcp 65001` 再解析中文注释。

发布时先推送扩展仓库的新清单和源码，再发布 Pi Web 启动器。远端清单未发布前，首次安装会明确失败。
