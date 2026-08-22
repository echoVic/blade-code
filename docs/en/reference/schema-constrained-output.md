# Schema-Constrained Structured Output

Blade supports specifying a JSON Schema for a single turn, and only returns a canonical JSON object after the host completes validation. This capability is not "prompting the model to output JSON": the schema is a runtime contract, the model must call the host-reserved `StructuredOutput` tool, and ordinary prose, Markdown code blocks, or parameters that fail the schema cannot complete the turn.

## Entry Points

### Print and Headless

Inline schema:

```bash
blade --print \
  --json-schema '{"type":"object","properties":{"answer":{"type":"string"}},"required":["answer"],"additionalProperties":false}' \
  "Return an answer"
```

Schema file:

```bash
blade --headless --output-schema ./answer.schema.json "Return an answer"
```

`--json-schema` and `--output-schema` are mutually exclusive. Neither can be used with interactive shell commands.

- `--print --output-format text` and Headless text write only the final JSON object to stdout;
- Print `json` adds `structured_output` and `output_schema_digest` alongside compatible fields;
- Print `stream-json` outputs the `structured_output` terminal state;
- Headless `jsonl` outputs a version 1 `structured_output` event.

### Web

The `{}` control in the Composer toolbar provides a per-turn JSON Schema editor. The schema is bound to the draft and cleared after successful submission. Schema switching is not allowed for running turns.

HTTP request:

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

`POST /sessions/:sessionId/message` and `POST /tasks` both accept `outputSchema`. Web SSE projects the final object as `structured.output`, and fresh history restores the same structured card from assistant metadata.

### ACP

ACP uses extended metadata:

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

Success response:

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

## Schema Authority

The host performs complete validation before durable input:

1. root must be a JSON object schema, and `type` must be `object`;
2. schema maximum size 64 KiB, 20 levels, 1000 nodes, 200 properties;
3. Only self-contained `$ref` of `#`, `#/$defs/...`, and `#/definitions/...` are allowed;
4. Final object maximum size 128 KiB;
5. Both schema and object are validated by AJV on the host side, with no default value filling or field cleaning;
6. Schema SHA-256 digest is returned with canonical metadata and protocol output.

Blade uses the schema directly as the parameter schema for `StructuredOutput`, and sets pi-ai `constrainedSampling: { type: "json_schema", strict: "prefer" }`. Providers that support strict tool sampling constrain at the sampling stage; other providers use the same tool protocol with final adjudication by the host.

## Retry and Completion Semantics

- After the first tool-free prose or schema-invalid tool call, the host provides at most two correction opportunities;
- After three failures returns `structured_output_failed`, without guessing, parsing, or patching prose;
- Successful payload becomes the final result only after normal completion, delegation, worktree, and verification gates;
- When mutation or user steering occurs after payload, the old payload immediately becomes invalid and must be resubmitted;
- `StructuredOutput` is an invocation-scoped reserved tool that does not appear in the global tool catalog and is not hidden by user allowlists.

## Durable Recovery

Schema is fsynced to Session inbox along with input; Task additionally writes `taskDispatch`, so queue, retry, and process restart preserve the original contract.

Accepted tool-result metadata stores payload and digest. If the process exits between accepted tool and canonical assistant message, the next owner recovers from the tool result; if the canonical message has been persisted but inbox ack is not yet complete, the next owner directly replays the completion result without requesting the model again. Fork and rewind follow ordinary conversation lifecycle: completed assistant messages can be inherited, and results after checkpoint can be deleted by rewind.
