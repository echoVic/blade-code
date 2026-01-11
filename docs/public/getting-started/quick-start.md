# 🚀 快速开始

## 三步上手

### 1. 启动

```bash
blade          # 交互式界面
npx blade-code # 零安装体验
```

> 💡 首次运行会自动使用内置免费模型 GLM-4.7，无需任何配置即可开始使用。如需使用自己的 API 密钥，可输入 `/model add` 进入配置向导。

### 2. 提问

```bash
blade "帮我创建一个 React 组件"          # UI 就绪后自动发送
blade --print "解释什么是 TypeScript"   # 打印模式，适合脚本
blade --permission-mode autoEdit "修复 lint 错误"
```

### 3. 交互

在交互界面中：

- 直接输入问题与 AI 对话
- 输入 `/` 触发 Slash 命令补全
- 输入 `@` 触发文件路径补全
- 按 `Shift+Tab` 切换权限模式

## 常用命令

```bash
# 基础对话
blade "什么是人工智能？"

# 会话管理
blade --resume              # 交互选择历史会话
blade --resume <session-id> # 恢复指定会话

# 系统检查
blade doctor                # 环境检查
blade mcp list              # 查看 MCP 配置

# 打印模式（适合脚本集成）
blade --print "生成一个快排算法"
echo "请总结" | blade -p
```

## 模型配置

### 内置免费模型

Blade Code v0.1.0 内置了免费的 GLM-4.7 模型：

- **模型**: GLM-4.7 Thinking（智谱）
- **特性**: 支持思维链推理
- **上下文**: 204,800 tokens
- **限制**: 由 Blade 团队提供免费额度

首次启动时会自动使用内置模型，适合快速体验。

### 向导配置

如需使用自己的模型，输入 `/model add` 进入配置向导。

### 手动配置

编辑 `~/.blade/config.json`：

```json
{
  "currentModelId": "qwen",
  "models": [
    {
      "id": "qwen",
      "name": "Qwen",
      "provider": "openai-compatible",
      "apiKey": "${QWEN_API_KEY}",
      "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
      "model": "qwen-max"
    }
  ]
}
```

### 多模型配置

支持配置多个模型，使用 `/model` 命令切换：

```json
{
  "currentModelId": "qwen",
  "models": [
    {
      "id": "qwen",
      "name": "Qwen Max",
      "provider": "openai-compatible",
      "apiKey": "${QWEN_API_KEY}",
      "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
      "model": "qwen-max"
    },
    {
      "id": "deepseek",
      "name": "DeepSeek R1",
      "provider": "openai-compatible",
      "apiKey": "${DEEPSEEK_API_KEY}",
      "baseUrl": "https://api.deepseek.com",
      "model": "deepseek-reasoner",
      "supportsThinking": true
    },
    {
      "id": "claude",
      "name": "Claude 3.5",
      "provider": "anthropic",
      "apiKey": "${ANTHROPIC_API_KEY}",
      "model": "claude-3-5-sonnet-20241022"
    }
  ]
}
```

## 智能工具调用

Blade 会根据你的请求自动调用合适的工具：

```bash
# 文件操作
blade "读取 package.json 的内容"
blade "在 src/utils 目录下创建一个 helper.ts 文件"

# 代码搜索
blade "查找所有包含 TODO 的代码"
blade "列出所有 TypeScript 文件"

# Git 操作
blade "查看当前 git 状态"
blade "帮我审查最近的代码改动"

# 项目分析
blade "帮我梳理 src/ui 目录的结构"
blade "分析这个项目的架构"
```

## 权限模式

Blade 提供四种权限模式，按 `Shift+Tab` 循环切换：

| 模式 | 说明 | 适用场景 |
|------|------|----------|
| `default` | 只读工具自动通过，写入需确认 | 日常使用 |
| `autoEdit` | 只读+写入自动通过，执行需确认 | 频繁修改代码 |
| `plan` | 仅允许只读工具，拒绝所有修改 | 调研和规划 |
| `yolo` | 所有工具自动通过 | 高度可控环境 |

```bash
# 启动时指定权限模式
blade --permission-mode plan
blade --yolo  # 等同于 --permission-mode yolo
```

## 安全确认

写入、命令执行等操作会根据权限规则弹出确认：

- 选择 **[Y] 允许** 执行操作
- 选择 **[N] 拒绝** 取消操作
- 选择 **[A] 会话内记住** 后续同类操作不再询问

> **轮次上限**：长时间任务达到阈值（默认 100 轮）时会暂停并询问，防止意外消耗过多 Token。

## 快捷键

| 快捷键 | 功能 |
|--------|------|
| `Ctrl+C` | 中断当前操作或退出 |
| `Ctrl+L` | 清屏 |
| `Ctrl+T` | 展开/折叠思维链 |
| `Shift+Tab` | 切换权限模式 |
| `Esc` | 关闭建议列表 |
| `↑/↓` | 浏览历史命令 |
| `Tab` | 补全命令/文件路径 |

## Slash 命令

在交互界面输入 `/` 开头的命令：

```bash
/help         # 显示帮助
/init         # 生成 BLADE.md 项目配置
/git status   # 查看 Git 状态
/git review   # AI 代码审查
/git commit   # AI 生成 commit message 并提交
/model        # 切换模型
/theme        # 切换主题
/resume       # 恢复历史会话
/compact      # 压缩上下文
/agents       # 管理子代理
/permissions  # 管理权限规则
/mcp          # 查看 MCP 状态
/context      # 显示上下文使用情况
```

## @ 文件提及

在消息中使用 `@` 引用文件：

```
请帮我分析 @src/agent/Agent.ts 中的错误处理逻辑
对比 @package.json 和 @tsconfig.json 的配置
解释 @src/utils/git.ts#L50-100 这段代码
```

## 下一步

- [配置系统](../configuration/config-system.md) - 深入了解配置
- [权限控制](../configuration/permissions.md) - 自定义权限规则
- [Slash 命令](../guides/slash-commands.md) - 完整命令列表
- [工具列表](../reference/tool-list.md) - 所有可用工具
