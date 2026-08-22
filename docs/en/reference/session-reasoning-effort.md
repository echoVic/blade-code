# Session Reasoning Effort

Blade treats reasoning effort as a durable configuration owned by the Session itself, not a process-global switch. TUI, Web, ACP, and concurrent Sessions within the same process can choose different effort levels, and original choices are preserved after Runtime reconstruction, task retry, fork, and subagent inheritance.

## Selection and Capabilities

Public selection values are:

```text
auto
off
minimal
low
medium
high
xhigh
max
```

`auto` is a persistent policy value. Each time a Provider is created, Blade resolves the effective level near `high` based on the current model's `thinkingLevelMap`; switching models can yield different effective levels, but UI still displays `auto`.

Explicit levels are not silently downgraded. When the model does not support the selected level, switching fails before replacing the current Provider. Models that do not support reasoning only offer `auto` and `off`, where `auto` resolves to `off`. Models that require always-on reasoning can reject `off`.

`GET /models` projects for each model:

```json
{
  "supportedReasoningEfforts": ["off", "low", "medium", "high"]
}
```

Web and ACP only display explicit levels actually supported by the current model.

## TUI

```text
/effort
/effort auto
/effort off
/effort minimal
/effort low
/effort medium
/effort high
/effort xhigh
/effort max
```

Without arguments shows selected, effective, and supported levels. `Tab` preserves quick-toggle semantics: switching between `off` and `auto`; use `/effort <level>` for precise effort. The status bar displays current selection, e.g., `Effort high`.

## Web

Custom Popover is provided next to model selectors in Task Home and Session Composer. Both task dispatch and message requests send the same `reasoningEffort`:

```json
{
  "modelId": "gpt",
  "reasoningEffort": "high",
  "serviceTier": "standard",
  "responseVerbosity": "high",
  "communicationStyle": "explanatory"
}
```

When switching to a model that does not support the current explicit level, Composer returns to `auto` rather than covertly displaying `high` as another explicit level. `session.updated`, catalog restoration, and fresh page load all restore selection from durable Session metadata.

## ACP

ACP Session setup exposes a standard select config option:

```text
id: reasoning_effort
category: model
```

Clients switch via `session/set_config_option`. Options and current values are returned together with model, `service_tier`, `response_verbosity`, `communication_style` config options; ACP hosts do not need Blade-private extensions.

## Atomic Switching

Model, reasoning effort, service tier, response verbosity, and communication style form the same Session settings group:

1. First validate the four Session controls against the target model;
2. Create and initialize new Provider service;
3. Atomically replace old service in Runtime;
4. Persist model and four selection values in one `session_updated`;
5. Publish one `session.updated`.

The five cannot be switched during active turns. If durable writing fails, Blade restores Runtime with previous model/effort/tier/verbosity/style quintuple settings; if new Provider initialization fails, old service remains usable. JSONL only stores user selections, not effective values recalculable from model capabilities.

## Provider Mapping

Effective level is projected through pi-ai's model catalog and Provider options:

- OpenAI Responses/Completions: `reasoning_effort`;
- Anthropic Messages: thinking enabled and effort;
- Google Generative AI: thinking enabled and mapped level;
- Bedrock/pi-messages: reasoning level;
- Mistral: high-reasoning modes supported by the model.

If tool continuation lacks the thinking signature required by Provider, existing compatibility protection can still disable reasoning for that request; this does not rewrite Session selection.

## Production Qualification

Deterministic tests must cover complete vocabulary, model capability projection, unsupported fail closed, Runtime service atomic replacement, active-turn rejection, JSONL recovery, fork/retry inheritance, persistence failure rollback, Web Popover, TUI slash routing, and ACP config option.

Real GPT qualification records request JSON in a local transparent proxy without recording Authorization header. The trajectory first completes a real request at `low + fast + low`, destroys Runtime, updates durable Session to `high + standard + high`, then completes a second request after reconstruction; the proxy must observe respectively:

```json
{ "reasoning_effort": "low", "service_tier": "priority", "verbosity": "low" }
{ "reasoning_effort": "high", "service_tier": "default", "verbosity": "high" }
```

Production Web GUI must complete Task Home `low` first turn, Session Composer `high` subsequent turns, and fresh load Session setting recovery; responses, JSONL, and proxy request bodies must be three-way consistent, and evidence files must not contain API keys.
