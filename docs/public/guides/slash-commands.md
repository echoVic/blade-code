# Slash 命令

Slash 命令由 `src/slash-commands` 提供，输入 `/` 触发建议，`Tab` 补全，`Enter` 执行。无论命令成功与否都会显示结果或错误提示。

## 可用命令（当前实现）

| 命令 | 作用 | 备注 |
| --- | --- | --- |
| `/help` | 列出所有 Slash 命令 | 内置帮助。 |
| `/clear` | 清空消息区 | 同 `Ctrl+L` 清屏逻辑。 |
| `/exit` | 退出程序 | 同 `Ctrl+C`。 |
| `/version` | 显示版本信息 | 从 `package.json` 读取。 |
| `/status` | 显示当前项目/配置概览 | 检查 `BLADE.md`、项目类型等。 |
| `/context` / `/cost` | 显示上下文/成本示例信息 | 当前为静态示例，便于占位。 |
| `/init` | 分析项目生成或改进 `BLADE.md` | 调用 Agent 读取代码并写入 `BLADE.md`。 |
| `/model [add|remove]` | 管理模型配置 | 无参时弹出模型选择器；`add` 打开向导；`remove <name>` 删除匹配名称。 |
| `/theme` | 打开主题选择器 | 立即应用并写回配置。 |
| `/permissions` | 打开权限管理器 | 操作 `.blade/settings.local.json`。 |
| `/mcp` | 显示 MCP 状态 | 由内置命令输出当前配置。 |
| `/agents [list|create|help]` | 管理子代理配置 | 读取 `.blade/agents` / `~/.blade/agents`；`list` 文本列出，`create` 打开创建向导。 |
| `/resume` | 打开会话选择器 | 可恢复历史对话。 |
| `/compact` | 手动触发上下文压缩 | 调用 UI 压缩逻辑。 |
| `/git [status|log|diff|review|commit]` | Git 状态/日志/差异，`review/commit` 会调用 Agent 协助生成描述 | 需在 Git 仓库中使用。 |

## 补全与导航

- 输入 `/` 自动展示建议；继续输入可模糊匹配（Fuse.js）。
- `Tab` 选中当前高亮项；`↑/↓` 在建议列表中移动。
- 输入包含空格后不再展示命令建议，避免干扰子参数输入。

## 典型用法

```bash
/init                     # 生成或改进 BLADE.md
/git status               # 查看 Git 状态
/git review               # 让 Agent 生成变更点评
/model add                # 新增模型配置
/permissions              # 编辑本地权限规则
/theme                    # 切换主题
/resume                   # 选择历史会话
```

## 注意事项

- 部分命令（如 `/context`、`/cost`、`/config`）当前为占位信息，仅展示示例文本。
- Slash 命令执行前会确保配置 Store 已初始化；如配置缺失会在对话区提示错误。
- `/git` 系列依赖本地 Git 状态，遇到缺失或异常会返回错误消息而非中断程序。
