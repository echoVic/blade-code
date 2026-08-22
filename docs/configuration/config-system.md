# 模型与配置系统

Blade 使用 `@earendil-works/pi-ai` 作为唯一模型目录和 Provider 运行时。

## 配置来源与 Folder Trust

用户级 `~/.blade/config.json` 和显式 CLI `--settings` 始终由用户控制。项目级
`.blade/config.json`、`.blade/settings.json` 与 `.blade/settings.local.json`
只有在 [Workspace Trust](../guides/workspace-trust.md) 通过后才会合并。

未信任项目不能覆盖模型/Provider endpoint、添加 MCP、放宽权限、切换 yolo 或注入
环境变量。项目 Hook 字段单独投影给 Hook 摘要审阅，其余项目字段保持不可见。
Folder Trust 通过后仍遵循：

```text
CLI 显式设置 > 项目 local settings > 项目 shared settings > 用户配置 > 默认值
```

MCP 不直接使用这个进程级合并结果执行。每个 Session 会按自己的 source project
重新解析用户层、可信项目层、plugin、ACP 和 CLI 来源，并使用独立连接生命周期。
Sampling 必须在对应 server 上显式启用，项目层仍受 Workspace Trust 保护。详见
[MCP Session 隔离](../reference/mcp-session-isolation.md)和
[MCP Roots 与 Sampling](../reference/mcp-roots-sampling.md)。每个 server 的
`timeout` 是 hard total timeout，`idleTimeout` 是可由 progress 刷新的 idle timeout，
详见 [MCP Tool Call 生命周期](../reference/mcp-call-lifecycle.md)。
实验性 MCP Tasks 默认关闭；可在单个 server 的 `tasks.enabled` 显式启用，并配置
`defaultTtlMs`、`pollIntervalMs`、`maxTasksPerSession` 和 `maxLifetimeMs`。
required task tool 会返回 Session 私有 `mcp_task_*`，optional tool 默认仍以前台方式
执行。详见 [MCP Async Tasks](../reference/mcp-tasks.md)。
`logging.level` 默认 `warning`，在每个 Session 连接后通过标准
`logging/setLevel` 协商；日志使用独立安全预算且不会进入模型上下文，详见
[MCP Logging 与诊断](../reference/mcp-logging.md)。
server 在 initialize 中返回的 instructions 使用独立 Unicode/bytes/Session 预算，
只作为有来源的外部工具文档进入本地 provider context；ACP 只保留 hash。详见
[MCP Server Instructions](../reference/mcp-server-instructions.md)。
远程 HTTP/SSE server 可配置标准 OAuth discovery；连接只消费已有凭证，登录必须由
CLI/TUI/Web 显式启动，ACP 不读取宿主 token。OAuth 凭证使用独立 0600 原子账本，
详见 [MCP OAuth 生命周期](../reference/mcp-oauth-lifecycle.md)。

LSP 同样不使用进程全局单例。`lspServers` 从用户层、可信 source project 和活动插件
解析为不可变 Session 快照；服务器在执行 workspace 中懒启动，并由 Session 回收。
项目 LSP command 会进入 Workspace Trust review。详见
[Session-scoped LSP](../reference/lsp-session-intelligence.md)。

插件启停使用 `enabledPlugins` 映射，并按 local > project > user 合并。未信任项目
只能写入 `false` 收紧插件集合，不能启用插件。详见
[Workspace Plugin 生命周期](../reference/workspace-plugin-lifecycle.md)。

插件来源策略使用 `pluginSourcePolicy`。用户层可配置 Git host、Marketplace 和本地
根目录 allowlist，以及完整 commit SHA 要求。项目和 local 层采用 tighten-only 合并：
布尔限制只能从 `false` 变为 `true`，allowlist 只能取交集，不能通过更具体配置放宽
用户策略。`BLADE_PLUGIN_REQUIRE_SHA=1` 是不可覆盖的宿主级收紧。

## 模型配置

`~/.blade/config.json` 只保存模型引用和用户覆盖项：

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

内置模型的以下信息不写入配置：

- 默认 Base URL
- 上下文窗口
- 最大输出 Token
- reasoning/thinking 能力
- 图片输入能力
- 输入、输出和缓存价格
- Provider API 协议

这些字段全部来自 pi-ai catalog，升级 pi-ai 后自动更新。自定义渠道会复用匹配模型的
能力元数据，完全未知的模型使用保守默认值。

## 凭证

API Key 和 OAuth 凭证存储在：

```text
~/.blade/auth.json
```

文件权限为 `0600`。凭证以具体渠道 ID 为键，与模型配置分离：

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

