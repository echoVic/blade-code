# ❓ 常见问题

## 入门

**Q: 如何开始使用？**  
A: 安装后运行 `blade`。若未配置模型，会自动进入模型配置向导；也可先用 `npx blade-code` 体验。

**Q: 提示 `command not found: blade`？**  
A: 确认全局安装路径在 `PATH` 中：
```bash
npm config get prefix
export PATH="$(npm config get prefix)/bin:$PATH"
```

**Q: 支持哪些 Node.js 版本？**  
A: 最低 Node.js 18，推荐 20+。使用 `nvm` 或 `n` 升级。

## 配置与模型

**Q: API Key / 模型怎么配置？**  
A: 两种方式：
1. 运行 `blade`，按向导填写 Provider / Base URL / API Key / 模型
2. 手动编辑 `~/.blade/config.json`（或项目级 `.blade/config.json`），密钥可用 `${VAR}` 引用环境变量

**Q: 支持哪些模型提供商？**  
A: 支持以下提供商：
- OpenAI-compatible（任何兼容 OpenAI API 的服务）
- Anthropic（Claude 系列）
- Google Gemini
- Azure OpenAI
- GitHub Copilot（需 OAuth 登录）
- Antigravity（需 OAuth 登录）

**Q: 如何配置多个模型？**  
A: 在 `config.json` 的 `models` 数组中添加多个配置，通过 `/model` 命令切换。

**Q: 配置文件格式错误怎么办？**  
A: 未找到有效模型会触发向导；解析失败会在对话区提示错误。修正 JSON 后重启即可。

## 使用中

**Q: Slash 命令 / 快捷键不可用？**  
A: 确保输入框聚焦；`/` 开头才会触发命令补全；`Shift+Tab` 仅在 UI 中切换权限模式。

**Q: 工具调用频繁弹窗？**  
A: 调整权限模式：
- `autoEdit`：自动批准文件编辑
- `yolo`：自动批准所有操作
- 或在确认弹窗中选择"会话内记住"，系统会把规则写入 `.blade/settings.local.json`

**Q: 会话如何恢复？**  
A: 启动时加 `--resume`（无参数会弹出选择器）；或在 UI 输入 `/resume`。

**Q: 如何继续上次对话？**  
A: 使用 `blade --continue` 或 `blade -c` 继续最近的会话。

## 权限模式

**Q: 权限模式如何工作？**  
A: 五种模式：
- `default`：只读工具自动通过，写入和执行需确认
- `autoEdit`：额外自动放行文件写入
- `plan`：只读调研模式，拒绝所有修改
- `yolo`：全部自动放行
- `spec`：Spec 驱动开发模式，自动放行写入

**Q: 如何快速切换权限模式？**  
A: 
- 快捷键：`Shift+Tab` 循环切换
- 命令：`/permissions` 或 `/yolo`
- 启动参数：`--permission-mode <mode>` 或 `--yolo`

## Skills 和 Hooks

**Q: 什么是 Skills？**  
A: Skills 是动态 Prompt 扩展机制，通过 `SKILL.md` 文件定义，可以为 AI 注入特定领域知识和行为指导。

**Q: 什么是 Hooks？**  
A: Hooks 是工具执行钩子，可以在工具执行前后自动运行命令，如代码格式化、lint 检查等。

**Q: 如何创建自定义 Skill？**  
A: 在 `.blade/skills/` 或 `~/.blade/skills/` 目录下创建 `SKILL.md` 文件，包含 YAML 元数据和 Markdown 内容。

## MCP 协议

**Q: 什么是 MCP？**  
A: Model Context Protocol，一种扩展 AI 工具能力的协议。通过 MCP 服务器可以添加自定义工具。

**Q: 如何添加 MCP 服务器？**  
A: 
```bash
blade mcp add github -- npx -y @modelcontextprotocol/server-github
```

**Q: MCP 服务器连接失败？**  
A: 检查：
1. 服务器命令是否正确
2. 依赖是否安装
3. 使用 `blade mcp list` 查看连接状态

## 网络与性能

**Q: 安装 / 下载慢？**  
A: 使用镜像源：
```bash
npm install -g blade-code --registry=https://registry.npmmirror.com
```

**Q: 响应速度慢？**  
A: 
1. 检查网络连接
2. 尝试切换到更快的模型
3. 使用 `--fallback-model` 设置备用模型

## 调试

**Q: 如何查看调试日志？**  
A: 使用 `--debug` 参数：
```bash
# 查看所有日志
blade --debug

# 只看特定类别
blade --debug "agent,tool"

# 排除某些类别
blade --debug "!chat,!loop"
```

**Q: 如何运行环境检查？**  
A: 运行 `blade doctor` 检查配置、Node 版本、目录权限等。

## 其他

**Q: 如何更新到最新版本？**  
A: 
```bash
npm update -g blade-code
```

**Q: 在哪里报告问题？**  
A: 在 [GitHub Issues](https://github.com/echoVic/blade-code/issues) 提交问题。

**Q: 如何贡献代码？**  
A: Fork 仓库，创建分支，提交 PR。详见项目 README。
