# ❓ 常见问题

## 入门

**Q: 如何开始使用？**  
A: 安装后运行 `blade`。若未配置模型，会自动进入模型配置向导；也可先用 `npx blade-code` 体验。

**Q: 提示 `command not found: blade`？**  
A: 确认全局安装路径在 `PATH` 中，例如：
```bash
npm config get prefix
export PATH="$(npm config get prefix)/bin:$PATH"
```

## 配置与模型

**Q: API Key/模型怎么配？**  
A: 两种方式：
1) 运行 `blade`，按向导填写 Provider / Base URL / API Key / 模型。  
2) 手动编辑 `~/.blade/config.json`（或项目级 `.blade/config.json`），把密钥放在环境变量后用 `${VAR}` 引用。

**Q: 有哪些 CLI 选项可以用？**  
A: 主要是 `--debug`、`--print`、`--output-format`、`--permission-mode`、`--resume`、`--max-turns`、`--system-prompt` / `--append-system-prompt`。其他选项（如 `--session-id`、`--allowed-tools` 等）当前未被代码消费。

## 使用中

**Q: Slash 命令/快捷键不可用？**  
A: 确保输入框聚焦；`/` 开头才会触发命令补全；`Shift+Tab` 仅在 UI 中切换权限模式。

**Q: 工具调用频繁弹窗？**  
A: 调整权限模式（如 `autoEdit`），或在确认弹窗中选择“会话内记住”，系统会把抽象规则写入 `.blade/settings.local.json`。

**Q: 会话如何恢复？**  
A: 启动时加 `--resume`（无参数会弹出选择器）；或在 UI 输入 `/resume`。

## 环境与网络

**Q: Node.js 版本要求？**  
A: 最低 18，推荐 20+。使用 `nvm` 或 `n` 升级。

**Q: 安装/下载慢？**  
A: 使用镜像源：`npm install -g blade-code --registry=https://registry.npmmirror.com`。

## 其他

**Q: 权限模式如何工作？**  
A: `default`：只读工具自动通过；`autoEdit`：额外放行写入；`plan`：拒绝所有修改，仅允许只读；`yolo`：全部放行。详情见权限章节。

**Q: 配置文件没写完或格式错误怎么办？**  
A: 未找到有效模型会触发向导；解析失败会在对话区提示错误。修正 JSON 后重启即可。
