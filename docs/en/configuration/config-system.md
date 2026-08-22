# Model and Configuration System

Blade uses `@earendil-works/pi-ai` as the single model catalog and Provider runtime.

## Configuration Sources and Folder Trust

The user-level `~/.blade/config.json` and an explicit CLI `--settings` are always controlled by the user. Project-level
`.blade/config.json`, `.blade/settings.json`, and `.blade/settings.local.json`
are only merged after [Workspace Trust](/en/guides/workspace-trust.md) passes.

An untrusted project cannot override the model/Provider endpoint, add MCP, relax permissions, toggle yolo, or inject
environment variables. Project Hook fields are projected separately for Hook-summary review, while other project fields remain invisible.
After Folder Trust passes, the following order still applies:

```text
Explicit CLI settings > project local settings > project shared settings > user configuration > defaults
```

MCP does not execute using this process-level merge result directly. Each Session re-resolves the user layer, trusted project layer,
plugin, ACP, and CLI sources according to its own source project, and uses an independent connection lifecycle.
Sampling must be explicitly enabled on the corresponding server, and the project layer is still protected by Workspace Trust. See
[MCP Session Isolation](/en/reference/mcp-session-isolation.md) and
[MCP Roots and Sampling](/en/reference/mcp-roots-sampling.md). Each server's
`timeout` is a hard total timeout, and `idleTimeout` is an idle timeout that can be refreshed by progress;
see [MCP Tool Call Lifecycle](/en/reference/mcp-call-lifecycle.md).
Experimental MCP Tasks are disabled by default; they can be explicitly enabled per server via `tasks.enabled`, and configured with
`defaultTtlMs`, `pollIntervalMs`, `maxTasksPerSession`, and `maxLifetimeMs`.
A required task tool returns a Session-private `mcp_task_*`, while an optional tool still executes in the foreground by default.
See [MCP Async Tasks](/en/reference/mcp-tasks.md).
`logging.level` defaults to `warning` and is negotiated after each Session connects via the standard
`logging/setLevel`; logs use an independent safety budget and do not enter the model context. See
[MCP Logging and Diagnostics](/en/reference/mcp-logging.md).
The instructions a server returns in initialize use independent Unicode/bytes/Session budgets,
and only enter the local provider context as sourced external tool documentation; ACP keeps only the hash. See
[MCP Server Instructions](/en/reference/mcp-server-instructions.md).
Remote HTTP/SSE servers can be configured with standard OAuth discovery; a connection only consumes existing credentials, login must be
started explicitly by the CLI/TUI/Web, and ACP does not read host tokens. OAuth credentials use an independent 0600 atomic ledger.
See [MCP OAuth Lifecycle](/en/reference/mcp-oauth-lifecycle.md).

LSP likewise does not use a process-global singleton. `lspServers` is resolved from the user layer, trusted source project, and active plugins
into an immutable Session snapshot; servers lazily start in the execution workspace and are reclaimed by the Session.
Project LSP commands go through Workspace Trust review. See
[Session-scoped LSP](/en/reference/lsp-session-intelligence.md).

Plugin enable/disable uses the `enabledPlugins` map, merged in local > project > user order. Untrusted projects
can only write `false` to tighten the plugin set, not enable plugins. See
[Workspace Plugin Lifecycle](/en/reference/workspace-plugin-lifecycle.md).

Plugin source policy uses `pluginSourcePolicy`. The user layer can configure a Git host, Marketplace, and local
root allowlist, as well as a full-commit-SHA requirement. The project and local layers use tighten-only merging:
a boolean restriction can only change from `false` to `true`, an allowlist can only be intersected, and a more specific config cannot relax
the user policy. `BLADE_PLUGIN_REQUIRE_SHA=1` is a non-overridable host-level tightening.

## Model Configuration

`~/.blade/config.json` only stores model references and user overrides:

