# Schema-Constrained Structured Output

Blade 支持为单个 turn 指定 JSON Schema，并只在宿主完成校验后返回 canonical JSON
object。该能力不是“提示模型输出 JSON”：schema 是运行时契约，模型必须调用宿主保留的
`StructuredOutput` 工具，普通 prose、Markdown code block 或无法通过 schema 的参数都
不能完成 turn。

## 入口

### Print 与 Headless

inline schema：

```bash
blade --print \
  --json-schema '{"type":"object","properties":{"answer":{"type":"string"}},"required":["answer"],"additionalProperties":false}' \
  "Return an answer"
```

schema 文件：

```bash
blade --headless --output-schema ./answer.schema.json "Return an answer"
```

`--json-schema` 与 `--output-schema` 互斥。两者不能用于交互式 shell command。

- `--print --output-format text` 和 Headless text 只向 stdout 写最终 JSON object；
- Print `json` 在兼容字段外增加 `structured_output` 和
  `output_schema_digest`；
- Print `stream-json` 输出 `structured_output` 终态；
- Headless `jsonl` 输出 version 1 的 `structured_output` event。

### Web

Composer 工具栏的 `{}` 控件提供 per-turn JSON Schema 编辑器。schema 和草稿绑定；提交
成功后清除。运行中的 turn 不允许切换 schema。

HTTP 请求：

```json
{
  "content": "Return an answer",
  "projectPath": "/absolute/workspace",
  "outputSchema": {
    "type": "object",
    "properties": {
      "answer": { "type": "string" }
    },
    "required": ["answer"],
    "additionalProperties": false
  }
}
```

`POST /sessions/:sessionId/message` 和 `POST /tasks` 都接受 `outputSchema`。Web SSE
以 `structured.output` 投影最终 object，fresh history 从 assistant metadata 恢复同一
结构化卡片。

### ACP

ACP 使用扩展 metadata：

```json
{
  "_meta": {
    "outputSchema": {
      "type": "object",
      "properties": {
        "answer": { "type": "string" }
      },
      "required": ["answer"]
    }
  }
}
```

成功响应：

```json
{
  "stopReason": "end_turn",
  "_meta": {
    "structuredOutput": {
      "answer": "..."
    },
    "outputSchemaDigest": "<sha256>"
  }
}
```

## Schema authority

宿主在 durable input 前执行完整校验：

1. root 必须是 JSON object schema，且 `type` 必须是 `object`；
2. schema 最大 64 KiB、20 层、1000 个节点、200 个 properties；
3. 只允许 `#`、`#/$defs/...` 和 `#/definitions/...` self-contained `$ref`；
4. 最终 object 最大 128 KiB；
5. schema 和 object 均由 AJV 在宿主侧校验，不执行默认值填充或字段清理；
6. schema SHA-256 digest 随 canonical metadata 和协议输出返回。

Blade 把 schema 直接作为 `StructuredOutput` 的 parameter schema，并设置 pi-ai
`constrainedSampling: { type: "json_schema", strict: "prefer" }`。支持 strict tool
sampling 的 provider 在采样阶段约束；其他 provider 使用同一工具协议并由宿主最终裁决。

## Retry 与完成语义

- 首次无工具 prose 或 schema-invalid tool call 后，宿主最多提供两次纠正机会；
- 三次失败后返回 `structured_output_failed`，不会猜测、解析或修补 prose；
- 成功 payload 在 normal completion、delegation、worktree 和 verification gates 之后
  才成为最终结果；
- payload 后发生 mutation 或 user steering 时，旧 payload 立即失效，必须重新提交；
- `StructuredOutput` 是 invocation-scoped 保留工具，不进入全局工具目录，也不受用户
  allowlist 隐藏。

## Durable recovery

schema 与输入一起 fsync 到 Session inbox；Task 还会写入 `taskDispatch`，因此 queue、
retry 和进程重启保留原契约。

accepted tool-result metadata 保存 payload 和 digest。进程若在 accepted tool 与 canonical
assistant message 之间退出，下一 owner 从 tool result 恢复；若 canonical message 已落盘
但 inbox ack 尚未完成，下一 owner 直接重放完成结果，不再次请求模型。Fork 和 rewind
沿用普通 conversation lifecycle：已完成 assistant message 可继承，checkpoint 后的结果
可被 rewind 删除。
