---
name: knowledge-engineering-quality-and-delivery-unit-integration-and-shared-test-harnesses
description: >
  覆盖 CLI 与 Web 的 Vitest 分层、全局 mock、共享 fixture、临时存储和测试子进程所有权。
  Navigate when: 新增或移动 unit/integration/CLI/E2E/Web 测试，调试并发差异、mock 污染、
  超时、残留进程或临时目录清理。
  Excludes: 付费 Provider 与发布矩阵（见 ../real-api-qualification-and-e2e/）；
  性能、安全和快照专用门禁（见 ../performance-security-and-snapshot-gates/）。
  Keywords: Vitest, setup.ts, test.js, test-config, test-runner, vi.mock, BLADE_STORAGE_ROOT,
  TMPDIR, process ownership, unit, integration, CLI, Web, E2E.
---

## Module Structure

测试层由 Vitest project 负责选择文件，由包装脚本负责环境和进程所有权；CLI 与 Web 共用部分 setup，但真实 API 使用单独的无 mock setup。

### Directory Layout
- `packages/cli/tests/unit/` — 细粒度状态机、服务、工具、协议与表面投影回归
- `packages/cli/tests/integration/` — 跨模块与真实子进程集成；`real-api/` 和 `cli/` 被独立 project 接管
- `packages/cli/tests/e2e/` — 本地 fixture 与模拟流程测试
- `packages/cli/tests/support/` — setup、mock、跨表面 driver、PTY/ACP/Web runner 与清理 helper
- `packages/cli/tests/fixtures/` — 可由测试子进程执行的最小场景
- `packages/cli/web/tests/` — Web 组件、Store、服务与 bundle 测试
- `packages/cli/scripts/test*.js` — 项目选择、测试子进程、超时、环境隔离和 owner watchdog

### Key Entry Points
- `packages/cli/vitest.config.ts` — CLI 测试项目、pool、并发、setup 与超时
- `packages/cli/web/vitest.config.ts` — Web 依赖去重、alias 与默认 Node 环境
- `runTest()` in `packages/cli/scripts/test.js` — 包装 Vitest 并创建进程级临时根
- `runOwnedCommand()` in `packages/cli/scripts/test-runner.js` — 启动独立进程组并在 timeout/abort 时回收整棵树
- `packages/cli/tests/support/setup.ts` — 普通项目的全局 mock 和 test-file 存储根
- `packages/cli/tests/support/setup.real-api.ts` — 保留生产文件、子进程与网络实现的真实 API setup

## Branching Table

| 维度 | 分支 A | 分支 B |
|------|--------|--------|
| 执行入口 | `test:<type>` 经 `scripts/test.js` 获得 TMPDIR 隔离、总超时和 owner watchdog | `test:all`/`test:watch` 直接调用 Vitest，不经过该进程包装层 |
| 运行环境 | 本地 unit 使用最多 4 个 thread worker 和文件并行 | `CI=true` 将共享 pool 收窄为单 worker、关闭文件并行 |
| 项目隔离 | unit/CLI/performance/snapshot 使用 threads | integration/E2E/security/real-api 使用 forks，integration 与 real-api 还固定串行 |
| 全局 setup | unit/integration/CLI/E2E/security 等加载 `setup.ts` 的基础设施 mock | real-api 只加载 `setup.real-api.ts`，保持真实文件、进程与网络 |
| 文件归属 | generic integration 显式排除 `integration/cli/` 与 `integration/real-api/` | CLI 和 real-api 由各自 project、超时和 setup 独立运行 |
| Web DOM | Web project 默认 `environment: node` | 需要 DOM 的文件用 `@vitest-environment jsdom` 局部切换 |
| 存储所有权 | 未设置 `BLADE_STORAGE_ROOT` 时 setup 创建并注册清理 | 调用方显式设置时保持 caller-owned，setup 不删除 |

## Affected Scope
- `packages/cli/tests/unit/` — 受全局 mock、thread pool、15 秒默认 timeout 和文件隔离影响
- `packages/cli/tests/integration/` — 受 fork 串行执行、真实子进程显式 unmock 和 30 秒 project timeout 影响
- `packages/cli/tests/e2e/` — 叠加普通 setup 与 E2E setup，当前仍包含 mock/占位场景
- `packages/cli/tests/support/` — 跨表面 driver、临时根、mock 和进程清理的共享实现
- `packages/cli/web/tests/` — 复用 CLI setup，并依赖 React/Zustand 去重与按文件 jsdom
- `packages/cli/scripts/test.js` — 为按类型运行建立进程级环境与超时
- `packages/cli/scripts/test-runner.js` — 决定 timeout、abort 和父进程硬退出后的进程树回收
- `packages/cli/vitest.config.ts`、`packages/cli/web/vitest.config.ts` — 文件选择、pool、retry、coverage 与 alias 的最终配置

