# Remote Session Surface Identity 资格验证证据

## 发布候选身份与范围

- 设计规格：`docs/superpowers/specs/2026-09-02-remote-session-surface-identity-design.md`
- 实施计划：`docs/superpowers/plans/2026-09-02-remote-session-surface-identity.md`
- 基线：`v0.10.128`
- 目标版本：`0.10.129`
- 最终代码候选：`2fa1cc1d582594ec977fa0136319960406065c13`
- 候选范围：`v0.10.128..2fa1cc1d`，共 `36` 个设计、实现、修复与资格验证提交
- 资格验证日期：`2026-09-02`

本证据覆盖一个统一、只读且有界的 Session history surface：它可以列出、打开、
分页和 fork 本地及 ACP remote 历史，并由 Web GUI 与终端 TUI 使用。remote
locator 只有不透明 public workspace reference；规范化 remote cwd 只用于显示。

本次资格验证不把 public reference、catalog capability 或 `displayCwd` 当成执行授权。
remote open/fork 必须重新解析并校验 durable identity，且只返回白名单历史消息。

## 提交职责

| Task | 提交 | 职责 |
| --- | --- | --- |
| Design | `3dad8ab6`, `eb282074`, `3c81ba84`, `c0a171dc` | 冻结 identity、生命周期、GUI/TUI 与执行计划 |
| 1 | `a03ca569`, `d247e065`, `eccdfe25` | 定义并收紧 V2 locator、capability、message、request/response 与 error schema |
| 2 | `63a28916`, `7f1f725c` | 在受保护 remote scope 中持久化随机 public reference，并加固 crash-safe publish |
| 3 | `33012577`, `e2ce840b` | 投影 exact、generation-current owner 状态并约束 teardown |
| 4 | `3786d10c` | 增加严格 message projector 与有界 cursor/snapshot registry |
| 5 | `15f5313c` | 将 schema v7 SQLite disposable projection 用于有界 catalog/history 查询 |
| 6 | `eb6dd8db` | 增加 lifecycle-owned `SessionSurfaceService` 与 JSONL fallback |
| 7 | `802bd49b` | 增加独立 `/sessions/v2` Hono routes 与 graceful shutdown ownership |
| 8 | `610e98bb` | 在 V1 Session、suggestions 和 terminal 边界拒绝 protected remote roots |
| 9 | `e55f6c77` | 增加 Web V2 client、opaque navigation 和隔离的 history store |
| 10 | `962d599c` | 增加 Web remote history GUI 与双层 action gates |
| 11 | `67750dfb` | 增加 TUI remote selector、history viewer 和 owned controller |
| 12 | `3daefa82`, `d3ab622a`, `a1ccc071` | 增加 paired-ACP fixture、修复 surface path redaction，并完成 GUI/TUI 真实资格验证 |
| Review closure | `fd7be712`, `8c4c39b0`, `626085d2`, `2a270f18`, `d219be8d`, `c44555ce`, `6a9b63f0`, `b6143a65`, `7d41ccc2`, `2a1d6f46`, `27e243e7`, `94833144`, `2765bcc8`, `2fa1cc1d` | 收紧 Session/lineage ID、Win32 path redaction、rotated locator、GUI/TUI history window、request body、local service 与 persisted source 边界，以及 suggestions path 的 lexical/canonical containment |

## 直接安全证据

| 要求 | 直接证据 | 结果 |
| --- | --- | --- |
| locator 不含 private path/descriptor | TypeBox negative tests；Chromium 的 response、DOM、URL、console、server log canary scan | PASS |
| public reference 稳定且受保护 | mode、symlink、并发、restart、rotation、transplant、corruption、capacity tests | PASS |
| mixed catalog 稳定且有界 | SQLite epoch/revision、semantic digest、JSONL frozen snapshot 与 cursor replay tests | PASS |
| history 白名单且有界 | strict message schema、`limit + 1` SQLite query、`256 KiB` message 与 `512 KiB` page tests | PASS |
| remote open/fork 不创建 live authority | 围绕 production service 的 Runtime、Agent、SSE、Browser、filesystem、Git、hook、plugin、skill、PTY spies | PASS |
| Web history-only fail closed | component/store/direct-handler tests 与 Chromium request/WebSocket assertions | PASS |
| TUI 不改变 live local Session | real Ink stdin/stdout、store identity、activity count 与 source transcript assertions | PASS |
| owner 状态不可转移 | duplicate Session ID、exact identity、collision-only 与 stale generation tests | PASS |
| local 与 ACP-local parity | V1 route、local activation、Web、TUI 与 fork regression suites | PASS |

公开历史消息只有不透明 ID、`user` / `assistant` role、content、timestamp 与可选
`truncated`。metadata、reasoning、tool calls/results、attachment payload、host roots、
descriptor identities 和 raw event fields 均不进入 surface。canonical remote
`displayCwd` 是唯一有意公开的远程路径字段；它不会进入 locator 或 URL，也不会被
任何文件、终端或执行入口消费。

## Focused deterministic 资格验证

### Core / service / route matrix