```json
{
  "currentModelId": "primary",
  "agentTeamsEnabled": true,
  "providerForegroundRecoveryMs": 600000,
  "providerCircuitBreakerOpenMs": 10000,
  "providerRequestAdmissionMs": 180000,
  "providerRequestPendingBytes": 134217728,
  "modelProviders": {
    "team-claude": {
      "name": "Team Claude Gateway",
      "baseUrl": "https://gateway.example.com",
      "wireApi": "anthropic-messages",
      "apiKeyEnv": "TEAM_CLAUDE_API_KEY"
    }
  },
  "models": [
    {
      "id": "primary",
      "displayName": "DeepSeek Pro",
      "provider": "deepseek",
      "model": "deepseek-v4-pro"
    },
    {
      "id": "fallback",
      "provider": "team-claude",
      "model": "claude-sonnet-4-5",
      "overrides": {
        "maxOutputTokens": 8192,
        "timeout": 180000,
        "streamIdleTimeout": 300000
      }
    }
  ]
}
```

The following information for built-in models is not written to the configuration:

- Default Base URL
- Context window
- Maximum output tokens
- reasoning/thinking capabilities
- Image input capability
- Input, output, and cache pricing
- Provider API protocol

These fields all come from the pi-ai catalog and update automatically after you upgrade pi-ai. A custom channel reuses the capability
metadata of a matching model, and a completely unknown model uses conservative defaults.

## Credentials

API Keys and OAuth credentials are stored in:

```text
~/.blade/auth.json
```

The file permissions are `0600`. Credentials are keyed by concrete channel ID and are separate from the model configuration:

```json
{
  "deepseek": {
    "type": "api_key",
    "key": "..."
  },
  "team-claude": {
    "type": "api_key",
    "key": "..."
  }
}
```

Built-in Providers continue to use their pi-ai IDs. A custom channel can specify an environment variable via `apiKeyEnv`;
both the credential for the same channel in `auth.json` and that environment variable are resolved uniformly by pi-ai. API keys cannot appear in
`modelProviders` or `models`.

MCP OAuth access/refresh tokens are not stored in `auth.json` or `mcpServers`. They are stored by
endpoint/client/scopes identity in
`${BLADE_STORAGE_ROOT:-~/.blade}/mcp/oauth-credentials.json`, and follow independent
0600, atomic-write, and cross-process lock contracts.

## Provider and Model Catalog

The CLI, Web, and ACP use the same local pi-ai catalog:

```text
GET /providers
GET /providers/:provider/models
```

Providers return:

- Provider ID and name
- Model count
- Default endpoint
- API Key / OAuth capabilities
- Whether credentials are currently configured
- Whether it is a custom channel or a channel-creation entry point
- The wire API used by a custom channel
- The `apiKeyEnv` name of a custom channel (without the environment variable value)

Models return:

- Model ID and name
- API protocol
- Default endpoint
- context window and max tokens
- reasoning and vision capabilities
- Pricing

## Custom Provider Channels

Every compatible gateway must have an independent channel ID. The channel ID is simultaneously the model's `provider`, the pi-ai runtime
provider ID, and the `auth.json` credential key:

```json
{
  "modelProviders": {
    "company-gateway": {
      "name": "Company Gateway",
      "baseUrl": "https://gateway.example.com/v1",
      "wireApi": "openai-completions",
      "apiKeyEnv": "COMPANY_GATEWAY_API_KEY"
    }
  },
  "models": [
    {
      "id": "company-model",
      "displayName": "Company Gateway Model",
      "provider": "company-gateway",
      "model": "vendor-model-2026",
      "overrides": {
        "maxOutputTokens": 8192
      }
    }
  ]
}
```

`wireApi` supports:

- `openai-completions`: OpenAI Chat Completions compatible interface;
- `anthropic-messages`: Anthropic Messages compatible interface.

If the model ID can be found in another pi-ai Provider, Blade reuses its context window,
reasoning, and input capabilities, but does not reuse channel pricing. A completely unknown model uses a 128K context,
32K max output, text input, reasoning off, and zero pricing.

Both the TUI and Web can create both kinds of custom channels. The config, model, and credential are written in a single operation; if persistence
fails, the new credential is cleaned up and the catalog is restored. Multiple same-protocol channels do not share an endpoint or API key.

