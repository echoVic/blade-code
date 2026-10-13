# 🔒 权限系统

Blade 提供完善的权限控制系统，确保 AI 操作的安全性和可控性。

## 权限级别

| 级别 | 说明 | 优先级 |
|------|------|--------|
| `deny` | 直接拒绝执行 | 最高 |
| `allow` | 自动允许执行 | 中 |
| `ask` | 需要用户确认 | 低 |

匹配顺序：`deny` > `allow` > `ask` > 默认（ask）

## 权限模式

Blade 提供四种权限模式。TUI 中的 `Shift+Tab` 在 `default`、`autoEdit` 和
`plan` 之间循环切换；`yolo` 必须通过显式命令、启动参数或设置启用。

### DEFAULT 模式（默认）

```
✅ 自动批准: 只读工具（Read、FindFiles、Glob、Grep、WebFetch、WebSearch、TaskCreate/TaskGet/TaskUpdate/TaskList、Task、Plan 工具）
❌ 需要确认: Write 工具（Edit、Write、ApplyPatch、NotebookEdit）、Execute 工具（Bash、Skill、SlashCommand）
```

适用场景：日常使用，平衡安全与效率。

没有显式规则时，Bash 使用完整命令的只读分类器自动批准普通查询。
命令追加写操作、包含管道、重定向、命令替换或换行时需要确认；
`sed` 的执行/写入表达式和 `tree -o` 也需要确认。内置配置不再使用
`Bash(ls *)`、`Bash(git log *)` 等前缀 allow 规则。

### AUTO_EDIT 模式

```
✅ 自动批准: 只读工具 + Write 工具
❌ 需要确认: Execute 工具（Bash、Skill、SlashCommand）
```

适用场景：频繁修改代码的开发任务。

### PLAN 模式

```
✅ 自动批准: 只读工具
❌ 拦截所有修改: Write 和 Execute 工具
🔵 特殊工具: ExitPlanMode（用于提交方案）
```

适用场景：调研阶段，生成实现方案，用户批准后退出。

### YOLO 模式（危险）

```
✅ 自动批准: 所有工具
⚠️ 警告: 完全信任 AI，跳过所有确认
```

适用场景：高度可控的环境或演示场景。

YOLO 会跳过普通 allow/ask/deny 规则。审计代理只读限制、路径安全检查和
Hook 拒绝仍生效。

## 权限规则配置

### 规则格式

```
Tool(content)
```

支持 `*` 和 `**` 通配符（使用 picomatch）：

括号内容由工具的权限签名决定：Read/Edit/Write 使用文件路径，
Bash 使用原始命令文本，WebFetch 使用 `domain:hostname`。文件路径前
不加 `file_path:`，Bash 命令前不加 `command:` 或 `git:`。

工具名也支持 `*`（任意字符）和 `?`（单个字符）。例如 `Web*` 匹配
`WebFetch` 与 `WebSearch`，`mcp__github__*` 匹配 GitHub 服务器的所有 MCP
工具，`mcp__my-server__query(*)` 匹配含连字符的服务器工具。工具名通配符
不会取消括号内的参数约束，例如 `Web*(domain:example.com)` 只匹配该域名。

```json
{
  "permissions": {
    "allow": [
      "Read",
      "Read(**/*.ts)",
      "Bash(git *)",
      "Bash(npm run *)"
    ],
    "deny": [
      "Read(**/.env*)",
      "Read(**/*.pem)",
      "Bash(rm -rf *)",
      "Bash(sudo *)"
    ]
  }
}
```

### 常用规则示例

#### 文件访问控制

```json
{
  "allow": [
    "Read(**/*.{ts,tsx,js,jsx,md,json})",
    "Write(**/*.ts)",
    "Edit(**/src/**)"
  ],
  "deny": [
    "Read(**/.env*)",
    "Read(**/*.pem)",
    "Read(**/secrets/**)",
    "Write(**/node_modules/**)"
  ]
}
```

#### 命令执行控制

```json
{
  "allow": [
    "Bash(git *)",
    "Bash(npm run *)",
    "Bash(pnpm *)",
    "Bash(ls *)",
    "Bash(cat *)",
    "Bash(head *)",
    "Bash(tail *)"
  ],
  "deny": [
    "Bash(rm -rf *)",
    "Bash(sudo *)",
    "Bash(chmod *)",
    "Bash(curl * | bash)",
    "Bash(wget * | bash)"
  ]
}
```

#### 网络访问控制

```json
{
  "allow": [
    "WebFetch(domain:api.github.com)",
    "WebFetch(domain:registry.npmjs.org)",
    "WebSearch"
  ],
  "deny": [
    "WebFetch(domain:internal.example.com)"
  ]
}
```

WebFetch 的规则仅约束域名，不能区分协议或 URL 路径。Bash 显式 allow
规则匹配完整命令文本中的通配符，属于用户主动授予的命令范围；例如
`Bash(git *)` 也允许 Git 写操作和追加命令。优先使用具体命令规则。

