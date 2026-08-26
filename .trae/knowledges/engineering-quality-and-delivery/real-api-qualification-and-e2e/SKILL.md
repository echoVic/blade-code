---
name: knowledge-engineering-quality-and-delivery-real-api-qualification-and-e2e
description: >
  覆盖真实 Provider 测试、发布阻断文件白名单、模型与 surface 矩阵、Chromium/PTY/ACP/Web
  驱动、凭据隔离及准出证据。
  Navigate when: 新增生产能力轨迹、改变 release matrix、调试真实 API flake、修改凭据、
  timeout、重试、跨表面断言或资源回收。
  Excludes: 普通 mock 测试（见 ../unit-integration-and-shared-test-harnesses/）；
  build/tag/npm 和文档部署（见 ../build-release-and-documentation/）。
  Keywords: REAL_API_TEST, REAL_API_RELEASE_MATRIX, realApiQualification, DeepSeek Flash,
  DeepSeek Pro, Headless, PTY, Web, ACP, Playwright, credentials, trajectory, qualification.
---

## Module Structure

真实 API 层以生产 Agent/协议入口为被测对象，用显式模型×surface 矩阵、宿主可验证副作用和严格资源回收把“模型说完成了”提升为可发布证据。

### Directory Layout
- `packages/cli/tests/integration/real-api/` — 真实 Provider 能力、恢复、故障注入和跨表面轨迹
- `packages/cli/tests/support/` — Headless、raw PTY、production Web、ACP 驱动及透明代理
- `packages/cli/tests/e2e/` — 本地模拟 E2E；不承担付费发布资格
- `packages/cli/scripts/qualification.ts`、`packages/cli/scripts/qualify.ts` — 本地/生产门禁计划与顺序执行
- `packages/cli/scripts/real-api-credentials.ts` — 受限凭据文件解析和环境投影
- `packages/cli/scripts/test-config.js` — `realApi` 与 38 个发布阻断 trajectory 的显式配置
- `docs/testing/`、`docs/en/testing/` — 双语资格契约和冻结候选证据

### Key Entry Points
- `realApiQualification` in `packages/cli/scripts/test-config.js` — 发布阻断文件白名单、90 分钟 watchdog 和 release 环境
- `resolveRequiredDeepSeekQualificationModels()` in `packages/cli/tests/integration/real-api/testConfig.ts` — 强制解析 Flash/Pro
- `buildRealApiRuntimeConfig()` in `packages/cli/tests/integration/real-api/testConfig.ts` — 为每个测试渠道生成隔离的生产 Runtime 配置
- `packages/cli/tests/support/setup.real-api.ts` — 初始化真实模型并避开普通测试 mock
- `materializeRealApiEnvironment()` in `packages/cli/scripts/real-api-credentials.ts` — 合并显式环境与安全凭据文件
- `startRecordingProviderProxy()` in `packages/cli/tests/support/recordingProviderProxy.ts` — 记录、阻塞和转发真实 Provider 请求

## Branching Table

| 维度 | 分支 A | 分支 B |
|------|--------|--------|
| 启用状态 | 未设置 `REAL_API_TEST=1` 时大多数 trajectory 跳过 | 启用后若没有任何可用凭据则 setup/import fail closed |
| 执行集合 | `test:real-api` 运行完整 soak 集合，watchdog 60 分钟 | `test:real-api:qualification` 只运行显式 38 文件白名单，watchdog 90 分钟 |
| 框架重试 | 普通 real-api project 允许一次 Vitest retry | `REAL_API_RELEASE_MATRIX=1` 时 retry 固定为 0 |
| 必需模型 | 普通 soak 使用当前已配置模型 | 发布资格强制 DeepSeek `deepseek-v4-flash` 与 `deepseek-v4-pro` |
| 可选 Provider | 默认排除 domestic 凭据并保留必需渠道 | `REAL_API_INCLUDE_OPTIONAL_PROVIDERS=1` 才把 domestic 加入付费环境 |
| surface 集合 | 某些高成本轨迹在 release helper 下移除 raw PTY，形成 6 格 | Browser、token-budget、large-prompt 等关键轨迹固定四 surface，形成 8 格 |
| 浏览器状态 | Chromium preflight 失败时顺序门禁立即停止 | preflight 成功后才进入付费 trajectory |
| 凭据来源 | 显式 Provider 环境变量形成调用方选择的渠道集合 | 无显式 key 时可从受限凭据文件或当前 Blade 凭据解析 |