## Gotchas
- 普通 setup 会 mock `fs`、`child_process`、`axios`、`ws`、`http` 和 `https`；需要验证真实 I/O 的 integration 测试必须显式 `vi.unmock` 或进入 real-api setup，否则“集成”断言可能只覆盖 mock (`packages/cli/tests/support/setup.ts`, `packages/cli/tests/integration/config.test.ts`)
- `afterEach` 只调用 `vi.clearAllMocks()` 与 `vi.clearAllTimers()`，不会恢复同一文件内改写过的实现；修改 mock implementation 的测试仍需自行 restore/reset (`packages/cli/tests/support/setup.ts`)
- `bun run test:all` 直接运行 Vitest 两次，不经过 `scripts/test.js`，因此没有该包装器提供的 TMPDIR/TMP/TEMP 隔离、总超时和 owner watchdog (`packages/cli/package.json`, `packages/cli/scripts/test.js`)
- `tests/e2e/` 中存在只验证 fixture 或 `expect(true)` 的占位场景，另一个对话流程直接使用 mock LLM；不能据此宣称真实 CLI/Provider E2E 已覆盖 (`packages/cli/tests/e2e/core-features.test.ts`, `packages/cli/tests/e2e/flows/chat-flow.test.ts`)
- `configureOwnedTestStorageRoot()` 遇到调用方已有 `BLADE_STORAGE_ROOT` 会原样返回且不注册清理，测试若自行设置该变量就必须自行恢复和删除 (`packages/cli/tests/support/ownedTestStorageRoot.ts`)
- 测试临时根删除要求路径在删除后持续 quiet period，不是一次 `rm` 成功就结束；这用于捕获延迟 writer 重新创建目录的竞态 (`packages/cli/scripts/test-environment.js`, `git:6f738811`)

## Architecture
- Vitest project 是文件分层权威，`test-config.js` 只是命令级选择和总 watchdog；新增目录时两处必须一致，否则文件可能被错误项目收集或完全漏跑 (`packages/cli/vitest.config.ts`, `packages/cli/scripts/test-config.js`)
- 测试命令运行在独立进程组，timeout/abort 先 TERM、短暂等待后 KILL；额外 watchdog 在测试运行器自身被硬杀时继续回收目标组 (`packages/cli/scripts/test-runner.js`, `packages/cli/scripts/test-owner-watchdog.js`)
- Web 测试从根 `node_modules` 固定 React/ReactDOM/Zustand 身份，并复用 CLI 的 `tests/support/setup.ts`，避免 workspace 重复 React 实例造成 hook 失效 (`packages/cli/web/vitest.config.ts`)

## Decisions
- CI 将 worker 数压到 1，而本地允许最多 4 个 worker，以确定性优先处理共享全局状态和进程资源；只在本地通过的并发测试仍需用 `CI=true` 复验 (`packages/cli/vitest.config.ts`)
- real-api setup 被彻底从普通全局 mock 中分离，保证付费轨迹使用生产文件系统、子进程和网络实现 (`packages/cli/tests/support/setup.real-api.ts`)

## Patterns
- 需要真实 child process 的测试先 `vi.unmock('node:child_process')`，并在 teardown 中按 PID 兜底回收，避免全局 setup 与失败中断留下孤儿进程 (`packages/cli/tests/unit/scripts/test-runner.test.ts`)
- 复杂真实轨迹把协议驱动器放在 `tests/support/`，测试文件只组装模型×surface 矩阵和宿主断言；修改 driver 时要回查所有消费者而非只跑单个 trajectory (`packages/cli/tests/support/browserToolPtyDriver.ts`, `packages/cli/tests/integration/real-api/browser-tool-trajectory.test.ts`)
- CLI 源码与 Web 源码各自使用别名，但 Web 测试还强制依赖去重；新增跨包 import 时必须同步检查两个 Vitest resolve 配置 (`packages/cli/vitest.config.ts`, `packages/cli/web/vitest.config.ts`)

## Dependencies
- 测试入口通过 `vitest/package.json` 的公开 metadata 解析 `vitest.mjs`，避免依赖包内部的硬编码安装路径 (`packages/cli/scripts/vitest-cli.js`, `packages/cli/tests/unit/scripts/test-runner.test.ts`)

## Branching Behavior
- unit 文件默认可依赖全局 mock；integration 若要跨真实模块边界，需要逐项解除相关 mock；real-api 则禁止回退到普通 setup (`packages/cli/tests/support/setup.ts`, `packages/cli/tests/support/setup.real-api.ts`)
- integration project 固定 `fileParallelism: false` 且单 worker，CLI 文件即使位于 `tests/integration/` 也不会随它运行，而由 `cli` project 单独收集 (`packages/cli/vitest.config.ts`)
- E2E project 在普通 setup 之后追加 `setup.e2e.ts`，只增加标志和 console spy，并不会撤销基础设施 mock (`packages/cli/vitest.config.ts`, `packages/cli/tests/support/setup.e2e.ts`)
- Web 文件只有显式声明 jsdom 才获得 DOM；其余 Store/服务测试运行在 Node 环境，新增浏览器 API 使用时不能假设全局 DOM 存在 (`packages/cli/web/vitest.config.ts`, `packages/cli/web/tests/components/preview/BrowserPreview.test.tsx`)
- coverage 模式通过 `all` project 集合运行并排除 performance；普通 `test:all` 则先跑非 performance，再单独跑 performance，二者不是同一负载模型 (`packages/cli/package.json`, `packages/cli/scripts/test-config.js`)