`openai-compatible + overrides.baseUrl` still serves as a legacy-config compatibility layer, but its credential key is fixed to
`openai-compatible` and is not suitable for multiple channels. New configurations must use `modelProviders`.

## Channel Lifecycle and Health Checks

The channel card in Web Settings supports:

- `Test`: send a real request of up to 8 tokens via the channel's first configured model;
- `Edit`: atomically update the name, wire API, endpoint, `apiKeyEnv`, and an optional new API key;
- `Delete`: after a second confirmation, cascade-delete the channel's models, fallback references, and channel credentials.

The default delete API returns `409` when there are still model or fallback references. Only an explicit
`removeModels=true` allows cascading, and the last available model cannot be deleted. If configuration persistence fails, the
original channel and credentials are restored.

The TUI uses the same service:

```text
/doctor
/model provider list
/model provider test <channel-id>
/model provider set <channel-id> <base-url>
/model provider remove <channel-id> --with-models
```

Health checks only return the channel ID, model ID, wire API, elapsed time, and a canonical failure code/message,
not the model reply, raw Provider exception, endpoint error body, or credentials. Web and ACP use the same
safe projection.

## Advanced Overrides

Only use `overrides` when you truly need a proxy gateway or special request parameters:

```json
{
  "id": "proxied-claude",
  "provider": "anthropic",
  "model": "claude-sonnet-4-5",
  "overrides": {
    "baseUrl": "https://gateway.example.com",
    "temperature": 0,
    "maxOutputTokens": 8192,
    "timeout": 180000,
    "streamIdleTimeout": 300000,
    "maxRetries": 2,
    "enablePromptCaching": true,
    "customHeaders": {
      "X-Client": "blade"
    }
  }
}
```

Overriding the endpoint does not change the protocol that pi-ai selects for that Provider.

`enablePromptCaching` enables the Provider Prompt Cache, using the Blade Session ID as a stable
cache-affinity identifier. A custom OpenAI-compatible completion channel uses the Provider-supported long
retention; other protocols are mapped by pi-ai to their respective cache-control semantics. The CLI footer, Web
StatusBar, and `/cost` display the cumulative hit rate; when the Provider does not report cache tokens, `Cache —` is shown.

`providerForegroundRecoveryMs` controls the bounded recovery time of a root foreground turn after the first transient Provider
failure. It defaults to `600000` (10 minutes), `0` disables it, and other values must be
`30000-3600000`. Without an explicit `overrides.maxRetries`, a root turn appends at most 12 requests;
an explicit value (including `0`) always takes precedence. Background subagents and internal sampling do not use extended recovery.

`providerCircuitBreakerOpenMs` controls the Open duration of the process-shared Provider circuit. It defaults to
`10000`, `0` disables it, and other values must be `1000-300000`. A same endpoint/model/tier/credential
failure domain Opens when it reaches 4 samples within a 60-second sliding window and the error rate is no lower than 80%; after expiry, only one
recovery probe is allowed at any given moment. The last candidate of a root foreground waits within the original recovery deadline,
while background/internal requests and candidates that still have a fallback do not wait.

`maxConcurrentTasks` and `maxQueuedTasks` respectively control the active count of process-level top-level tasks and the
count of tasks waiting for a ticket, defaulting to `3` and `100`, with valid ranges of `1-64` and `1-10000`.
`maxQueuedTaskBytes` additionally limits the logical retained-footprint of waiting tasks, defaulting to `67108864`
(64 MiB), and must be a safe integer in `65536-134217728`. Direct input, the Web persisted inbox,
and the crash-recovered inbox use the same bounded estimator; queued→running, cancel, abort, and
shutdown release the byte charge precisely. This setting is not a per-task size limit: when an active slot is idle,
a single task exceeding the pending budget can still run immediately. When the count or bytes are full, Web returns a
typed HTTP 429, and Headless/ACP task sessions persist a retryable `capacity` failure.
Project configuration cannot override these three process-level task admission settings. For the full contract, see
[Task Admission](/en/reference/task-admission.md).