## 确认与持久化

### 确认弹窗

当规则判定为 `ask` 时，会弹出确认弹窗：

```
┌─────────────────────────────────────────┐
│ 🔧 工具调用确认                          │
├─────────────────────────────────────────┤
│ Bash: npm run build                     │
│                                         │
│ [Once] [Session] [Project] [Deny]        │
└─────────────────────────────────────────┘
```

### 会话授权

选择 `Session` 只会把本次调用的精确签名保存在当前 Session Runtime 内存中。Session
结束或 Runtime 释放后，该授权自动失效，不会写入项目文件。

### 项目授权

只有明确选择 `Project` 才会把抽象后的规则写入 `.blade/settings.local.json`：

```json
{
  "permissions": {
    "allow": [
      "Bash(npm run build*)"
    ]
  }
}
```

### 规则抽象

不同工具的规则抽象方式：

| 工具 | 抽象规则示例 |
|------|-------------|
| Bash | `Bash(npm run *)` |
| Edit/Write | `Edit(**/*.ts)` |
| ApplyPatch | `ApplyPatch`（工具级授权） |
| WebFetch | `WebFetch(domain:api.github.com)` |
| WebSearch | `WebSearch(search:*)` |
| BrowserNavigate | `BrowserNavigate(http://127.0.0.1:3000)` |
| BrowserInteract | `BrowserInteract(https://example.com:443)` |
| BrowserPage | `BrowserPage(reset)` |
| Task/SlashCommand | 不自动生成规则 |

Browser 权限按规范化 origin 抽象，不包含 URL query value、输入文本、ref 或页面内容。
`BrowserSnapshot`、`BrowserWait`、`BrowserInspect` 为 ReadOnly；导航、交互与页面管理为
Execute。跨 origin 顶层跳转必须重新调用 `BrowserNavigate`，不能继承旧 origin 的授权。

## 轮次上限

可为一次任务设置显式模型回合上限：

```json
{
  "maxTurns": 100
}
```

- `0` - 禁用对话
- `-1` - 不限制回合数
- `N > 0` - 限制为 N 个模型回合；YOLO 模式也遵守显式上限

输出截断恢复、未完成意图纠正、结构化输出纠正、验证/委派要求、空回复恢复、Stop hook 和中途输入触发的续跑，均不能绕过该上限。最后一个允许回合仍可直接正常完成；未越过输出边界的上下文超限重放仍按同一回合处理。

交互式 TUI 达到上限后询问是否继续：选择“继续”会先压缩并提交会话检查点，再重置回合计数；选择“停止”结束任务。等待选择期间取消会终止任务，不再开始压缩。非交互式调用未提供续跑回调时返回 `max_turns_exceeded`，不额外请求模型。已耗尽预算的本轮输入会被确认消费，不因 Web 重载或进程恢复自动重放；尚未消费的后续输入仍留在队列中。

Runtime 自动生成的纠正、Stop hook 与续跑控制提示保留在模型上下文，但不会作为用户消息显示在会话记录或导出中。该规则依赖消息元数据，不会隐藏用户输入的相同文字；旧记录没有隐藏标记时不做文本猜测或自动改写。

## CLI 参数

```bash
# 指定权限模式
blade --permission-mode default
blade --permission-mode autoEdit
blade --permission-mode plan
blade --permission-mode yolo
blade --yolo  # 等同于 --permission-mode yolo

# 指定轮次上限
blade --max-turns 50
```

## 最佳实践

### 1. 保护敏感文件

```json
{
  "deny": [
    "Read(**/.env*)",
    "Read(**/*.pem)",
    "Read(**/*.key)",
    "Read(**/secrets/**)",
    "Read(**/.git/config)"
  ]
}
```

### 2. 限制危险命令

```json
{
  "deny": [
    "Bash(rm -rf *)",
    "Bash(sudo *)",
    "Bash(chmod 777 *)",
    "Bash(> /dev/*)",
    "Bash(curl * | bash)",
    "Bash(wget * | bash)"
  ]
}
```

### 3. 按项目类型放行

Node.js 项目：

```json
{
  "allow": [
    "Bash(npm *)",
    "Bash(pnpm *)",
    "Bash(yarn *)",
    "Bash(node *)",
    "Bash(npx *)"
  ]
}
```

Python 项目：

```json
{
  "allow": [
    "Bash(python *)",
    "Bash(pip *)",
    "Bash(poetry *)",
    "Bash(pytest *)"
  ]
}
```

### 4. 使用 settings.local.json

个人信任规则放在 `settings.local.json`，避免提交到仓库：

```json
{
  "permissionMode": "autoEdit",
  "permissions": {
    "allow": [
      "Bash(npm run build*)",
      "Bash(docker *)"
    ]
  }
}
```

## 相关资源

- [配置系统](config-system.md) - 完整配置说明
- [Plan 模式](../guides/plan-mode.md) - Plan 模式详解
