# Session Service Tier

Blade treats inference service tier as a durable configuration owned by the Session itself, not a process-global switch. TUI, Web, ACP, and concurrent Sessions within the same process can choose different tiers; original choices are preserved after Runtime reconstruction, task retry, fork, and subagent inheritance.

Service tier affects Provider pricing, queuing, and latency semantics. Blade does not silently switch to other tiers when the Provider rejects, rate-limits, or does not support the selection.

## Selection and Capabilities

Public selection values are:

```text
auto
standard
fast
flex
```

- `auto`: does not send an override value, preserves Provider or model default policy;
- `standard`: explicitly returns to baseline service;
- `fast`: requests Provider's low-latency or priority channel;
- `flex`: requests Provider's low-cost, delayable channel.

Explicit selections are not silently downgraded. When the current model does not support the selected tier, switching fails before replacing the Provider service. All models support `standard`; OpenAI-compatible models support `standard/fast/flex`; Claude Opus 4.6 with Claude Fast Mode support supports `standard/fast`.

`GET /models` projects for each model:

```json
{
  "supportedServiceTiers": ["standard", "fast", "flex"]
}
```

Web and ACP only display explicit tiers actually supported by the current model.

## TUI

```text
/speed
/speed auto
/speed standard
/speed fast
/speed flex
/fast
/fast on
/fast off
```

Argument-free `/speed` shows selected, effective, Provider value, and supported tiers. `/fast` is a quick entry: no argument shows status, `on` selects `fast`, `off` selects `standard`. The status bar shows `Speed fast`, `Speed standard`, or `Speed flex` for non-`auto` selections.

## Web

Custom Popover is provided next to model and reasoning effort selectors in Task Home and Session Composer. Both task dispatch and message requests send the same `serviceTier`:

```json
{
  "modelId": "gpt",
  "reasoningEffort": "high",
  "serviceTier": "fast",
  "responseVerbosity": "high",
  "communicationStyle": "explanatory"
}
```

When switching to a model that does not support the current explicit tier, Composer returns to `auto` rather than displaying `fast` as another tier. `session.updated`, catalog restoration, and fresh page load all restore selection from durable Session metadata.

## ACP

ACP Session setup exposes a standard select config option:

```text
id: service_tier
category: model
```

Clients switch via `session/set_config_option`. Options and current values are returned together with model, `reasoning_effort`, `response_verbosity`, `communication_style` config options without requiring Blade-private extensions.

## Atomic Switching

Model, reasoning effort, service tier, response verbosity, and communication style form the same Session settings group:

1. Validate the four Session controls against the target model;
2. Create and initialize new Provider service;
3. Atomically replace old service in Runtime;
4. Persist model and four selection values in one `session_updated`;
5. Publish one `session.updated`.

The five cannot be switched during active turns. When durable writing fails, Blade restores Runtime with previous model/effort/tier/verbosity/style quintuple settings; when new Provider initialization fails, old service remains usable. JSONL only stores user selections, not effective or Provider values that can be recalculated.

Skill temporary model overrides, Tasks, Teams, background/resume, retry, and fork all inherit the current Session's service tier. When the target model does not support the explicit tier, fails closed rather than discarding the tier to continue execution.

## Provider Mapping

| Blade Selection | OpenAI Responses/Completions | Claude Opus 4.6 |
|-----------------|------------------------------|-----------------|
| `auto` | No override | No override |
| `standard` | `service_tier: "default"` | Do not send fast configuration |
| `fast` | `service_tier: "priority"` | `speed: "fast"` |
| `flex` | `service_tier: "flex"` | Not supported |

Claude `fast` also merges `anthropic-beta: fast-mode-2026-02-01` without overwriting existing model beta headers. OpenAI Responses uses pi-ai's structured `serviceTier` option; Chat Completions and Anthropic project request fields through payload hooks.

## Production Qualification

Deterministic tests must cover complete vocabulary, model capability projection, unsupported fail closed, Provider payload/header mapping, Runtime service atomic replacement, active-turn rejection, JSONL recovery, fork/retry/subagent inheritance, persistence failure rollback, Web Popover, TUI slash routing, and ACP config option.

Real GPT qualification completes two rounds of requests through a local transparent proxy that does not record Authorization. The first round must use `low + fast + low`, after destroying Runtime restored from durable metadata to `high + standard + high` for the second round; the proxy must directly observe respectively:

```json
{ "reasoning_effort": "low", "service_tier": "priority", "verbosity": "low" }
{ "reasoning_effort": "high", "service_tier": "default", "verbosity": "high" }
```

Production Web GUI must complete the first round from Task Home at `low + fast + low`, then switch to `high + standard + high` from Session Composer for subsequent turns; fresh load must simultaneously restore complete messages and Session settings. Responses, JSONL, and request bodies must be three-way consistent, both upstream responses must be `200 text/event-stream`, and evidence files must not contain API keys.