`maxResidentSessionRuntimes` limits the total number of fully initialized Session
Runtime graphs in a long-running Web/ACP process, defaulting to `32`, and must be a safe integer in `1-256`. Pre-initialization reservations
also count toward the same hard cap, and cannot be exceeded via concurrent Session starts. When capacity is insufficient, Web only evicts idle,
unpinned LRU Runtimes, and uses `sessionRuntimeIdleMs` for TTL reclamation; this TTL defaults to
`300000` and must be `30000-3600000ms`. Durable Session history, inbox, Goal, task,
permissions, and worktree are not deleted, and subsequent access transparently cold-rehydrates.

ACP does no implicit eviction; clients must use the standard `session/close` to release a Session. When capacity is full,
new/fork/load returns a `resident_runtimes` error before Runtime, MCP/LSP, task/worktree, and Provider side effects. Both settings are frozen by
the process startup config, `0` cannot disable them, and project and
Session-local config cannot override them. The single-root Runtime of CLI/TUI/print/Headless does not enter this
multiplexed registry. For the full contract, see
[Session Runtime Residency](/en/reference/session-runtime-residency.md).

Provider requests bypass in-process concurrency admission by default. Real upstream
`429` responses, `retry-after` backoff, and the shared circuit breaker provide
backpressure. To opt into proactive limits, set `providerRequestConcurrency`
for one failure domain (`1-16`), `providerGlobalConcurrency` for the process, or
`providerOwnerConcurrency` for one root Session and its Task/Team descendants.
Unset layers impose no limit, and background/internal requests do not receive a
hidden stream reservation or reduction.

When any concurrency control is set, `providerRequestAdmissionMs` controls the
maximum capacity wait. It defaults to `180000`, accepts `0` for fail-fast, and
otherwise must be `1000-600000`. `providerRequestPendingBytes` bounds the retained
footprint of waiting requests, defaults to and is capped at `134217728` (128 MiB),
and accepts `65536-134217728`. Waiting sends no Provider traffic, consumes no retry
attempt, and responds to TUI Esc, Web stop, ACP cancel, and Headless signals.

`agentTeamsEnabled` defaults to `false`. Enabling it registers shared task DAG,
worktree isolation, and teammate mailbox tools for newly initialized Session
Runtimes; the Web settings page exposes the same switch. Re-enter an already
initialized Session to refresh its tool set.

The Anthropic SDK appends `/v1/messages` on its own. If the Anthropic `baseUrl` ends with `/v1`,
Blade removes that trailing segment at runtime to avoid producing `/v1/v1/messages`. Other path prefixes remain
unchanged. OpenAI-compatible endpoints do not undergo this removal.

## Fallback

Fallback uses a full cross-Provider model reference:

```json
{
  "id": "primary",
  "provider": "deepseek",
  "model": "deepseek-v4-pro",
  "fallbackModels": [
    {
      "provider": "anthropic",
      "model": "claude-sonnet-4-5",
      "configId": "claude-fallback"
    }
  ]
}
```

`configId` references a concrete configuration in `models`, so the fallback uses that configuration's own credentials,
`baseUrl`, timeout, and request overrides. Different Providers or different NewAPI channels should explicitly set
`configId`. When not set, it is resolved automatically only when `provider` + `model` uniquely matches a single model configuration;
if multiple matches exist, startup is rejected to avoid silently choosing the wrong credentials.

If the primary Provider hits an idle timeout before producing any output, it can switch directly to the next fallback
without retrying the same Provider. Once text, reasoning, a tool call, usage, or a finish event has been produced,
the execution boundary is non-replayable and the Provider is not switched.

## Breaking Upgrades

The following legacy fields in a model record are no longer supported:

- `name`
- `apiKey`
- `baseUrl`
- `maxContextTokens`
- `maxOutputTokens`
- `supportsThinking`
- `thinkingBudget`
- `thinkingMode`

A legacy configuration is deemed invalid, and you need to re-select the pi-ai Provider and model through the TUI or Web.
