# 🚀 快速开始

本指南帮助你在 5 分钟内开始使用 Blade。

## 安装

```bash
# 使用 npm
npm install -g blade-code

# 或使用 pnpm
pnpm add -g blade-code

# 或使用 yarn
yarn global add blade-code
```

## 启动

### CLI 模式

```bash
# 在项目目录下启动
cd /path/to/project
blade

# 或带初始消息启动
blade "帮我分析这个项目的架构"
```

### Web UI 与服务器模式

```bash
# 启动 Web UI 并自动打开浏览器
blade web

# 或启动无头服务器（适合远程访问）
blade serve --port 3000 --hostname 0.0.0.0
```

## 配置模型

首次启动需配置模型，输入 `/model add` 启动配置向导：

### 3 步完成配置

1. **选择 Provider** - 从内置 Provider Catalog 中选择
2. **输入 API Key** - 向导会显示环境变量名和文档链接
3. **选择模型** - 从该 Provider 的内置模型列表中选择

配置完成后，使用 `/model` 命令切换模型。

### 自定义 Provider

TUI 和 Web 的 Add Model 都提供 `Custom OpenAI Endpoint` 与
`Custom Anthropic Endpoint`。依次填写稳定的 Channel ID、名称、Base URL 和 Model ID
即可创建独立渠道。每个渠道拥有自己的 endpoint 与凭据，不会因协议相同而串用 API
key。完整格式见[模型与配置系统](../configuration/config-system.md)；API key 始终由
`~/.blade/auth.json` 单独保存。

## 基本交互

### 对话

直接输入问题开始对话：

```
你: 帮我写一个 React 组件，实现一个带搜索功能的下拉选择器

Blade: 好的，我来帮你创建一个带搜索功能的下拉选择器组件...
```

### @ 文件引用

使用 `@` 引用文件，让 AI 了解上下文：

```
你: @src/components/Button.tsx 帮我添加一个 loading 状态

你: @src/utils/api.ts:10-50 这段代码有什么问题？
```

### 常用命令

| 命令 | 说明 |
|------|------|
| `/help` | 显示帮助信息 |
| `/model` | 切换/管理模型 |
| `/model add` | 从 Provider Catalog 添加模型 |
| `/clear` | 清空对话历史 |
| `/compact` | 压缩上下文 |
| `/btw <问题>` | 询问不写入主会话的旁路问题 |
| `/status` | 查看当前状态 |
| `/config` | 查看/修改配置 |

### 快捷键

| 快捷键 | 说明 |
|--------|------|
| `Enter` | 发送消息 |
| `Shift+Enter` | 换行 |
| `Ctrl+C` | 中断当前操作 |
| `Ctrl+D` | 退出 Blade |
| `Ctrl+O` | 打开/关闭只读 transcript |
| `↑/↓` | 浏览历史消息 |
| `Tab` | 自动补全 |

在 transcript pager 内，`/` 搜索全文，`n/N` 跳转匹配项；`Tab` 选择
Tool/Thinking 项，`Enter` 或 `e` 单独展开；`v` 开始逐行选择，`y` 或
`Ctrl+C` 复制。

## 权限控制

Blade 会在执行敏感操作前请求确认：

```
┌─────────────────────────────────────────────────────────┐
│  🔧 Blade 想要执行以下操作:                              │
│                                                         │
│  工具: Write                                            │
│  文件: src/components/SearchSelect.tsx                  │
│                                                         │
│  [y] 允许  [n] 拒绝  [a] 本次会话全部允许                │
└─────────────────────────────────────────────────────────┘
```

可以通过配置文件预设权限规则，详见 [权限控制](../configuration/permissions.md)。

## 配置文件

### 模型引用示例

创建 `~/.blade/config.json`：

```json
{
  "currentModelId": "claude",
  "models": [
    {
      "id": "claude",
      "displayName": "Claude Sonnet",
      "provider": "anthropic",
      "model": "claude-sonnet-4-5"
    }
  ]
}
```

凭证存储在 `~/.blade/auth.json`，推荐通过 `/model add` 配置。

更多 Provider 和模型可直接在 TUI 或 Web 的 Provider Catalog 中选择。

## 下一步

- [配置系统](../configuration/config-system.md) - 模型与凭证配置
- [权限控制](../configuration/permissions.md) - 权限规则配置
- [@ 文件引用](../guides/at-file-mentions.md) - 高级文件引用
- [Slash 命令](../guides/slash-commands.md) - 所有可用命令
- [Plan 模式](../guides/plan-mode.md) - 规划模式使用
- [Subagents](../guides/subagents.md) - 子代理功能