```bash
cd packages/cli
bun x vitest run --config vitest.config.ts --project=unit --maxWorkers=1 \
  tests/unit/integrations/api/session-surface-schemas.test.ts \
  tests/unit/integrations/api/schemas.test.ts \
  tests/unit/agent-runtime/acp/remote-workspace-reference.test.ts \
  tests/unit/agent-runtime/acp/service-context.test.ts \
  tests/unit/services/session-surface-projection.test.ts \
  tests/unit/services/session-surface-cursor-registry.test.ts \
  tests/unit/services/session-surface-service.test.ts \
  tests/unit/context/sqlite/projection.test.ts \
  tests/unit/agent-runtime/server/session-surface-routes.test.ts \
  tests/unit/agent-runtime/server/server-session-surface-shutdown.test.ts \
  tests/unit/agent-runtime/server/session-ref.test.ts \
  tests/unit/agent-runtime/server/session-routes.test.ts \
  tests/unit/agent-runtime/server/session-fork-routes.test.ts \
  tests/unit/agent-runtime/server/suggestions-routes.test.ts \
  tests/unit/agent-runtime/server/terminal-routes.test.ts \
  tests/unit/integration/session-surface-qualification-harness.test.ts
```

结果：`16` 个文件、`426/426` tests passed，exit `0`。此前并行执行时，未修改源文件的
真实双进程 1,024 capacity 竞争用例出现过一次间歇失败；随后该用例连续单独复跑 3 次
均通过，上述完整矩阵也在单 worker 下通过。

### TUI focused matrix

```bash
cd packages/cli
bun x vitest run --config vitest.config.ts --project=cli \
  tests/integration/cli/session-history-surface.test.tsx \
  tests/integration/cli/session-selector-fork.test.tsx
```

结果：`2` 个文件、`8/8` tests passed，exit `0`。测试使用真实 Ink input router
与 typed stdin/stdout stream，覆盖 remote selection、分页、搜索、复制、fork、关闭、
late completion fencing，并验证原 local Session 对象保持不变。

### Web focused matrix

```bash
cd packages/cli/web
bun x vitest run --config vitest.config.ts \
  tests/store/session/sessionIdentity.test.ts \
  tests/store/session/sessionNavigation.test.ts \
  tests/store/session/sessionSlice.test.ts \
  tests/store/session/eventHandlers.test.ts \
  tests/components/layout/Sidebar.test.tsx \
  tests/components/layout/Layout.test.tsx \
  tests/components/chat/ChatView.test.tsx \
  tests/components/chat/ChatInput.test.tsx \
  tests/components/preview/FilePreview.test.tsx \
  tests/components/tasks/TaskArtifactBar.test.tsx \
  tests/App.test.tsx
```

结果：`11` 个文件、`298/298` tests passed，exit `0`。覆盖 merged catalog、
opaque locator navigation、history sibling state、generation fencing、refresh restore、
remote badges、disabled/hidden controls 及直接 handler fail-closed。

## Production GUI、TUI 与真实 Provider

最终 release cell：

```bash
cd packages/cli
REAL_API_TEST=1 REAL_API_RELEASE_MATRIX=1 \
  bun x vitest run --config vitest.config.ts --project=real-api --retry=0 \
  --reporter=verbose \
  tests/integration/real-api/session-surface-history-trajectory.test.ts \
  tests/integration/real-api/session-surface-tui-trajectory.test.tsx
```

结果：`2` 个文件、`4/4` tests passed，exit `0`，总 duration `23.84s`。framework
retry 为 `0`，fixture 强制 model `maxRetries=0`。

| Surface | Model | Duration | 直接断言 |
| --- | --- | ---: | --- |
| Production Chromium GUI | `deepseek-v4-flash` | `6.412s` | merged local/remote catalog、offline/history-only banner、canonical cwd、分页、loaded-page search、fork、refresh、local Session 不变、network/privacy scan |
| Production Chromium GUI | `deepseek-v4-pro` | `7.573s` | 同上 |
| Real Ink TUI | `deepseek-v4-flash` | `2.601s` | selector、分页、搜索、复制、fork、关闭、local Session identity 不变、stdout/stderr privacy scan |
| Real Ink TUI | `deepseek-v4-pro` | `2.812s` | 同上 |

每个模型先通过 production `BladeAgent` 与 paired ACP NDJSON 创建真实 remote
transcript，然后断开 owner。GUI 启动 production `dist/blade.js serve` 和 Playwright
Chromium。浏览历史期间 fixture 的 Provider、remote file 与 remote terminal activity
计数保持不变，source transcript 字节保持不变；没有第二次 Provider 请求，也没有
history-only file/terminal/browser/review/message-write 请求。

TUI 资格验证直接驱动真实 Ink input/output 与 production
`SessionSurfaceService`，没有使用 mocked Agent、Runtime、ACP connection、
SessionService 或 Provider。本 cell 没有启动 production raw PTY，也没有使用 desktop
computer-use；因此证据只主张真实 Ink 输入与状态转换，不主张桌面视觉自动化。

