# Session-scoped LSP Code Intelligence

Blade 可通过 Language Server Protocol 提供 definition、references、hover、symbols、
implementation、call hierarchy 和增量诊断。LSP 不是进程全局服务：每个
`SessionRuntime` 持有自己的配置快照、连接、打开文件版本和诊断去重状态。

## 配置

LSP 可配置在用户或受信项目的 `config.json` / `settings.json`：

```json
{
  "lspServers": {
    "typescript": {
      "command": "typescript-language-server",
      "args": ["--stdio"],
      "extensionToLanguage": {
        ".ts": "typescript",
        ".tsx": "typescriptreact"
      },
      "initializationOptions": {},
      "settings": {},
      "startupTimeout": 10000,
      "shutdownTimeout": 2000,
      "requestTimeout": 10000,
      "diagnosticWaitTimeout": 750,
      "maxRestarts": 3
    }
  }
}
```

`command` 通过参数数组启动，不经过 shell。环境只继承冻结的 Session 环境和该服务器
的 `env`；不会复制任意宿主凭据。扩展名统一规范为小写并带 `.`。服务器数量、参数、
扩展映射、JSON options、超时和重启次数都有硬上限，未知字段 fail closed。

插件可以在根目录提供 `.lsp.json`。服务器名称会变成
`plugin:<plugin-name>:<server-name>`；`${BLADE_PLUGIN_ROOT}` 和
`${CLAUDE_PLUGIN_ROOT}` 在 immutable plugin package root 内展开。

## Workspace 与 Session

- 用户配置始终可用；项目 `lspServers` 和项目插件必须先通过 Workspace Trust。
- Session 创建时解析 source `projectRoot` 并冻结配置。
- Git worktree 或 task worktree 使用执行 `workspaceRoot` 初始化服务器，不会回到源码
  checkout。
- foreground/background Task、Team 和 resume child 显式继承父 Session 快照。
- 多个 Session 即使使用同名服务器，也各自持有独立进程、环境、打开文件和诊断。
- ACP 文件由客户端持有，Blade 不会在宿主机对 ACP Session 启动本地 LSP。

## 工具与诊断

`LSP` 是 deferred read-only 工具。模型先通过 `ToolSearch` 加载 schema，然后可调用：

- `goToDefinition`
- `findReferences`
- `hover`
- `documentSymbol`
- `workspaceSymbol`
- `goToImplementation`
- `prepareCallHierarchy`
- `incomingCalls`
- `outgoingCalls`
- `diagnostics`

每轮 provider 请求都会重新解析已激活的 deferred schemas，因此 ToolSearch 后的下一轮
可以真正调用 LSP。

成功的 `Edit` / `Write` 会向同一 Session 连接发送 `didOpen`、`didChange` 和
`didSave`。`publishDiagnostics` 按严重度排序、跨轮去重并限制为每文件 10 条、总计
30 条，作为 `<new-diagnostics>` 附加到工具结果。配置 LSP 后不再重复运行
AutoVerify package script。

## 生命周期

服务器按文件扩展名懒启动。相同服务器的并发启动共享 Promise；ContentModified 请求
使用有界退避；请求支持 timeout 和 turn abort。崩溃后清理打开文件状态并在下次调用时
重启，超过 `maxRestarts` 后 fail closed。

`SessionRuntime.dispose()` 先发送 LSP `shutdown` / `exit`，随后通过 owned process tree
完成 `SIGTERM` / `SIGKILL` 或 Windows tree cleanup，并等待进程退出。初始化失败、请求
取消、Web terminal task 终态和子 Session 结束都走同一回收协议。

## 资格验证

确定性测试使用真实 stdio JSON-RPC 子进程验证协议、诊断、双 Session 隔离、ACP
禁用、崩溃重启、取消和 PID 回收。真实 GPT 必须完成 ToolSearch → LSP hover →
Write → 被动诊断；生产 DeepSeek Web GUI 必须展示 Trust review、语义工具调用、
诊断回注、终态进程归零和 fresh-tab 零 console error。
