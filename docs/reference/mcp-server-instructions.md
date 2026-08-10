# MCP Server Instructions

Blade 读取 MCP `InitializeResult.instructions`，将它作为当前连接提供的工具使用说明。
instructions 不是 Blade、项目或用户指令，不能获得更高权限。

## Session 生命周期

每个 Session 私有 MCP client 在 initialize 完成后读取一次 instructions：

```text
connect generation N
  -> hash complete source + normalize bounded projection
  -> publish instructions added
  -> provider boundary receives scoped documentation

transport closed
  -> publish instructions removed
  -> remove prior documentation from in-memory model context

connect generation N+1
  -> publish the new immutable instructions
```

同名 server 重连后不会继续使用旧 generation 的 instructions。新 Agent/executor 从
当前 Session snapshot 开始，动态连接变化通过单调 revision 发布。

## 安全边界

instructions 来自外部 server，进入模型前执行：

- NFKC Unicode normalization；
- 移除 Unicode `Cf`、`Co`、`Cn`、方向控制、tag、private-use 和不安全 C0 字符；
- normalization 前 source 最多读取 1 MiB；
- 每 server 最多 8 KiB；
- 每 Session 所有 server 累计最多 32 KiB；
- 保存 source bytes、projected bytes、SHA-256、truncated 和 detailsOmitted；
- server 名与正文使用 JSON literal 编码，并额外转义 `<`、`>`、`&`，不能闭合
  `<system-reminder>`；
- reminder 明确声明内容仅是对应 server 的外部不可信工具文档。

server instructions 不能：

- 覆盖 system、user、project、permission、trust 或 safety 指令；
- 授权工具调用、网络操作或 destructive action；
- 请求凭证、宿主文件或其他 Session 数据；
- 把自身内容提升为 system message。

## Provider Context

本地 TUI、Web 和 headless Session 在 provider boundary 注入当前 instructions。每个
server 使用带 provenance metadata 的独立控制消息。连接撤销时，Blade 删除该 server
此前的控制消息；snapshot replacement 会先清理全部 stale instruction messages。

ACP remote Session 只保留 source bytes、SHA-256 和 lifecycle，不把 server-controlled
正文或宿主路径发送到模型/IDE：

```text
detailsOmitted=true
projectedBytes=0
sha256=<raw-source-hash>
```

## 用户投影

- TUI：`MCP Instructions` 完成态卡片；
- Headless JSONL：`mcp_instructions_changed`；
- Web：`mcp.instructions.changed`；
- Subagent Web：`subagent.mcp.instructions.changed`；
- ACP：`agent_message_chunk` provenance 摘要；
- `/mcp instructions [server]`：查看当前 Session snapshot；
- Web MCP 面板：显示安全正文、SHA-256 和 truncation 状态。

## 验证

真实 stdio fixture 使用两代进程：

1. V1 instructions 提供 `INSTRUCTION_CODE_42`；
2. 首代进程崩溃后发布 removed；
3. 恢复连接提供 V2 与 `INSTRUCTION_CODE_84`；
4. 旧正文不再生效；
5. ACP snapshot 不含正文；
6. 两代 PID 都被回收。

真实 GPT 与生产 DeepSeek Web GUI 均在用户未提供 code 的情况下，从 scoped server
instructions 得到参数并调用工具。fixture 同时包含隐藏 Unicode 和伪
`</system-reminder>` override；模型仍完成限定轨迹，GUI、trace 与 transcript 不含
隐藏字符或凭证。

## 相关资源

- [MCP Session 隔离](mcp-session-isolation.md)
- [MCP 动态工具目录](mcp-dynamic-catalog.md)
- [MCP Completion](mcp-completion.md)
- [MCP 故障恢复](mcp-fault-recovery.md)
- [MCP Logging 与诊断](mcp-logging.md)
- [测试与生产准出](../testing/qualification.md)
