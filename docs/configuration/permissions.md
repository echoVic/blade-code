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
✅ 自动批准: 只读工具（Read、Glob、Grep、WebFetch、WebSearch、TaskCreate/TaskGet/TaskUpdate/TaskList、Task、Plan 工具）
❌ 需要确认: Write 工具（Edit、Write、ApplyPatch、NotebookEdit）、Execute 工具（Bash、Skill、SlashCommand）
```

适用场景：日常使用，平衡安全与效率。

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

## 权限规则配置

### 规则格式

```
Tool(param1:value1, param2:value2)
```

支持 `*` 和 `**` 通配符（使用 picomatch）：

```json
{
  "permissions": {
    "allow": [
      "Read",
      "Read(file_path:**/*.ts)",
      "Bash(git *)",
      "Bash(npm run *)"
    ],
    "deny": [
      "Read(file_path:**/.env*)",
      "Read(file_path:**/*.pem)",
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
    "Read(file_path:**/*.{ts,tsx,js,jsx,md,json})",
    "Write(file_path:**/*.ts)",
    "Edit(file_path:src/**/*)"
  ],
  "deny": [
    "Read(file_path:**/.env*)",
    "Read(file_path:**/*.pem)",
    "Read(file_path:**/secrets/**)",
    "Write(file_path:**/node_modules/**)"
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
    "WebFetch(url:https://api.github.com/**)",
    "WebFetch(url:https://registry.npmjs.org/**)",
    "WebSearch"
  ],
  "deny": [
    "WebFetch(url:http://**)",
    "WebFetch(url:**/admin/**)"
  ]
}
```

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

选择 `Session` 只会把抽象后的规则保存在当前 Session Runtime 内存中。Session
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
| Bash | `Bash(command:npm *)` |
| Edit/Write/ApplyPatch | `Edit(file_path:**/*.ts)` |
| WebFetch | `WebFetch(url:https://api.github.com/**)` |
| WebSearch | `WebSearch(query:*)` |
| BrowserNavigate | `BrowserNavigate(http://127.0.0.1:3000)` |
| BrowserInteract | `BrowserInteract(https://example.com:443)` |
| BrowserPage | `BrowserPage(reset)` |
| Task/SlashCommand | 不自动生成规则 |

Browser 权限按规范化 origin 抽象，不包含 URL query value、输入文本、ref 或页面内容。
`BrowserSnapshot`、`BrowserWait`、`BrowserInspect` 为 ReadOnly；导航、交互与页面管理为
Execute。跨 origin 顶层跳转必须重新调用 `BrowserNavigate`，不能继承旧 origin 的授权。

## 轮次上限

长时间任务达到轮次阈值时会暂停并询问：

```json
{
  "maxTurns": 100
}
```

- `0` - 禁用对话
- `-1` - 使用默认值（100）
- `N > 0` - 限制为 N 轮

用户可选择"继续"重置计数器，或"停止"终止任务。

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
    "Read(file_path:**/.env*)",
    "Read(file_path:**/*.pem)",
    "Read(file_path:**/*.key)",
    "Read(file_path:**/secrets/**)",
    "Read(file_path:**/.git/config)"
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