内置 Provider 继续使用其 pi-ai ID。自定义渠道可通过 `apiKeyEnv` 指定环境变量；
`auth.json` 中同渠道的凭证与该环境变量都由 pi-ai 统一解析。API key 不能出现在
`modelProviders` 或 `models` 中。

MCP OAuth access/refresh token 不保存在 `auth.json` 或 `mcpServers`。它们按
endpoint/client/scopes 身份保存在
`${BLADE_STORAGE_ROOT:-~/.blade}/mcp/oauth-credentials.json`，并遵循独立的
0600、原子写和跨进程锁契约。

## Provider 与模型目录

CLI、Web 和 ACP 使用同一个本地 pi-ai catalog：

```text
GET /providers
GET /providers/:provider/models
```

Provider 返回：

- Provider ID 和名称
- 模型数量
- 默认 endpoint
- API Key / OAuth 能力
- 当前是否已配置凭证
- 是否为自定义渠道或渠道创建入口
- 自定义渠道使用的 wire API
- 自定义渠道的 `apiKeyEnv` 名称（不含环境变量值）

模型返回：

- Model ID 和名称
- API 协议
- 默认 endpoint
- context window 和 max tokens
- reasoning 和 vision 能力
- 价格

## 自定义 Provider 渠道

每个兼容网关都必须拥有独立渠道 ID。渠道 ID 同时是模型的 `provider`、pi-ai runtime
provider ID 和 `auth.json` 凭据键：

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

`wireApi` 支持：

- `openai-completions`：OpenAI Chat Completions 兼容接口；
- `anthropic-messages`：Anthropic Messages 兼容接口。

若模型 ID 能在其他 pi-ai Provider 中找到，Blade 会复用其 context window、
reasoning 和输入能力，但不会复用渠道价格。完全未知的模型使用 128K context、
32K 最大输出、文本输入、reasoning 关闭和零价格。

TUI 与 Web 都能创建两类自定义渠道。配置、模型和凭据在一次操作中写入；持久化失败
会清理新凭据并恢复 catalog。多个同协议渠道不会共享 endpoint 或 API key。

`openai-compatible + overrides.baseUrl` 仍作为旧配置兼容层，但其凭据键固定为
`openai-compatible`，不适合多渠道。新配置必须使用 `modelProviders`。

## 渠道生命周期与健康检查

Web Settings 的渠道卡片支持：

- `Test`：通过渠道的首个配置模型发送最多 8 tokens 的真实请求；
- `Edit`：原子更新名称、wire API、endpoint、`apiKeyEnv` 和可选的新 API key；
- `Delete`：二次确认后级联删除渠道模型、fallback 引用和渠道凭据。

默认删除 API 会在仍有模型或 fallback 引用时返回 `409`。只有显式
`removeModels=true` 才允许级联，而且不能删除最后一个可用模型。配置持久化失败会恢复
原渠道和凭据。

TUI 使用相同的服务：

```text
/doctor
/model provider list
/model provider test <channel-id>
/model provider set <channel-id> <base-url>
/model provider remove <channel-id> --with-models
```

健康检查仅返回渠道 ID、模型 ID、wire API、耗时和 canonical failure code/message，
不会返回模型回复、原始 Provider 异常、endpoint 错误正文或凭据。Web 和 ACP 使用同一
安全投影。

## 高级覆盖

只有确实需要代理网关或特殊请求参数时才使用 `overrides`：

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

覆盖 endpoint 不改变 pi-ai 为该 Provider 选择的协议。

`enablePromptCaching` 启用 Provider Prompt Cache，并以 Blade Session ID 作为稳定的
缓存亲和标识。自定义 OpenAI-compatible completion channel 使用 Provider 支持的 long
retention；其他协议由 pi-ai 映射到各自的 cache-control 语义。CLI footer、Web
StatusBar 和 `/cost` 会显示累计命中率；Provider 未回报缓存 token 时显示 `Cache —`。

`providerForegroundRecoveryMs` 控制 root foreground turn 在首个瞬时 Provider
故障后的有界恢复时间。默认 `600000`（10 分钟），`0` 禁用，其他值必须为
`30000-3600000`。没有显式 `overrides.maxRetries` 时，root turn 最多追加 12 次请求；
显式值（包括 `0`）始终优先。background subagent 和内部采样不使用扩展恢复。

`providerCircuitBreakerOpenMs` 控制进程共享 Provider circuit 的 Open 时间。默认
`10000`，`0` 禁用，其他值必须为 `1000-300000`。同 endpoint/model/tier/credential
failure domain 在 60 秒滑窗内达到 4 个样本且错误率不低于 80% 时 Open；到期后同一
时刻只允许一个恢复 probe。root foreground 的末候选在原恢复 deadline 内等待，
background/internal 请求和仍有 fallback 的候选不等待。

