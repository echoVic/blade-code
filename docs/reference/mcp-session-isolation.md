# MCP Session Isolation

Blade 按 Session 解析和连接 MCP。进程级 Store 只是服务器启动项目的 UI 投影，
不能作为其他 Web、ACP、TUI 或 subagent Session 的运行时配置。

## 配置来源

每个 `SessionRuntime` 使用 source project path 独立解析：

1. 用户 `~/.blade/config.json` 和 `~/.blade/settings.json`
2. 目标项目已通过 Workspace Trust 的 `.blade/config.json`
3. 目标项目已通过 Workspace Trust 的 shared/local settings
4. 用户级和目标项目已信任的 plugin MCP definitions
5. ACP session 提供的 MCP servers
6. CLI `--mcp-config`

同名服务器由靠后的来源覆盖。`--strict-mcp-config` 会忽略 workspace、plugin 和
ACP 来源，只使用 CLI 显式配置。

未信任项目的 MCP definitions 不进入解析结果。服务器从 project A 启动时，
project B 的 Session 不会继承 A 的 MCP；B 的配置也不会写回全局 Store。

## 连接生命周期

每个 Session 创建独立 `McpRegistry`：

- 不复用进程全局连接或工具对象；
- MCP tools 只注册到该 Session 的 `ToolRegistry`；
- stdio server 默认以 source project 作为 `cwd`；
- 显式相对 `cwd` 也相对 source project 解析；
- Session dispose 会断开 connected、connecting 和 error 状态的全部客户端；
- Web terminal task 在完成、失败或取消后会从 runtime cache 移除并立即 dispose；
  后续访问依靠 durable metadata 按需重建；
- project plugin MCP 只提供配置，不在应用启动时产生进程副作用。
- Form/URL elicitation 只绑定当前 MCP tool call 的 Session interaction handler；
  无交互面、调用取消或重叠 interactive call 会返回 `cancel`，不会跨 Session 串答。
- server instructions 按连接 generation 和 Session snapshot 隔离，ACP 只保留
  provenance hash；
- Completion 只读取当前 Session catalog，同名 server 的候选、并发和 cancellation
  不跨 Session；
- 实验性 MCP Tasks 默认关闭；启用后任务同时绑定 Session ID 与 execution workspace，
  只暴露 Blade `mcp_task_*`，Session dispose 会取消 watcher 和 server task。
- `roots/list` 返回冻结的执行 workspace；task worktree 不会错误暴露 source project，
  ACP remote Session 不暴露宿主本地路径。
- Sampling 默认关闭；显式启用后仍绑定当前 Session 模型和逐次权限请求，父工具取消或
  Session dispose 会终止嵌套模型调用。
- 外层 `tools/call` 直接继承 Session abort signal，并同时受 idle/hard timeout
  约束；progress 通过统一 LoopEvent 投影，不进入 transcript。
- OAuth 登录是 Session 外的显式用户操作；本地 Session 只按 endpoint/client/scopes
  消费已有凭证，ACP remote Session 不读取宿主凭证也不启动 callback/browser。
- transport 异常先撤销当前 Session 的旧目录，再通过 generation fence 执行 single-flight
  有界恢复；Session dispose 会取消退避和在建连接，恢复后的 resource subscription
  只来自该 Session 的 desired 集合。
- `tools/call` binary 和大文本使用按 Session hash 隔离的私有 artifact store；本地
  Session 可读取绝对路径，ACP remote 仅接收 opaque ID，不暴露宿主存储路径。

Task worktree 的执行路径仍是 worktree，但 MCP 配置身份和默认 cwd 使用
`taskWorktree.originalWorkspaceRoot`。这与 `projectPath` / `workspacePath`
双身份模型一致。

## CLI 配置格式

`--mcp-config` 支持文件、单服务器 JSON 和服务器映射：

```bash
blade --headless \
  --mcp-config ./mcp.json \
  --mcp-config '{"name":"review","type":"stdio","command":"review-mcp"}' \
  "review the repository"
```

文件可以直接包含服务器映射，也可以使用：

```json
{
  "mcpServers": {
    "review": {
      "type": "stdio",
      "command": "review-mcp",
      "args": ["--stdio"],
      "cwd": "services/api"
    }
  }
}
```

CLI 解析是无副作用的。显式配置只进入当前 Session，不修改 Store，也不影响并行
Session。

## 相关资源

- [MCP Elicitation](mcp-elicitation.md)
- [MCP Roots 与 Sampling](mcp-roots-sampling.md)
- [MCP Tool Call 生命周期](mcp-call-lifecycle.md)
- [MCP Tool Result 安全边界](mcp-tool-result-safety.md)
- [MCP Logging 与诊断](mcp-logging.md)
- [MCP Server Instructions](mcp-server-instructions.md)
- [MCP Completion](mcp-completion.md)
- [MCP Async Tasks](mcp-tasks.md)
- [MCP OAuth 生命周期](mcp-oauth-lifecycle.md)
- [MCP 动态工具目录](mcp-dynamic-catalog.md)
- [MCP Resources、Prompts 与订阅](mcp-resources-prompts.md)
- [MCP 故障恢复](mcp-fault-recovery.md)
- [Workspace Trust](../guides/workspace-trust.md)
- [配置系统](../configuration/config-system.md)
- [工具并发模型](tool-concurrency.md)
- [测试与生产准出](../testing/qualification.md)
