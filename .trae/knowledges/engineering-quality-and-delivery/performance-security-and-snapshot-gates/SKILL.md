---
name: knowledge-engineering-quality-and-delivery-performance-security-and-snapshot-gates
description: >
  覆盖性能预算、安全回归、依赖审计、输出快照与 coverage 的交叉门禁及其证据强度。
  Navigate when: 调整启动或 bundle 预算、资源上限、安全边界、coverage 阈值、依赖审计，
  或更新快照。
  Excludes: 普通测试 harness（见 ../unit-integration-and-shared-test-harnesses/）；
  真实 Provider 矩阵（见 ../real-api-qualification-and-e2e/）；构建和发布编排（见 ../build-release-and-documentation/）。
  Keywords: performance, benchmark, startup, bundle size, security, audit, snapshot, coverage,
  BLADE_RUN_REAL_REPO_BENCHMARK, Chromium sandbox, V8.
---

## Module Structure

该节点聚合四种不同可信度的质量信号：直接压产品实现的资源不变量、依赖构建产物的性能预算、源码边界审计，以及只锁定展示字符串的快照。

### Directory Layout
- `packages/cli/tests/performance/` — CLI 启动、数据结构、Token 算法和可选真实仓库 benchmark
- `packages/cli/web/tests/performance/` — production Web bundle 的 gzip 预算
- `packages/cli/tests/security/` — 输入模式、路径、敏感文件与 Browser Tool 源码边界检查
- `packages/cli/tests/snapshots/` — 工具输出示例及 Vitest snapshot
- `packages/cli/scripts/run-security-tests.sh` — 依赖审计、许可证和 outdated 辅助脚本
- `scripts/bench-sqlite.mts` — JSONL 与 SQLite 投影的独立人工 benchmark
- `packages/cli/vitest.config.ts` — performance/snapshot/security project 与 coverage 阈值
- `.github/workflows/ci.yml` — security、coverage、Chromium sandbox 和制品上传作业

### Key Entry Points
- `performance`、`snapshot`、`security` projects in `packages/cli/vitest.config.ts` — 三类专用测试选择器
- `packages/cli/tests/performance/regression/startup-time.test.ts` — 对已构建 CLI 的启动相对回归
- `packages/cli/web/tests/performance/bundle-size.test.ts` — Web 入口、首屏与总 JS gzip 上限
- `packages/cli/tests/security/browser-tool-boundary.test.ts` — Browser Tool 禁止能力与 sandbox 源码契约
- `packages/cli/tests/snapshots/outputs/tool-output.snap.test.ts` — 快照生成入口

## Branching Table

| 维度 | 分支 A | 分支 B |
|------|--------|--------|
| 性能对象 | `BoundedOutputBuffer`、`KeyedMutexRegistry` 直接压生产类并断言资源上限 | token-counter benchmark 使用测试内算法，只比较相对速度 |
| 制品依赖 | startup 与 Web bundle 测试要求已有 `dist` | 纯数据结构 benchmark 可直接从源码运行 |
| benchmark 启用 | 默认 performance project 跳过真实仓库 benchmark | `BLADE_RUN_REAL_REPO_BENCHMARK=1` 才运行真实 Agent 仓库任务 |
| 安全证据 | Browser 边界测试读取生产源码并锁定禁用能力/sandbox 约束 | injection/path/sensitive-file 测试主要验证测试文件内定义的检测器 |
| 依赖审计 | CI 执行 `bun audit --audit-level=critical` | 独立 shell 脚本使用 moderate 并额外检查许可证/outdated，但未接入 package 命令 |
| coverage | V8 对产品源码执行 80% 全局阈值，显式排除 performance | performance 独立运行，避免插桩与并发负载污染 wall-clock |
| snapshot | 默认测试把现有 `.snap` 当断言 | `test:update-snapshots` 显式传 `--update` 重写基线 |

## Affected Scope
- `packages/cli/src/tools/builtin/shell/` — 有界输出缓冲的内存与 retained chunk 不变量
- `packages/cli/src/utils/KeyedMutexRegistry.ts` — 高 churn key 的归零与并发保留上限
- `packages/cli/src/context/` — Token 预算和 SQLite/JSONL 投影的性能关注点
- `packages/cli/src/browser/` — Chromium sandbox、私有 API 禁用和真实浏览器集成边界
- `packages/cli/scripts/build.ts`、`packages/cli/web/vite.config.ts` — startup 与 Web bundle 测试所需制品的生成入口
- `packages/cli/tests/performance/` — 自动 performance project 与可选真实仓库 benchmark
- `packages/cli/tests/security/` — 安全 smoke、源码契约与输入分类样例
- `packages/cli/tests/snapshots/` — 人工批准的字符串输出基线
- `.github/workflows/ci.yml` — coverage 前 Chromium 安装、SUID helper、审计与报告上传

