---
name: knowledge-engineering-quality-and-delivery
description: >
  覆盖 Blade Code 跨测试、构建、资格验证、发布与双语文档的工程质量闭环。
  Navigate when: 调整测试分层、CI 门禁、真实 API 准出、构建产物、npm 发布或文档同步。
  Excludes: 具体运行时业务语义（转到对应功能域）；各门禁实现细节继续进入本节点的四个子节点。
  Keywords: quality gate, qualification, Vitest, real API, performance, security, snapshot,
  build, release, npm, GitHub Actions, Docsify, changelog.
---

## Module Structure

该域不是单一模块，而是把确定性测试、付费模型轨迹、制品级门禁和 tag 驱动发布串成一条跨 CLI、Web、ACP、TUI 与文档的交付链。

### Directory Layout
- `packages/cli/tests/` — CLI 核心的 unit、integration、CLI、E2E、real-api、performance、snapshot 与 security 测试
- `packages/cli/web/tests/` — Web 组件、Store、服务和 bundle 预算测试
- `packages/cli/scripts/` — 测试运行器、资格编排、构建、凭据加载与发布脚本
- `scripts/` — 仓库级发布辅助和独立基准脚本
- `.github/workflows/` — CI、tag 发布与 Docs Pages 部署
- `docs/` — 中文默认站点、英文镜像、设计规格和准出证据
- `package.json`、`packages/cli/package.json` — 工作区命令、发布包边界与版本
- `biome.json`、`packages/cli/vitest.config.ts`、`packages/cli/web/vitest.config.ts` — 静态检查与测试项目定义

### Key Entry Points
- `createQualificationPlan()` in `packages/cli/scripts/qualification.ts` — 定义本地 14 项和生产 16 项顺序门禁
- `testTypes` in `packages/cli/scripts/test-config.js` — 定义各 Vitest 项目、超时、环境和发布阻断文件白名单
- `packages/cli/scripts/build.ts` — 构建 CLI ESM 产物并把 Web 输出到同一发布目录
- `.github/workflows/ci.yml` — 聚合确定性 CI 作业
- `.github/workflows/publish.yml` — 校验 tag/包版本并通过 npm Trusted Publishing 发布
- `.github/workflows/docs.yml` — 生成文档站 changelog 并部署 Pages

## Branching Table

| 维度 | 本地或确定性分支 | 生产或发布分支 |
|------|------------------|----------------|
| 资格入口 | `qualify:local` 顺序执行 14 项且不接触付费凭据 | `qualify:production` 在本地门禁后追加 Chromium preflight 和付费真实 API |
| 测试证据 | unit/integration/E2E 允许隔离、mock 或本地 fixture | release matrix 要求真实 Provider、production surface 和宿主侧副作用证据 |
| 覆盖率与性能 | coverage 插桩运行除 performance 外的项目 | performance 在 production build 后独立运行，避免插桩污染时序 |
| 发布准备与发布 | 本地负责冻结候选、版本、双语 changelog、资格证据与 tag | tag workflow 只校验版本、构建、幂等发布 npm/GitHub Release |
| 文档源与站点产物 | `docs/`、`CHANGELOG.md`、`CHANGELOG.zh.md` 是 Git 可见源 | `docs/changelog.md` 与 `docs/en/changelog.md` 在部署时生成且被忽略 |
| 浏览器依赖 | npm 包携带固定 Playwright 运行库但不下载 Chromium | 浏览器门禁要求显式安装并通过离线 launch/close preflight |

## Affected Scope
- `packages/cli/src/` — 每个运行时变更都要映射到确定性回归与适当的真实轨迹
- `packages/cli/web/src/` — Web 行为同时受组件测试、production Chromium 轨迹和 bundle 预算约束
- `packages/cli/tests/` — 汇集本地回归、跨表面驱动、资源回收和发布矩阵
- `packages/cli/scripts/` — 决定测试项目选择、超时、凭据隔离、构建顺序和本地发布行为
- `.github/workflows/` — 把静态检查、跨平台 smoke、coverage、安全审计、npm 与 Pages 分成独立作业
- `packages/cli/package.json` — 发布版本、npm 文件清单、运行时依赖和质量命令的权威入口
- `CHANGELOG.md`、`CHANGELOG.zh.md` — 英文包内更新信息与中文同步发布记录
- `docs/` — 用户行为契约、设计冻结记录和可审计的资格证据