Chromium screenshot 只作为运行中辅助断言，测试结束时即删除。fixture 也在 callback
后撤销引用并在 deadline 内清理；不持久化 raw screenshot、remote transcript、路径、
descriptor 或 credential。

## 完整仓库门禁与覆盖率

- `bun run format:check && bun run lint && bun run type-check && bun run build`：
  全部 exit `0`。build 仅有既有 Browserslist stale-data 与大于 `500 kB` chunk warning。
- `bun run test:all`：exit `0`。主阶段 `474` files passed / `94` skipped，
  `5472` tests passed / `84` skipped，duration `321.20s`；performance 阶段
  `4` files passed / `1` skipped，`9` tests passed / `1` skipped，duration `5.29s`。
- `CI=true bun run --filter blade-code test:coverage`：exit `0`，`474` files passed /
  `94` skipped，`5472` tests passed / `84` skipped，Vitest duration `484.79s`、
  wrapper duration `487.84s`。总覆盖率 statements `73.38%`、branches `66.79%`、
  functions `75.34%`、lines `74.71%`。
- 计划中的 Web 命令从 `packages/cli/web` 运行时，在加载测试前暴露既有依赖错配：
  workspace-local `vitest 3.2.7` 解析了根目录 `@vitest/coverage-v8 4.1.10`，报
  `Class extends value undefined`。未改依赖或 lockfile；改用已安装且版本匹配的根目录
  `vitest 4.1.10` 对相同 config 和完整集合运行：

```bash
cd packages/cli/web
CI=true ../../../node_modules/.bin/vitest run --config vitest.config.ts --coverage
```

结果：`66` 个文件、`591/591` tests passed，duration `10.27s`，并显式捕获 exit
code `0`；Web 总覆盖率 statements `72.83%`、branches `64.73%`、functions
`71.62%`、lines `75.66%`。
`src/components/history` 为 `91.42% / 74.13% / 95.83% / 96.72%`。这是真实
完整 Web source coverage；原始 wrapper/provider 兼容性失败没有被描述为测试失败。
tag 触发的 CI coverage job 仍必须在发布前通过。

## 有界产物哈希

以下 SHA-256 固定了资格验证 harness 与 trajectory 源码，不包含 credential、raw
remote content、descriptor 或 workspace reference：

| 产物 | SHA-256 |
| --- | --- |
| `tests/support/acp/remoteFilesystemQualification.ts` | `c5c258f11ec87aa31b16b3b92b5d0070cf4cdd54d2d22ffdb51871acf6abd9bf` |
| `tests/support/launch-session-surface-gui.ts` | `695c5b8d2614b6e33fbd8a5d2f90c270c8f4ccbb4d09860ca0b2a016d0f54c84` |
| `tests/integration/real-api/session-surface-history-trajectory.test.ts` | `2fc2dc0173ca521efab66ae7b4f2ed00d537b1cf04816ae359d7f84b16b4b754` |
| `tests/integration/real-api/session-surface-tui-trajectory.test.tsx` | `195d8a0f87b30bf79dd8b709ac2f6be42ea3d09f47074f5d36740ab0bd46602b` |
| CLI `coverage-final.json`（`14,469,522` bytes） | `7c79ee7c48789e421399ce5d1385c2a9dcb91106564d4096d2971e0f6e8cc184` |
| Web `coverage-final.json`（`3,108,086` bytes） | `fe3dc95f966bb293231504d694c218629df861576b055dddf804ca3237034c07` |

fixture 内还计算 provider request、remote filesystem sequence、assistant output 与
transcript 的 canonical SHA-256，并只向断言暴露 digest、计数和布尔结果；这些值不在
日志中回显，以避免持久化内容衍生标识。coverage 文件位于 ignored 目录，只用于本地
复核，不进入 release commit。

## 独立审查

独立规格 reviewer 与质量/安全/并发 reviewer 均以 peeled `v0.10.128` 为基线，
审查了精确 committed candidate `2fa1cc1d582594ec977fa0136319960406065c13`。两者均
给出 `APPROVED`，且没有 Critical、Important 或 Minor finding。质量 reviewer 还复跑了
suggestions、plugin、projection、service、TUI 与 route 的 focused tests 以及
`git diff --check`。

## 限制与发布后门禁

- 本版本不支持从 Web/TUI 发起 remote Agent turn、remote file browser/edit、ACP
  command console、remote PTY、remote Browser control 或 remote code review。
- owner discovery 仅限当前进程；public workspace reference 不是认证或执行凭据。
- JSONL fallback 有 `10,000` rows / `16 MiB` 单 chain 上限；cursor registry 有
  `2,048` entries、`64` chains、每 chain `32` cursors、`64 MiB` frozen snapshot
  与 `10` 分钟 idle TTL 上限。达到边界时 fail closed。
- 发布尚需由 annotated `v0.10.129` tag 触发 `publish.yml`，并核对 local HEAD、
  `origin/main`、local/remote peeled tag SHA、workflow `headSha`、npm
  `version/gitHead/latest`、GitHub Release 与 clean worktree。
