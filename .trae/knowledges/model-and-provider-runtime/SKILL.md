---
name: knowledge-model-and-provider-runtime
description: >
  覆盖 Blade 的模型目录、Provider 通道、pi-ai 请求适配以及恢复、准入和观测运行链。
  Navigate when: 新增或切换模型与 Provider、调试请求负载或流事件、排查 fallback、重试、
  熔断、排队、Prompt Cache 或费用问题。Excludes: Session 模型资源快照与 Workspace
  Trust（见 workspace-policy-and-shared-foundations/），Agent 轮次消费与压缩策略（见
  agent-execution-and-orchestration/ 和 session-state-and-context/）。Keywords:
  PiAIChatService, PiModelCatalog, resolveModelConfig, provider retry, circuit breaker,
  admission, fallback, prompt cache, pricing.
---

## Module Structure

该域把用户配置解析为 Session 绑定的 pi-ai 模型，将 Blade 消息与工具契约适配为
Provider 请求，并在物理流外围统一实施故障恢复、容量保护和运行态观测。

### Directory Layout
- `packages/cli/src/services/ChatServiceInterface.ts` — Blade 内部消息、请求、响应和 Provider 生命周期事件契约
- `packages/cli/src/services/PiAIChatService.ts` — 统一聊天服务、fallback 与物理请求编排
- `packages/cli/src/services/PiCatalogService.ts` — Provider/模型目录查询门面
- `packages/cli/src/services/pi/` — pi-ai 目录、上下文、请求、流、重试、熔断、准入和缓存适配
- `packages/cli/src/config/modelIds.ts` — 可读模型配置 ID 生成与旧 ID 迁移
- `packages/cli/src/config/modelProviders.ts` — 自定义 Provider 通道验证
- `packages/cli/src/config/providerCircuitBreaker.ts` — 熔断配置边界
- `packages/cli/src/config/providerRequestAdmission.ts` — Provider 准入配置边界
- `packages/cli/src/config/foregroundProviderRecovery.ts` — 前台恢复预算边界

### Key Entry Points
- `resolveModelConfig()` in `packages/cli/src/services/pi/resolveModelConfig.ts` — 将模型记录、全局配置和能力选择冻结为运行时配置
- `createChatServiceAsync()` in `packages/cli/src/services/ChatServiceInterface.ts` — 合并 Provider 默认请求头并创建唯一聊天实现
- `PiAIChatService.streamChat()` in `packages/cli/src/services/PiAIChatService.ts` — 编排上下文转换、准入、熔断、物理流、重试与 fallback
- `PiModelCatalog` in `packages/cli/src/services/pi/PiModelCatalog.ts` — 维护内置、兼容和自定义 Provider 的模型视图

## Gotchas
- `ChatConfig` 同时携带可序列化设置和 `modelCatalog`、`providerCircuitRegistry`、`providerRequestAdmissionScheduler` 三个运行时对象；后者明确禁止进入配置、事件或会话持久化 (`packages/cli/src/services/ChatServiceInterface.ts`)
- Session 的模型目录是不可变工作区快照而熔断器和启用后的准入器是进程共享协调器；把三者统一成全局单例会串扰项目 endpoint，把三者都改成 Session 私有又会失去跨 Session 故障与容量协调 (`packages/cli/src/agent/resources/WorkspaceModelResources.ts`, `packages/cli/src/services/PiAIChatService.ts`)
- 跨 Provider fallback 不继承主通道的 API key、base URL、headers、service tier 或 verbosity；只有同 Provider 且 fallback 未解析出独立 channel 时才继承主通道字段 (`packages/cli/src/services/PiAIChatService.ts`)

## Architecture
- 配置链固定为 `ModelConfig` → `resolveModelConfig()` → `ChatConfig` → `createChatServiceAsync()` → `PiAIChatService`；模型能力先由 catalog 校验，再由请求适配器映射为各 wire API 的参数 (`packages/cli/src/services/pi/resolveModelConfig.ts`, `packages/cli/src/services/ChatServiceInterface.ts`, `packages/cli/src/services/pi/requestOptions.ts`)
- `chat()` 不是另一套非流式实现，而是消费 `streamChat()` 并聚合正文、reasoning、工具调用、usage 与 finish reason，因此恢复和重放边界只需在流式路径维护 (`packages/cli/src/services/PiAIChatService.ts`)
- 物理请求顺序是 circuit preflight → 可选 admission → 原子 circuit check/probe claim → Provider iterator → circuit outcome → permit/token 释放；重试等待和 fallback 选择发生在 permit 外 (`packages/cli/src/services/PiAIChatService.ts`, `docs/reference/model-transport-recovery.md`)

## Decisions
- 2026-08-05 的破坏性迁移将 Vercel AI SDK 替换为唯一的 pi-ai 运行时，并把模型能力、上下文窗口和价格的权威来源移到 catalog；旧模型记录中的凭据和能力字段不再兼容 (`packages/cli/src/services/pi/PiModelCatalog.ts`, `packages/cli/src/config/types.ts`, `git:311ba368`)
- Blade 将底层 pi-ai 的 `maxRetries` 固定为 `0` 并在 `PiAIChatService` 集中拥有重试、fallback 和生命周期事件，避免 SDK 与 Agent 双重重试放大物理请求或暗中重放流 (`packages/cli/src/services/pi/requestOptions.ts`, `packages/cli/src/services/PiAIChatService.ts`, `git:2aa2b22b`)

## Patterns
- Provider 运行态事件先作为 `StreamChunk` 控制字段进入 Agent loop，再由 TUI、Web SSE、Headless JSONL 和 ACP 各自投影；这些事件不混入 assistant 正文或 durable transcript (`packages/cli/src/services/ChatServiceInterface.ts`, `packages/cli/src/agent/loop/executeLoopGenerator.ts`, `packages/cli/src/server/routes/session.ts`)
- `PiAIChatService.updateConfig()` 会重新解析模型并重建可选 admission scheduler；修改 Provider、模型或并发配置不能只替换字段而保留旧运行时对象 (`packages/cli/src/services/PiAIChatService.ts`)

## Dependencies
- `@earendil-works/pi-ai` 提供 Provider、模型目录、凭据协议、模型能力和流事件；本域负责把这些能力收敛为 Blade 的单一运行时契约 (`packages/cli/package.json`, `packages/cli/src/services/pi/PiModelCatalog.ts`)

## Child Knowledge Nodes
- `./model-catalog-configuration-and-credentials/SKILL.md` — Navigate when: 新增模型或自定义 Provider、解析 fallback channel、迁移模型 ID、处理凭据与目录元数据
- `./provider-transport-and-context-adaptation/SKILL.md` — Navigate when: 修改 Message/Tool 到 pi-ai 的映射、Provider 参数、图片与 thinking 能力、流 watchdog 或响应归一化
- `./provider-resilience-admission-and-observability/SKILL.md` — Navigate when: 调试重试、前台恢复、熔断、容量排队、Prompt Cache 断裂、费用或跨表面 Provider 状态