## Affected Scope
- `packages/cli/src/agent/` — 真实循环、工具调用、完成策略和恢复行为的被测核心
- `packages/cli/src/context/` — durable transcript、compaction、inbox 与重放证据
- `packages/cli/src/commands/` — Headless/Print 与生产 CLI 子进程入口
- `packages/cli/src/server/`、`packages/cli/web/src/` — production server、SSE、GUI 与 Chromium 外层驱动
- `packages/cli/src/acp/` — 真实 ACP SDK 会话、terminal capability、load/fork/cancel
- `packages/cli/src/browser/` — Agent Browser 与 Web Browser 的独立 Chromium 生命周期
- `packages/cli/tests/integration/real-api/` — 每项能力的模型×surface 资格矩阵
- `packages/cli/tests/support/` — 跨表面观察、故障代理、PTY marker 和资源回收工具
- `packages/cli/scripts/` — 发布白名单、凭据、总 timeout 与生产资格顺序
- `docs/testing/` — 对矩阵、宿主断言、禁止替代项和冻结证据的规范

## Gotchas
- 普通 `test:all` 不设置 `REAL_API_TEST`，真实 API 文件即使被 Vitest 收集也会跳过；绿色结果不能解释为真实 Provider 已验证 (`packages/cli/package.json`, `packages/cli/tests/integration/real-api/testConfig.ts`)
- `REAL_API_TEST=1` 且没有可用 Provider 凭据会在测试模块初始化阶段抛错，不会悄悄把真实测试降级成 mock (`packages/cli/tests/integration/real-api/testConfig.ts`, `packages/cli/tests/support/setup.real-api.ts`)
- 发布阻断集合是 `test-config.js` 中的显式文件白名单；新增 trajectory 但未同步白名单和其 source-contract 单测，不会进入 production qualification (`packages/cli/scripts/test-config.js`, `packages/cli/tests/unit/scripts/test-runner.test.ts`)
- 普通 real-api 允许一次 framework retry，而发布矩阵固定为零；不能用本地重跑后的通过掩盖同一候选中的首次失败 (`packages/cli/vitest.config.ts`, `docs/testing/qualification.md`)
- `releaseBlockingSurfaces()` 会在 release mode 中移除 `pty`，但少数完整矩阵故意不调用它；修改 surface 集合必须按 trajectory 契约检查 6/8 格断言，不能统一套一个数量 (`packages/cli/tests/integration/real-api/testConfig.ts`, `packages/cli/tests/integration/real-api/foreground-bounded-output-trajectory.test.ts`, `packages/cli/tests/integration/real-api/browser-tool-trajectory.test.ts`, `git:6f738811`)
- 默认凭据文件仅在没有任何显式 Provider key 时自动加载；若环境只设置一个 key 且未显式指定凭据文件，其他默认文件渠道不会被隐式补齐 (`packages/cli/scripts/real-api-credentials.ts`, `docs/testing/qualification.md`)
- 凭据文件必须是当前用户拥有的普通文件、Unix mode `0600`、不超过 64 KiB，且 URL 禁止非 loopback HTTP、userinfo、query 和 fragment (`packages/cli/scripts/real-api-credentials.ts`)
- PTY 证据必须单调锁存已观察 marker，同时在 resize 后重新观察要求持续可见的事实；只检查最终 bounded tail 会把正确轨迹误判为失败 (`packages/cli/tests/unit/integration/raw-pty-marker-latching.test.ts`, `git:3775b292`, `git:2963c0b6`)