`maxConcurrentTasks` 与 `maxQueuedTasks` 分别控制进程内顶层 task 的 active 数量和
等待 ticket 数量，默认 `3` 与 `100`，合法范围为 `1-64` 与 `1-10000`。
`maxQueuedTaskBytes` 另限制等待 task 的逻辑 retained-footprint，默认 `67108864`
（64 MiB），必须为 `65536-134217728` 的安全整数。direct input、Web 已持久化 inbox
和 crash-recovered inbox 使用同一有界 estimator；queued→running、cancel、abort 与
shutdown 精确释放 byte charge。该设置不是单 task 大小限制：active slot 空闲时，
单个超过 pending budget 的 task 仍可立即运行。count 或 bytes 已满时，Web 返回
typed HTTP 429，Headless/ACP task session 持久化可重试的 `capacity` failure。
project 配置不能覆盖这三个进程级 task admission 设置。完整契约见
[Task Admission](../reference/task-admission.md)。

`maxResidentSessionRuntimes` 限制长运行 Web/ACP 进程中 fully initialized Session
Runtime graph 的总数，默认 `32`，必须为 `1-256` 的安全整数。初始化前 reservation
也计入同一硬上限，不能通过并发 Session 启动越界。Web 在容量不足时只驱逐 idle、
unpinned 的 LRU Runtime，并使用 `sessionRuntimeIdleMs` 做 TTL 回收；该 TTL 默认
`300000`，必须为 `30000-3600000ms`。durable Session 历史、inbox、Goal、task、
权限和 worktree 不会被删除，后续访问会透明 cold rehydrate。

ACP 不做隐式驱逐；客户端必须使用标准 `session/close` 释放 Session。容量已满时，
new/fork/load 在 Runtime、MCP/LSP、task/worktree 和 Provider 副作用前返回
`resident_runtimes` 错误。两项设置都由进程启动配置冻结，`0` 不能禁用，project 和
Session-local 配置不能覆盖。CLI/TUI/print/Headless 的单 root Runtime 不进入该
multiplexed registry。完整契约见
[Session Runtime Residency](../reference/session-runtime-residency.md)。

Provider 请求默认不经过进程内并发准入，直接由上游真实 `429`、`retry-after` 重试和
共享熔断器提供背压。需要主动限流时，可显式设置 `providerRequestConcurrency`
（单一 failure domain，`1-16`）、`providerGlobalConcurrency`（全进程）或
`providerOwnerConcurrency`（同一 root Session 及其 Task/Team 后代）；未设置的层级
不施加限制，也不会为 background/internal 隐式保留或削减 stream 容量。

只要设置任一并发旋钮，`providerRequestAdmissionMs` 就控制等待容量的最长时间：
默认 `180000`，可设为 `0` 立即失败，其他值必须为 `1000-600000`。
`providerRequestPendingBytes` 控制等待请求的 retained-footprint，默认和硬上限均为
`134217728`（128 MiB），可配置为 `65536-134217728`。等待期间不发 Provider 请求、
不增加 retry attempt，并响应 TUI Esc、Web stop、ACP cancel 和 Headless signal。

`agentTeamsEnabled` 默认 `false`。开启后，新建 Session Runtime 会注册共享任务 DAG、
worktree 隔离和成员 mailbox 工具；Web 设置页也提供同一开关。已初始化的 Session
需要重新进入后才会刷新工具集合。

Anthropic SDK 会自行追加 `/v1/messages`。若 Anthropic 的 `baseUrl` 以 `/v1`
结尾，Blade 会在运行时移除该尾段，避免产生 `/v1/v1/messages`。其他路径前缀保持
不变。OpenAI-compatible endpoint 不做该移除。

## Fallback

Fallback 使用完整的跨 Provider 模型引用：

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

`configId` 引用 `models` 中的具体配置，使 fallback 使用该配置自己的凭据、
`baseUrl`、超时和请求覆盖。不同 Provider 或不同 NewAPI channel 应显式设置
`configId`。未设置时，仅在 `provider` + `model` 唯一匹配一条模型配置时自动解析；
存在多个匹配项会拒绝启动，避免静默选择错误的凭据。

主 Provider 在尚未产生任何输出时发生 idle timeout，可以直接切换到下一 fallback，
不会重试同一 Provider。一旦已产生文本、reasoning、tool call、usage 或 finish 事件，
执行边界即不可重放，不会切换 Provider。

## 破坏性升级

不再支持模型记录中的旧字段：

- `name`
- `apiKey`
- `baseUrl`
- `maxContextTokens`
- `maxOutputTokens`
- `supportsThinking`
- `thinkingBudget`
- `thinkingMode`

旧配置会被判定为无效，需要通过 TUI 或 Web 重新选择 pi-ai Provider 和模型。
