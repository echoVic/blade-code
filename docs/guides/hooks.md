# Hooks 系统

Hooks 在工具、会话和控制流边界运行自动化检查。配置型 Hook 可能执行 shell
命令或访问网络，因此 Blade 默认不执行未信任项目的 Hook。

## 支持的事件

| 事件 | 触发边界 |
| --- | --- |
| `PreToolUse` | 工具执行前，可拒绝或修改输入 |
| `PostToolUse` | 工具成功后，可追加上下文或修改输出 |
| `PostToolUseFailure` | 工具失败后 |
| `PermissionRequest` | 请求用户授权时 |
| `Elicitation` | MCP 请求展示前，可提供或拒绝输入 |
| `ElicitationResult` | MCP 输入返回 server 前，可复核或修改 |
| `UserPromptSubmit` | 用户提交消息时 |
| `SessionStart` / `SessionEnd` | 会话启动和结束 |
| `Stop` / `SubagentStop` | 主 Agent 或子 Agent 准备停止时 |
| `Notification` | 通知投递时 |
| `Compaction` | 上下文压缩前 |

配置型 Hook 支持 `command`、`http` 和 `prompt`。`function` Hook 只能由应用或插件
通过 `HookManager.registerFunction()` 注册，不能写入 JSON。

## 配置

Hook 可配置在用户级 `~/.blade/settings.json`，或项目级
`.blade/settings.json`、`.blade/settings.local.json`：

```json
{
  "hooks": {
    "enabled": true,
    "defaultTimeout": 60,
    "timeoutBehavior": "ignore",
    "failureBehavior": "ignore",
    "maxConcurrentHooks": 4,
    "PostToolUse": [
      {
        "name": "format-typescript",
        "matcher": {
          "tools": ["Write", "Edit"],
          "paths": ["**/*.ts", "**/*.tsx"]
        },
        "hooks": [
          {
            "type": "command",
            "command": "bunx biome format --write .",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

`timeout` 和 `defaultTimeout` 的单位均为秒。Matcher 支持：

- `tools`：工具名、数组、管道分隔值或正则。
- `paths`：文件 glob。
- ApplyPatch 会把全部 source、destination 和 Move to 路径交给 matcher；
  `ApplyPatch(src/**)` 或 `paths: ["src/**"]` 在任一文件命中时触发。
- `commands`：Bash 命令正则。

Command Hook 在目标 workspace 中启动。HookInput 以 JSON 写入 stdin，同时只暴露
`BLADE_PROJECT_DIR`、`BLADE_SESSION_ID`、`BLADE_HOOK_EVENT`、
`BLADE_TOOL_NAME`、`BLADE_TOOL_USE_ID` 和必要系统环境。API key、token 等敏感环境
变量不会传入 Hook 子进程。stdin 限制为 100 KiB，stdout/stderr 各限制为 1 MiB；
timeout 或 abort 会回收完整进程树。

`ElicitationResult` Hook 可以看到 MCP Form content。Form 只能用于非敏感数据；
API key、OAuth、支付和其他秘密应使用 URL elicitation。配置型 Elicitation Hook
仍受精确 Hook Trust 摘要保护，返回的 content 会再次按 MCP requested schema 校验。

HTTP Hook 固定使用 POST JSON。默认要求 HTTPS，拒绝 redirect、loopback、link-local
和私网地址；只有显式 `httpPolicy.allowedHosts` 或对应策略开关才能放行。

## 项目信任

Blade 对 effective Hook config 做稳定规范化并计算 SHA-256。摘要覆盖所有配置型
Hook、matcher、超时/失败策略和 HTTP 策略，不包含进程内 Function Hook。

这一层独立于 [Workspace Trust](workspace-trust.md)：Folder Trust 控制项目配置和
资源是否可加载，Hook Trust 控制当前精确 Hook 摘要是否可执行。信任 workspace 不会
自动批准新增或修改后的 Hook。

信任状态：

| 状态 | 行为 |
| --- | --- |
| `disabled` | Hooks 配置关闭 |
| `not_required` | 只有应用注册的 Function Hook |
| `untrusted` | 配置型 Hook 不执行 |
| `trusted` | 当前摘要可以执行 |
| `modified` | 配置已改变，旧信任立即失效 |
| `error` | 信任存储异常，配置型 Hook fail closed |

信任按 canonical project path 保存到 `~/.blade/hook-trust.json`。文件使用原子写和
`0600` 权限；符号链接、错误 owner、宽松权限、未知字段或损坏内容都会 fail closed。
Git linked worktree 使用 common checkout 作为信任身份，因此源码项目与执行 worktree
共享同一个摘要信任；monorepo 子项目会保留相对仓库根的路径，不会互相覆盖，也不会
依赖全局当前 Session。

在 TUI、headless 或 ACP 中使用：

```text
/hooks status
/hooks list
/hooks trust
/hooks revoke
```

ACP 通过标准 callback 返回相同状态。Web 在 `Settings → Hooks` 中展示每个事件、
matcher、Hook 类型、有界目标预览和摘要；HTTP URL 不投影凭据、query 或 fragment。
Trust/Revoke 都有显式二次确认。

信任操作带 reviewed digest。若配置在 review 与提交之间变化，服务返回 `409`，要求
重新加载后再确认。任何配置变化都会进入 `modified`，不会继承旧批准。

## 执行顺序

```text
用户请求 → PreToolUse → 权限合并/确认 → 工具执行
                                      → PostToolUse
                                      → PostToolUseFailure
MCP 工具 → Elicitation → 用户/Hook 响应 → ElicitationResult → MCP server
```

PreToolUse 和 PermissionRequest Hook 只能收紧工具权限，不能绕过 deny 规则。多个需要
用户确认的 shared 工具会串行审批，避免 Web 的 pending permission 被覆盖。

## 错误策略

- exit code `0`：成功。
- exit code `1`：非阻塞错误。
- exit code `2`：阻塞错误。
- exit code `124`：超时。
- `timeoutBehavior` / `failureBehavior` 可设为 `ignore`、`deny` 或 `ask`。

不要把仓库中的 Hook 当作普通配置审阅。Trust 表示允许这些命令、prompt 和 HTTP
目标以当前用户权限运行；必须先检查完整定义。个人 Hook 建议放入
`settings.local.json`，不要提交凭据或令牌。

## 相关资源

- [配置系统](../configuration/config-system.md)
- [权限控制](../configuration/permissions.md)
- [测试与生产准出](../testing/qualification.md)
