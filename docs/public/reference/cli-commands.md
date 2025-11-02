# 📋 Blade CLI 命令参考

Blade 的命令行分为 **默认交互式入口** 和若干 **辅助子命令**。本页基于当前源码实现（`src/blade.tsx`、`src/commands/*`、`src/cli/config.ts`）整理，确保与实际行为一致。

## 🎯 默认命令：`blade [message..]`

```bash
# 打开交互式界面
blade

# 带首条消息启动，消息会在 UI 就绪后自动发送
blade "帮我创建一个 README"

# 指定模型、权限模式等选项
blade --model qwen-max --permission-mode autoEdit "修复 lint 错误"
```

- 无子命令时会进入 Ink 构建的交互式界面（`BladeInterface`）。
- 首次运行且未设置 API Key 时，自动进入设置向导（`SetupWizard`），填写 provider / base URL / API Key / 模型后即可继续。
- 传入的 `message` 参数会在 UI 初始化完成后自动注入输入框并执行，无需手动回车。

### 常用选项（节选）
| 选项 | 说明 |
|------|------|
| `--debug [filters]` | 打印调试日志，支持类别过滤（如 `--debug api,hooks` 或 `--debug "!statsig,!file"`） |
| `--print` / `-p` | 启用打印模式（见下文） |
| `--output-format <text\|json\|stream-json>` | 配合 `--print` 指定输出格式 |
| `--system-prompt <string>` | 替换默认系统提示词 |
| `--append-system-prompt <string>` | 在默认系统提示词后追加内容 |
| `--model <name>` / `--fallback-model <name>` | 控制当前会话模型及回退模型 |
| `--permission-mode <default\|autoEdit\|yolo\|plan>` | 调整权限模式（也可用 `--yolo` 快捷开启全自动批准） |
| `--allowed-tools ...` / `--disallowed-tools ...` | 临时显式允许/拒绝工具 |
| `--session-id <id>` | 固定会话 ID，便于多轮对话 |
| `--continue` / `--resume <id>` | 继续最近一次或指定会话，`--fork-session` 可在恢复时复制为新 ID |
| `--mcp-config <path|json>` / `--strict-mcp-config` | 加载 MCP 服务器配置 |
| `--ide` | 启动时尝试连接 IDE 集成 |

> 完整选项定义见 `src/cli/config.ts` 中的 `globalOptions`。

## 🖨️ 打印模式 `--print`

```bash
# 单次问答并直接输出文本
blade --print "解释什么是 TypeScript"

# 以 JSON 输出（适合脚本消费）
blade --print --output-format json "列出项目依赖"

# 从标准输入读取
echo "请总结这段文字" | blade --print
```

设置 `--print`（或 `-p`）后，CLI 会走 `print` 分支而非交互式 UI，其行为定义在 `src/commands/print.ts`：

1. 创建最小化 `Agent` 实例。
2. 读取命令行参数或标准输入。
3. 根据 `--output-format` 输出纯文本、JSON 或流式 JSON。

适合脚本、CI、编辑器集成等场景。

## 🧭 会话与输入体验

- 历史记录：在 UI 中使用 `↑/↓` 导航历史指令，`/` 开头可触发 Slash 命令建议（由 `useKeyboardInput` 管理）。
- 快捷键：`Ctrl+C / Ctrl+D` 退出，`Ctrl+L` 清屏，`Esc` 停止正在执行的任务或退出建议模式，`Shift+Tab` 在 `default ↔ autoEdit` 模式间切换。
- 入场提示：当初始化成功时，UI 会自动发送“Blade Code 助手已就绪”提示，初始化失败会显示具体错误（详见 `BladeInterface` 中的状态处理）。

## 🛠️ 子命令

| 子命令 | 源码位置 | 作用与示例 |
|--------|----------|------------|
| `blade config <set|get|list|reset>` | `src/commands/config.ts` | 管理配置：`blade config list`、`blade config set theme dark` |
| `blade doctor` | `src/commands/doctor.ts` | 运行环境健康检查（配置、Node 版本、文件权限、依赖） |
| `blade install [stable\|latest]` | `src/commands/install.ts` | 安装或更新 Blade 原生构建（当前为占位实现） |
| `blade update` | `src/commands/update.ts` | 检查更新版本 |
| `blade mcp <list|add|remove|start|stop>` | `src/commands/mcp.ts` | 管理 MCP 服务器，可通过 JSON/文件注册并启动/停止 |

所有子命令均基于 Yargs，自动提供 `--help` 查看详细参数。

## 🔁 典型使用场景

```bash
# 进入交互界面并使用自动发送首条消息
blade "帮我把 src/ui 目录梳理成 README"

# 调整权限行为后继续对话
blade --permission-mode autoEdit --continue

# 快速打印总结（非交互式）
git diff | blade --print --append-system-prompt "请给出代码审查建议"

# 查看当前配置
blade config list

# 连接并管理 MCP 服务器
blade mcp add local-server ./mcp/local.json
blade mcp start local-server
```

了解更多高级功能（工具系统、MCP 协议等），请继续阅读其他章节。