## Gotchas
- startup regression 直接执行 `dist/blade.js`，Web bundle 测试直接读取 `dist/web`；单独运行这些测试前未构建会因产物缺失失败，本地资格特意把 build 排在它们之前 (`packages/cli/tests/performance/regression/startup-time.test.ts`, `packages/cli/web/tests/performance/bundle-size.test.ts`, `packages/cli/scripts/qualification.ts`)
- `test:all` 不先构建却最后运行 performance，因此 clean checkout 上它不等价于按正确顺序运行的 `qualify:local` (`packages/cli/package.json`, `packages/cli/scripts/qualification.ts`)
- token-counter “性能测试”使用测试文件内的 `mockTokenCounter`，不会检测生产 TokenCounter 回归；只能把它当算法示例和相对噪声检查 (`packages/cli/tests/performance/benchmarks/token-counter.test.ts`)
- injection、path-traversal 与 sensitive-file 测试主要断言各测试文件内重写的正则/helper，不直接调用生产安全实现；这些通过不能替代对应工具与权限模块测试 (`packages/cli/tests/security/injection.test.ts`, `packages/cli/tests/security/path-traversal.test.ts`, `packages/cli/tests/security/sensitive-file.test.ts`)
- snapshot 测试也在测试文件内定义 formatter，而不是导入生产 `ToolResultProjector`；更新 snapshot 只证明示例字符串变化，不能证明真实表面输出兼容 (`packages/cli/tests/snapshots/outputs/tool-output.snap.test.ts`)
- `run-security-tests.sh` 没有被 `package.json`、qualification 或 CI 调用；实际 CI security job 只运行 Vitest security project 和 critical 级 `bun audit` (`packages/cli/scripts/run-security-tests.sh`, `packages/cli/package.json`, `.github/workflows/ci.yml`)
- 真实仓库 benchmark 默认 skip，且通过条件只检查 case 数、成功率范围和历史路径，没有最低成功率/延迟/token 阈值；它是观测工具而非阻断门 (`packages/cli/tests/performance/benchmarks/real-repo-benchmark.test.ts`, `packages/cli/scripts/run-real-repo-benchmark.ts`)

## Architecture
- coverage 使用 V8 并对 branches/functions/lines/statements 设置全局 80%，但排除脚本、测试、配置和入口文件；它衡量 `src` 核心实现，不覆盖交付脚本本身 (`packages/cli/vitest.config.ts`)
- CI coverage 在测试前安装固定 Chromium、配置 root-owned SUID sandbox helper 并运行 `browser:check`，因为 coverage 集合会收集真实 Chromium integration (`.github/workflows/ci.yml`, `packages/cli/tests/unit/scripts/qualification.test.ts`)
- 自动 performance project 同时容纳硬资源上限、相对 wall-clock 和可选真实仓库观测；阈值语义必须从具体测试读取，不能把整个目录理解为统一 benchmark 类型 (`packages/cli/tests/performance/benchmarks/bounded-output-buffer.test.ts`, `packages/cli/tests/performance/regression/startup-time.test.ts`, `packages/cli/tests/performance/benchmarks/real-repo-benchmark.test.ts`)

## Decisions
- wall-clock performance 被排除出 coverage，因为插桩与并行项目负载会破坏启动耗时可比性；它仍是本地资格的最后一项 (`packages/cli/scripts/test-config.js`, `docs/testing/qualification.md`)
- Web bundle 预算除了总量，还禁止 Markdown highlighter 与 xterm chunk 进入 initial graph，用架构约束防止懒加载被无意打平 (`packages/cli/web/tests/performance/bundle-size.test.ts`, `packages/cli/web/vite.config.ts`)

## Patterns
- 资源型性能测试优先验证 retained state 上限和最终归零，而不是只记录耗时；`BoundedOutputBuffer` 与 keyed mutex 分别固定 byte/chunk 和 key/operation 不变量 (`packages/cli/tests/performance/benchmarks/bounded-output-buffer.test.ts`, `packages/cli/tests/performance/benchmarks/keyed-mutex-registry.test.ts`)
- startup test 预热后取中位数并比较 `--help`/`--version` 比值与样本离散度，避免用单次绝对毫秒值放大 CI 抖动 (`packages/cli/tests/performance/regression/startup-time.test.ts`)
- 独立 SQLite benchmark 生成 50/200/1000 Session fixture，比较 JSONL cold scan 与 SQLite build/warm query；它打印数据但不属于 Vitest 门禁 (`scripts/bench-sqlite.mts`)

## Security Considerations
- Browser source-boundary 测试禁止 `--no-sandbox` 并检查私有 Playwright、持久 profile、代码执行和控制权转移 API 不进入公开实现，是比通用输入正则更接近生产边界的安全证据 (`packages/cli/tests/security/browser-tool-boundary.test.ts`)
- CI 的依赖审计只以 critical 为阻断级别，而辅助脚本以 moderate 为阈值；比较安全结果时必须注明所用入口，不能把二者视为同一策略 (`.github/workflows/ci.yml`, `packages/cli/scripts/run-security-tests.sh`)

## Branching Behavior
- `qualify:local` 先构建再跑 Web 与 performance，使制品预算有确定输入；直接执行 project 时调用方负责准备 `dist` (`packages/cli/scripts/qualification.ts`)
- coverage 分支会运行 security/snapshot 和无需凭据即可 skip 的 real-api 文件，但显式排除 performance；不能从 coverage 结果推断 wall-clock 或付费轨迹已通过 (`packages/cli/scripts/test-config.js`, `packages/cli/vitest.config.ts`)
- real-repo benchmark 的环境开关关闭时记录为 skipped 测试；需要趋势数据时应使用 `benchmark:repo` 或显式开关，而不是读取普通 performance 通过数 (`packages/cli/tests/performance/benchmarks/real-repo-benchmark.test.ts`, `packages/cli/package.json`)
- 快照更新分支会接受当前输出为新权威，必须先确认变化来自预期产品 formatter；当前示例快照本身并未连接生产 formatter (`packages/cli/scripts/test.js`, `packages/cli/tests/snapshots/outputs/tool-output.snap.test.ts`)