## Architecture
- production qualification 先完整执行 14 个无付费检查，再执行 Chromium preflight，最后运行付费白名单；执行器首错停止并确保 preflight 失败时不会产生 Provider 流量 (`packages/cli/scripts/qualification.ts`, `packages/cli/tests/unit/scripts/qualification.test.ts`)
- real-api setup 不加载普通 `setup.ts` 的 I/O mock，而是配置独立存储根、真实模型凭据和生产 Store，使 trajectory 可以穿过真实文件、进程与网络边界 (`packages/cli/tests/support/setup.real-api.ts`)
- 测试 Runtime 使用 qualification ID 派生稳定但不泄密的 model/provider ID，并把自定义渠道 key 放入专属哈希环境槽，避免 Claude/GPT/domestic 共用协议时串 key (`packages/cli/tests/integration/real-api/testConfig.ts`)
- 透明 Provider proxy 同时记录请求体、开始/结束时间和最大并发，并支持 host barrier；这让 retry、admission、stall 与零额外流量成为宿主事实而非模型文本 (`packages/cli/tests/support/recordingProviderProxy.ts`)

## Decisions
- 发布最低基线固定要求 DeepSeek Flash/Pro；Claude、GPT 用于特定跨 Provider 契约，domestic 默认只作为显式启用的 soak，通道不稳定不能降低必需模型标准 (`packages/cli/scripts/qualification.ts`, `docs/testing/qualification.md`)
- 高价值轨迹要求真实 Read/Edit/Write/Bash、durable event 或协议投影，再由宿主检查文件与测试结果；HTTP 200 或模型自述完成不构成资格证据 (`packages/cli/tests/integration/real-api/release-coding-trajectory.test.ts`, `packages/cli/tests/integration/real-api/agent-trajectory.test.ts`)

## Patterns
- 每个矩阵 cell 使用唯一 HOME、storage、workspace、Session ID 和 marker，并在 `finally` 关闭 browser/server/proxy/ACP/PTY 后删除根目录，防止跨 cell 污染 (`packages/cli/tests/integration/real-api/browser-tool-trajectory.test.ts`)
- 发布矩阵测试常先断言模型×surface 的精确 cell 数，再使用 `.sequential()` 执行；这把意外过滤或新增分支变成导入期失败 (`packages/cli/tests/integration/real-api/token-budget-handoff-trajectory.test.ts`, `packages/cli/tests/integration/real-api/browser-tool-trajectory.test.ts`)
- 失败诊断只保留有界、脱敏的宿主证据，最终还要扫描 transcript、DOM、PTY、ACP update 与代理记录中不存在 API key (`docs/testing/qualification.md`, `packages/cli/tests/integration/real-api/release-coding-trajectory.test.ts`)

## Branching Behavior
- 生产资格有显式 DeepSeek key 时默认补齐 Flash/Pro 模型列表；只从 `~/.blade/auth.json` 取得 key 时仅投影 `REAL_API_TEST=1`，模型解析留给 Blade 凭据存储 (`packages/cli/scripts/qualification.ts`, `packages/cli/scripts/qualify.ts`)
- 非付费检查从子进程环境删除所有 Provider key/base/model、real-API 开关和凭据文件路径；付费检查才得到 materialized 环境 (`packages/cli/scripts/qualification.ts`)
- 自定义 Claude/GPT/domestic 渠道规范化为 `/v1` endpoint 并使用独立 provider 配置，DeepSeek 则沿用内置 provider 与模型级凭据槽 (`packages/cli/tests/integration/real-api/testConfig.ts`)
- 发布模式下 surface 缩减是逐 trajectory 决策；固定 8 格的 Browser/大型 Prompt/Token handoff 测试由单测扫描源码防止误接 `releaseBlockingSurfaces()` (`packages/cli/tests/unit/scripts/test-runner.test.ts`)
- Chromium 缺失或 sandbox 不可用时应在 browser preflight 失败，而不是由真实 Provider cell 边跑边下载或在付费请求后才失败 (`packages/cli/scripts/browser-check.ts`, `packages/cli/scripts/qualification.ts`)
