# MCP Logging 与诊断

Blade 为每个 Session 私有 MCP client 实现标准 `logging/setLevel` 和
`notifications/message`。日志用于用户诊断，不是工具结果，也不会进入模型上下文。

## 协议生命周期

连接完成后，如果 server 声明 `logging` capability，client 会发送当前最低日志级别：

```json
{
  "mcpServers": {
    "review": {
      "type": "stdio",
      "command": "review-mcp",
      "logging": {
        "enabled": true,
        "level": "warning"
      }
    }
  }
}
```

- logging 默认启用，默认级别为 `warning`；
- 支持 `debug`、`info`、`notice`、`warning`、`error`、`critical`、`alert`、
  `emergency`；
- 未声明 capability 的 server 不会收到 `logging/setLevel`；
- server 虽已协商级别，Blade 仍在客户端再次过滤低于阈值的 notification；
- 连接恢复后会在新 transport 上重新协商当前运行时级别；
- `/mcp log-level <server> <level>` 可调整当前 Session，不修改其他 Session 的快照。

日志协商失败不会破坏 tools/resources 连接；Blade 生成一条有界 warning 诊断。

## 安全边界

`notification.params.data` 是不可信输入。进入任何 UI 前会执行：

- 最大深度 6、128 nodes、每对象 64 keys、每数组 64 items；
- 安全投影最多 16 KiB，显示 message 最多 8 KiB；
- logger 最多 256 bytes；
- URL、Bearer、`sk-*` 和敏感 key（token/password/secret/cookie/API key 等）脱敏；
- `_meta` 递归丢弃，控制字符移除；
- 每个 client 每秒最多接收 64 条，超限生成一次 synthetic drop marker；
- 每 server 保留 64 条、每 Session 保留 256 条内存 ring。

每条日志包含安全投影的 SHA-256、bytes、truncated 与 detailsOmitted 标志。Session
dispose 会清空 ring，不创建由 server 名称或 logger 控制的宿主路径。

ACP remote Session 不暴露 server-controlled message、logger 或宿主路径，只投影：

```text
[MCP log details omitted; sha256=<safe-projection-hash>]
```

## Provider 隔离

MCP 日志只生成 `mcp_log` 用户事件。Agent loop 不为它追加 system reminder、user
control message 或 tool result，因此日志中的 prompt injection marker 不会进入下一次
provider request，也不会写入 durable model transcript。

日志严重度不等于工具执行失败。TUI/Web 中所有日志均是完成态诊断卡；`error` 只影响
卡片标签颜色，不增加 failed tool count。

## 三端投影

- TUI：`MCP Log` 完成态卡片；
- Headless JSONL：`mcp_log`；
- Web Session：`mcp.log`；
- Web Subagent：`subagent.mcp.log`；
- ACP：`agent_message_chunk`，remote 只含 opaque hash；
- `/mcp logs [server] [limit]`：查询当前 Session ring；
- Web MCP 面板：查看最近日志并通过自定义 level buttons 调整协商级别。

Web 管理 API：

```text
GET  /mcp/:server/logs?limit=20&afterRevision=0
POST /mcp/:server/logging-level
```

## 验证

真实 stdio fixture 覆盖：

1. `warning` 协商后过滤 debug/info；
2. runtime 切换 `debug` 后接收全部级别；
3. nested secret、URL、token、`_meta`、大对象和突发流量；
4. ACP details omission；
5. Session ring、PID 和 transport 回收。

真实 GPT 完成 ToolSearch → logging MCP → Write，模型上下文不含任何 log marker。
生产 DeepSeek Web GUI 展示 warning/error 诊断卡、最终回复和 proof 文件，并验证
transcript、trace、PID、端口和临时目录无原始凭证残留。

## 相关资源

- [MCP Session 隔离](mcp-session-isolation.md)
- [MCP Server Instructions](mcp-server-instructions.md)
- [MCP Tool Call 生命周期](mcp-call-lifecycle.md)
- [MCP Tool Result 安全边界](mcp-tool-result-safety.md)
- [MCP 故障恢复](mcp-fault-recovery.md)
- [测试与生产准出](../testing/qualification.md)
