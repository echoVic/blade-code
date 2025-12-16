# 📋 Blade CLI 命令参考

本文基于当前源码（`src/blade.tsx`、`src/commands/*`、`src/cli/config.ts`）梳理，确保与实际行为一致。

## 🎯 默认入口 `blade [message…]`

```bash
# 打开交互式界面
blade

# UI 就绪后自动发送首条消息
blade "帮我创建一个 README"
```

- 无子命令时启动 Ink 界面。若未配置模型，会自动进入「模型配置向导」（`ModelConfigWizard`）。
- 传入的 `message` 会在 UI 初始化后直接提交，无需手动回车。

常用参数（当前实现已接入的部分）：

| 参数 | 作用 |
| --- | --- |
| `--debug [filters]` | 打开调试日志，支持类别过滤（如 `--debug agent,ui` 或 `--debug "!chat,!loop"`）。 |
| `--permission-mode <default\|autoEdit\|yolo\|plan>` / `--yolo` | 启动时设置权限模式（也会写入配置）。 |
| `--resume [id]` | 恢复历史会话：`--resume` 交互选择，`--resume <id>` 直接加载。 |
| `--max-turns <n>` | 控制单次会话的最大轮次（0 = 禁用对话，-1 = 不限，上限 100）。 |
| `--system-prompt` / `--append-system-prompt` | 替换或追加系统提示词（传入 Agent）。 |

> 其他 CLI 选项（如 `--allowed-tools`、`--session-id`、`--ide` 等）虽在参数表中，但当前代码尚未消费它们。

## 🖨️ 打印模式 `-p / --print`

走 `src/commands/print.ts` 分支，不启动 UI：

```bash
blade --print "解释什么是 TypeScript"
echo "请总结这段文字" | blade -p --output-format json
```

- 支持 `--output-format text|json|stream-json`（默认 text）。
- 会创建最小化 Agent，读取命令行消息或 stdin，再直接输出结果。

## 🛠️ 子命令

| 子命令 | 说明 | 备注 |
| --- | --- | --- |
| `blade doctor` | 环境自检：配置加载、Node 版本、当前目录读写权限、依赖可用性。 | 成功返回 0，否则返回 1。 |
| `blade install [stable\|latest] [--force]` | 占位实现，模拟下载/安装输出。 | 目前仅打印流程，不做实际安装。 |
| `blade update` | 读取本地 `package.json` 版本并提示已是最新。 | 仅本地检查，无联网。 |
| `blade mcp ...` | 管理 MCP 服务器。见下表。 | |

`mcp` 子命令（`src/commands/mcp.ts`）：

| 命令 | 用法 | 说明 |
| --- | --- | --- |
| `mcp list` / `mcp ls` | `blade mcp list` | 列出 `.blade/config.json` 中的服务器并尝试连接，完成后自动断开。 |
| `mcp add <name> <cmdOrUrl> [args…]` | `blade mcp add github -- npx -y @modelcontextprotocol/server-github` | 支持 `--transport stdio|http|sse`、`--env KEY=VAL`、`--header "K: V"`、`--timeout <ms>`。 |
| `mcp remove <name>` / `rm` | `blade mcp remove github` | 从项目配置移除服务器。 |
| `mcp get <name>` | `blade mcp get github` | 打印单个服务器配置 JSON。 |
| `mcp add-json <name> '<json>'` | `blade mcp add-json api '{"type":"http","url":"..."}'` | 直接传入 JSON 串。 |
| `mcp reset-project-choices` | `blade mcp reset-project-choices` | 清除项目级 `.mcp.json` 的批准/拒绝记录。 |

## 🧭 交互界面要点

- `/` 开头触发 Slash 命令补全，`@` 开头触发文件路径补全（自动读取并注入上下文，见「@ 文件提及」章节）。
- 快捷键：`Ctrl+C / Ctrl+D` 终止任务或退出；`Ctrl+L` 清屏；`Esc` 关闭建议/中断执行；`Shift+Tab` 在 `default → autoEdit → plan` 间循环。
- 没有模型配置时自动进入模型向导；若解析配置失败会在对话区显示错误。

## 🔁 示例

```bash
# 打印模式（脚本集成）
git diff | blade --print --append-system-prompt "请给出代码审查建议"

# 启用 Plan 模式启动 UI
blade --permission-mode plan

# 恢复历史会话并继续对话
blade --resume 2024-12-foo-session
```

更多用法见其他章节（工具列表、Slash 命令、Plan 模式等）。***
