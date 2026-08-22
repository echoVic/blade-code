# Session Response Verbosity

Blade treats native Provider response verbosity as a durable configuration owned by the Session itself, not a process-global switch or display preference that only affects system prompts. TUI, Web, ACP, and concurrent Sessions within the same process can choose different verbosities; original choices are preserved after Runtime reconstruction, task retry, fork, and subagent inheritance.

## Selection and Capabilities

Public selection values are:

```text
auto
low
medium
high
```

- `auto`: does not send an override value, preserves Provider or model default policy;
- `low`: requests compact responses;
- `medium`: requests balanced responses;
- `high`: requests more complete, more detailed responses.

Explicit selections are not silently discarded or downgraded. When the current model does not support native verbosity, switching fails before replacing the Provider service; fallback models must also pass the same capability validation.

Blade currently exposes explicit selection for the following models:

- `openai-codex-responses` models;
- GPT-5 series models using OpenAI Chat Completions, Responses, or Azure OpenAI Responses.

Other models only offer `auto`. `GET /models` projects for each model:

```json
{
  "supportedResponseVerbosities": ["low", "medium", "high"]
}
```

Web and ACP only display explicit values actually supported by the current model.

## TUI

```text
/verbosity
/verbosity auto
/verbosity low
/verbosity medium
/verbosity high
/detail high
```

`/detail` is an alias for `/verbosity`. Without arguments shows selected, effective, and supported values; switching is not allowed during active turns. The status bar shows `Output low`, `Output medium`, or `Output high` for non-`auto` selections.

## Web

Task Home and Session Composer provide custom Popover alongside model, reasoning effort, and service tier. Both task dispatch and message requests send the same `responseVerbosity`:

```json
{
  "modelId": "gpt",
  "reasoningEffort": "high",
  "serviceTier": "standard",
  "responseVerbosity": "high",
  "communicationStyle": "explanatory"
}
```

When switching to a model that does not support the current explicit value, Composer returns to `auto` rather than continuing to display an unexecutable selection. `session.updated`, catalog restoration, and fresh page load all restore selection from durable Session metadata.

## ACP

ACP Session setup exposes a standard select config option:

```text
id: response_verbosity
category: model
```

Clients switch via `session/set_config_option`. Options and current values are returned together with model, `reasoning_effort`, `service_tier`, `communication_style` config options without requiring Blade-private extensions.

## Atomic Switching

Model, reasoning effort, service tier, response verbosity, and communication style form the same Session settings group:

1. Validate the four Session controls against the target model;
2. Create and initialize new Provider service;
3. Atomically replace old service in Runtime;
4. Persist model and four selection values in one `session_updated`;
5. Publish one `session.updated`.

The five cannot be switched during active turns. When durable writing fails, Blade restores Runtime with previous model/effort/tier/verbosity/style quintuple settings; when new Provider initialization fails, old service remains usable. JSONL only stores user selections, not effective or Provider values that can be recalculated.

Skill temporary model overrides, Tasks, Teams, background/resume, retry, and fork all inherit the current Session's response verbosity. When the target or fallback model does not support explicit values, fails closed rather than discarding verbosity to continue execution.

## Provider Mapping

| Provider API | Request Projection |
|--------------|--------------------|
| OpenAI Chat Completions | Top-level `verbosity` |
| OpenAI/Azure Responses | `text.verbosity` |
| OpenAI Codex Responses | pi-ai `textVerbosity` |

When Responses payload already has `text.format`, Blade merges `verbosity` rather than overwriting the format. service-tier and verbosity payload hooks also execute in combination; neither can lose the other.

## Production Qualification

Deterministic tests must cover complete vocabulary, model capability projection, unsupported and fallback fail closed, three Provider payload mappings, payload hook merging, Runtime service atomic replacement, active-turn rejection, JSONL recovery, fork/retry/subagent inheritance, persistence failure rollback, Web Popover, TUI slash routing, and ACP config option.

Real GPT qualification completes two rounds of requests through a local transparent proxy that does not record Authorization. The first round must use `low + fast + low`, after destroying Runtime restored from durable metadata to `high + standard + high` for the second round; the proxy must directly observe respectively:

```json
{
  "reasoning_effort": "low",
  "service_tier": "priority",
  "verbosity": "low"
}
{
  "reasoning_effort": "high",
  "service_tier": "default",
  "verbosity": "high"
}
```

Production Web GUI must complete the first round from Task Home, then the second round after switching from Session Composer; fresh load must restore complete messages and `high + standard + high`. Both upstream responses must be `200 text/event-stream`, JSONL, request body, and UI must be three-way consistent, and evidence files must not contain API keys.