## Gotchas
- `bun run test:all` 不是完整准出：它不执行资格编排的类型、格式、lint、构建、浏览器 preflight 和付费矩阵，发布判断必须使用 `qualify:local` 与 `qualify:production` (`package.json`, `packages/cli/scripts/qualification.ts`)
- tag 触发的发布工作流不重新运行测试或真实 API；错误地把 `publish.yml` 成功当作候选质量证明，会发布仅“可构建”的未资格版本 (`.github/workflows/publish.yml`, `docs/testing/qualification.md`)
- 当前 `release:patch` 路径由配置关闭测试、代码质量和安全检查，只能做版本/tag 编排，不能替代冻结 SHA 上的资格流程 (`packages/cli/release.config.js`, `packages/cli/scripts/release.js`)
- `tests/e2e/` 的名称不代表生产端到端证据，其中仍有 mock 与占位断言；发布级行为由显式 `realApiQualification.files` 决定 (`packages/cli/tests/e2e/core-features.test.ts`, `packages/cli/tests/e2e/flows/chat-flow.test.ts`, `packages/cli/scripts/test-config.js`)

## Architecture
- 资格编排严格串行且首个非零退出即停止，避免后续通过项掩盖更早的失败；CI 则拆成并行作业，最终由 `ci-pass` 汇总失败与取消状态 (`packages/cli/scripts/qualification.ts`, `.github/workflows/ci.yml`)
- 交付证据分为确定性代码门禁、真实 Provider/宿主轨迹、冻结候选 evidence 文档和 tag 后 registry/Release 验证，任一层都不能由另一层替代 (`docs/testing/qualification.md`)
- 构建把后端与 Web 放入 `packages/cli/dist/`，npm 包再通过 `files` 白名单发布该目录及少量运行时资产；性能与 Web 制品测试因此必须位于构建之后 (`packages/cli/scripts/build.ts`, `packages/cli/package.json`, `packages/cli/scripts/qualification.ts`)

## Decisions
- 公共 CI 不注入付费 Provider 凭据，真实 API 是发布者在候选 SHA 上显式运行的门禁；这避免 secret 暴露，但意味着 tag workflow 本身不是完整准出权威 (`docs/testing/qualification.md`, `.github/workflows/ci.yml`)
- 每个独立功能或修复单独发布 patch，并让版本、双语 changelog、用户文档和资格证据共同描述同一个行为增量 (`AGENTS.md`)

## Patterns
- 高风险功能通常同时增加确定性单测、真实 API 跨表面轨迹、`test-config.js` 白名单断言、资格文档和最终版本元数据，缺一项会留下未覆盖分支 (`packages/cli/tests/unit/scripts/test-runner.test.ts`, `docs/testing/qualification.md`)
- 近期开版提交稳定地把 `packages/cli/package.json`、`CHANGELOG.md` 与 `CHANGELOG.zh.md` 一起变更，防止包版本与两种语言的发布记录漂移 (`packages/cli/package.json`, `CHANGELOG.md`, `CHANGELOG.zh.md`, `git:1ce74b03`)

## Conventions
- 中文文档位于 `docs/` 根，英文镜像位于 `docs/en/`；行为变化需要同步两边，而生成的站点 changelog 只能由部署工作流复制 (`AGENTS.md`, `.github/workflows/docs.yml`)

## Branching Behavior
- 非付费检查会主动移除 real-API 开关、凭据文件位置和各 Provider key/model 变量；只有标记为 `paid-api` 的最后一项接收物化后的凭据环境 (`packages/cli/scripts/qualification.ts`)
- production 分支在真实 API 前执行不联网的 Chromium 检查，preflight 失败会令顺序执行器停止，从而保证零 Provider 请求 (`packages/cli/scripts/qualification.ts`, `packages/cli/tests/unit/scripts/qualification.test.ts`)
- coverage 分支排除 wall-clock performance，而本地资格分支在构建后单独执行 performance；新增制品性能断言时必须同时考虑这两个入口 (`packages/cli/vitest.config.ts`, `packages/cli/scripts/test-config.js`, `packages/cli/scripts/qualification.ts`)
- 发布分支以 `packages/cli/package.json` 的版本匹配 `v*.*.*` tag；仓库根 `package.json` 的私有 monorepo 版本不是 npm 发布版本 (`package.json`, `packages/cli/package.json`, `.github/workflows/publish.yml`)

## Child Knowledge Nodes
- `./unit-integration-and-shared-test-harnesses/SKILL.md` — Navigate when: 新增 unit/integration/Web 测试，调整 Vitest project、mock、临时目录或测试进程清理
- `./real-api-qualification-and-e2e/SKILL.md` — Navigate when: 修改真实 Provider、发布矩阵、跨表面驱动、凭据或资格证据
- `./performance-security-and-snapshot-gates/SKILL.md` — Navigate when: 调整性能预算、安全检查、coverage 或快照更新策略
- `./build-release-and-documentation/SKILL.md` — Navigate when: 修改构建输出、npm 包内容、版本/tag 发布、CI action 或双语文档部署
