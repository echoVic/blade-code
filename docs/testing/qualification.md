# Blade Code 测试手段与生产准出

Blade Code 将确定性回归与付费模型验证分成两道门禁。两道门禁都必须通过，
功能 patch 才能标记为生产就绪。

## 受控代码评测

`bun run benchmark:repo -- --model <已配置模型ID>` 运行
`controlled-coding-v2`：只读诊断、单文件修复和跨模块 API 迁移三个固定小型任务。
它使用 production dist、Node、npm 和已配置的 API-key 模型，不安装依赖，也不创建
worktree。

每个任务拥有独立临时项目、HOME 和 Session 存储，并禁用 MCP、LSP、hooks 与插件。
宿主检查真实文件读取、限定路径修改、修改后的 `npm test`、独立目录中的边界样例及
返回值。修改测试或 `package.json`、增加额外文件、缺失工具证据、仅输出成功文本或仅
`exit(0)` 都不能通过。

默认结果写入 `.blade/benchmarks/controlled-coding-v2-history.json`。该评测不是大型
真实仓库基准，也不证明与其他 coding agent 的整体能力等价。

## 本地门禁

在仓库根目录执行：

```bash
bun run qualify:local
```

命令按顺序执行 14 个检查：

1. TypeScript 类型检查
2. 格式检查
3. lint
4. 单元测试
5. 集成测试
6. CLI 测试
7. Headless/runtime 核心回归
8. E2E
9. snapshot
10. 安全测试
11. production build
12. Web 测试
13. Web 类型检查
14. 性能回归

任一步骤非零退出都会立即停止。该门禁不访问付费模型。

`test:headless-core` 显式运行当前的
`headless-boundaries.test.ts` 与 `headless-event-contract.test.ts`。后者直接验证
`HEADLESS_EVENT_VERSION`、`createHeadlessJsonlEvent` 和
`HeadlessJsonlEventSchema`。所有显式测试清单都会在启动 Vitest 前检查文件存在性，
缺失路径直接失败。

V8 coverage 由 `bun run test:coverage` 单独执行。它覆盖 unit、integration、CLI、
E2E、snapshot、security 和无需凭据的 real-api fixture，并排除 wall-clock
performance project。

## 真实 API 门禁

真实 API 测试必须使用当前源码刚构建的 `packages/cli/dist/blade.js`。Provider
credential 可以由 secret manager 注入子进程环境，也可以放在
`~/.blade/real-api-credentials.json`。凭据文件必须是当前用户拥有的普通文件、权限
`0600`、大小不超过 64 KiB；符号链接、宽松权限和未知字段都会 fail closed。

不要把真实值写成 inline `KEY=value`、保留在 shell history 或复制到证据文档。
日志只保留变量名、模型 ID、计数、耗时和脱敏宿主证据。

首次运行或 Playwright 版本变化后安装 Chromium：

```bash
bun run --filter blade-code browser:install
```

生产准出执行：

```bash
bun run qualify:production
```

该命令先运行 14 个本地检查，再运行无密钥 Chromium preflight，最后才启动付费
Provider 测试。preflight 失败时不会产生 Provider 流量。

### 发布阻断矩阵

`test:real-api:qualification` 由 `scripts/test-config.js` 中的固定白名单控制，共 9 个
测试文件：

1. `agent-trajectory.test.ts`：生产 Agent 读取、修改和测试
2. `structured-output-trajectory.test.ts`：结构化输出
3. `durable-interaction-recovery-trajectory.test.ts`：durable interaction recovery
4. `release-coding-trajectory.test.ts`：跨 surface 代码迁移
5. `task-list-team-trajectory.test.ts`：Agent Team 任务协调
6. `cross-provider-fallback-trajectory.test.ts`：跨 Provider fallback
7. `goal-mode-trajectory.test.ts`：Goal 创建、执行和完成
8. `browser-tool-trajectory.test.ts`：Native Browser Tool
9. `acp-remote-filesystem-trajectory.test.ts`：ACP remote filesystem

发布矩阵设置 `REAL_API_TEST=1` 和 `REAL_API_RELEASE_MATRIX=1`，Vitest retry 固定为
0，并强制使用 DeepSeek Flash/Pro。需要 Claude 或 GPT 的跨 Provider cell 在凭据
缺失时 fail closed，而不是降级成 mock。

这些轨迹必须通过真实 Provider 请求和宿主可观察副作用：文件内容、durable event、
工具结果、浏览器状态、ACP update 或测试进程结果。模型自述、HTTP `200`、mock
ToolExecutor 和 jsdom-only 覆盖都不能替代。

### 普通真实 API 集合

`bun run test:real-api` 也使用显式 inventory，不再隐式扫描目录。当前 inventory 包含
上述 9 个文件，以及：

10. `goal-paused-usage-trajectory.test.ts`
11. `workspace-agent-resources-trajectory.test.ts`

`goal-paused-usage` 的 40-cell 扩展矩阵只在
`REAL_API_RELEASE_MATRIX=1` 时启用；`workspace-agent-resources` 总会运行内置
DeepSeek skill 轨迹，并在配置 GPT 凭据时追加 workspace 隔离轨迹。因此如需执行当前
inventory 中所有 release-only cell，使用：

```bash
REAL_API_RELEASE_MATRIX=1 bun run test:real-api
```

删除或重命名 inventory 文件后，runner 会在启动 Vitest 前失败。新增真实 API 轨迹也
必须显式加入对应 inventory 和 source-contract 单测，避免目录变化造成静默缩减。

普通 `test:all` 和 CI 不会产生付费请求。国产模型通道默认不进入发布阻断；仅在显式设置
`REAL_API_INCLUDE_OPTIONAL_PROVIDERS=1` 时作为可选渠道加入。

## 准出证据

每个独立 patch 至少保留：

- 冻结候选的完整 SHA、版本和日期；
- `bun run qualify:local` 的命令、结果和退出码；
- `bun run qualify:production` 的命令、逐文件结果和退出码；
- browser preflight、process/lease/terminal/port/temp-root cleanup 与凭据缺失断言；
- 首个失败 cell 的有界脱敏诊断及清理结果；
- `git diff --check`、build、type-check 和 lint 结果。

只有源码未变化的 Provider transient 才允许整套重跑。跳过测试、模型文本或预填
`PASS` 不能作为资格证据。
