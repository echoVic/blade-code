# Builtin Tool Strict Sampling Decision

**Date:** 2026-10-12
**Target:** `blade-code` 0.11.16
**Status:** Decided — strict sampling stays off for builtin tools
**Capability:** Provider-side constrained decoding (`strict` function tools) for Blade's builtin tool catalog

## Decision summary

Blade will **not** request strict (constrained) tool sampling for builtin tools.
Builtin tool declarations keep sending their full JSON Schema without a
`constrainedSampling` config, and the host stays the single authority that
validates arguments and returns correctable errors (`invalid_tool_parameters`,
`invalid_tool_arguments`, `unknown_tool`).

The reserved `StructuredOutput` tool keeps
`constrainedSampling: { type: 'json_schema', strict: 'prefer' }` (see
[Schema-Constrained Structured Output](../../en/reference/schema-constrained-output.md)).
Its schema is user-supplied, it is called once per turn, and its host
validation already reverses the strict optional-field `null` rewrite.

The unused `Tool.strict` / `ToolConfig.strict` field is removed. Seven builtin
tools set it to `true` with the comment "enable OpenAI Structured Outputs", but
nothing read it, so it never reached any Provider request.

## Why this was considered

Strict sampling promises that the model can only emit arguments matching the
schema, which looks like a free fix for malformed tool calls. Before enabling
it, the change was measured with real Providers instead of assuming the
benefit.

## Evidence

All probes ran against real Provider endpoints on 2026-10-12. No credential or
response body is stored here.

### 1. Malformed calls are already rare, and of the wrong kind

A scan of 1,436 local Session JSONL files (16,122 tool results) found 25
calls rejected before execution (0.16%):

| Class | Count |
| --- | --- |
| Read `file_path` not absolute | 20 |
| Bash `timeout` above the 300000 ms maximum | 3 |
| Write parameter error | 1 |
| Unknown tool name | 1 |
| Invalid JSON arguments | 0 |

None of the 16,153 recorded tool-call inputs carried a `null` value.

### 2. Not every builtin schema is strict-convertible

pi-ai's `makeStrictJsonSchema` converts 35 of 39 builtin tool schemas. Bash,
WebFetch, TaskCreate and TaskUpdate use `patternProperties` and silently fall
back to non-strict under `strict: 'prefer'`. ConfigTool's `value:
Type.Unknown()` converts locally but OpenAI rejects the whole request:

```text
Invalid schema for function 'ConfigTool': At schema path
/properties/value/anyOf/0, schema must specify a type
```

Enabling strict therefore needs per-tool schema surgery before it is even safe
to send.

### 3. Most Providers do not enforce it

Probe: one `Read` tool whose `encoding` enum is `utf8 | base64 | binary`, the
prompt asks for `"latin1"`, `tool_choice: required`, 3 attempts each.

| Provider / endpoint | strict | Result |
| --- | --- | --- |
| DeepSeek `/chat/completions` | on | 3/3 `latin1` (not enforced) |
| DeepSeek `/beta/chat/completions` | on | 3/3 `latin1` (not enforced) |
| Claude via OpenAI-compatible gateway | on | 3/3 `latin1` (not enforced) |
| GPT-5.5, `parallel_tool_calls: false` | on | 3/3 `utf8` (enforced) |

Custom Anthropic Providers do not send `strict` at all. Only GPT enforces the
schema, and it requires disabling parallel tool calls to do so.

### 4. Where it is enforced, it corrupts values instead of failing

The two dominant historical failure classes were replayed against GPT-5.5 with
strict on (3 attempts each, `parallel_tool_calls: false`, the absolute-path
rule expressed as a schema `pattern`):

| Request | Strict result |
| --- | --- |
| Read `file_path` `"src/app.ts"` | `"C:/workspace/src/app.ts"`, `"x:\\"`, `"//src/app.ts"` |
| Bash `timeout` `600000` (max 300000) | `600` in 3/3 |

Today these calls fail validation with an actionable message and the model
retries with a correct value. Under strict they would execute with a
fabricated path or a timeout 1000× shorter than intended, with no error to
correct.

### 5. Strict optional fields become `null`, sometimes the string `"null"`

Strict conversion makes every optional property required-but-nullable.
DeepSeek emitted optional fields as `null`, and in 5 of 6 samples emitted the
Glob `path` as the **string** `"null"`, which no host normalization can
distinguish from a real directory named `null`.

### 6. Benchmark impact

`bun run benchmark:repo` (controlled coding benchmark v2, 3 tasks), strict
applied to every builtin tool:

| Model | Run | Success | Malformed rate | Avg tokens | Avg cost | Avg latency |
| --- | --- | --- | --- | --- | --- | --- |
| deepseek-flash | baseline | 100% | 0.0% | 32,474 | $0.002259 | 6.0 s |
| deepseek-flash | strict #1 | 100% | 0.0% | 34,398 | $0.002556 | 9.0 s |
| deepseek-flash | strict #2 | 100% | 0.0% | 34,153 | $0.002508 | 7.7 s |
| gpt-5.5 | baseline | 100% | 0.0% | 49,922 | n/a | 41.3 s |
| gpt-5.5 | strict #1 | 100% | **31.3%** | 64,733 | n/a | 38.3 s |
| gpt-5.5 | strict #2 | 100% | 0.0% | 47,642 | n/a | 28.1 s |

- DeepSeek gains nothing measurable and pays +5–6% tokens, +11–13% cost and
  higher latency for the larger strict schemas.
- GPT strict run #1 produced five `Edit` calls with empty `{}` arguments and
  was flagged `REGRESSED` by the benchmark's own regression gate. A raw stream
  probe reproduced empty arguments for both parallel `Edit` calls in 1 of 4
  strict runs (0 of 4 without strict).

### 7. Peer practice

Codex sets `strict: false` on its shell tool and on most function tool specs,
keeping strict for a few narrow schemas.

## Consequences

- Builtin tool requests are unchanged on the wire; this release only removes
  the dead `strict` field and adds an inventory test that fails if a builtin
  tool starts requesting constrained sampling.
- Malformed builtin calls keep returning stable `error.code` values so the
  model can self-correct and the benchmark can track the rate.
- Revisit when a Provider used by Blade enforces strict schemas with parallel
  tool calls enabled, rejects out-of-range values instead of rewriting them,
  and the benchmark shows a malformed-rate reduction without a token or cost
  regression. Any future opt-in should be per tool, limited to schemas whose
  constraints cannot be satisfied by fabricating values.
