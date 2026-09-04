# Web Durable Task Unread Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** 让 Web 在 reload 或全局任务事件流断线期间错过后台任务终态时，仍能从完整 session catalog 恢复精确、持久且不会反复复活的 unread attention。

**Architecture:** 在 packages/cli/web/src/store/session/taskAttention.ts 增加版本化“已读终态指纹 ledger”纯函数，在 Zustand task slice 中以内存副本为页面生命周期内的权威状态。loadSessions() 用完整分页 accumulator 与 live task revision overlay 做一次原子 reconcile；live task event、成功导航、clear、删除和归档复用同一套 acknowledge/prune 语义。服务端 API 和 SSE wire protocol 保持不变。

**Tech Stack:** TypeScript strict、React、Zustand、Vitest、Playwright Chromium、真实 DeepSeek Flash/Pro qualification、Biome。

---

### Task 1: 建立终态指纹与持久化 ledger 纯函数

**Files:**
- Modify: packages/cli/web/src/store/session/taskAttention.ts
- Modify: packages/cli/web/tests/store/session/taskAttention.test.ts

- [ ] **Step 1: 写 signature 与 parser RED**

加入 typed Session fixtures 并断言：running 返回 null；completed 返回 JSON.stringify(['completed', canonicalISOString, null])；failed 只写 validated failure code，不含 failure message 或 status reason；非法日期归一化为 null。再用内存 Storage 证明缺失、损坏、非 v1 payload 返回空 ledger，重复 key last-wins，非法 compound key、非法 signature、超过 16,384 code units 的 key 被忽略。

- [ ] **Step 2: 写 compaction RED**

构造超过 1,024 个 acknowledged terminal entries，另加 active null baseline 与 unread entry。断言后两类受保护，只有最旧 acknowledged terminal 被淘汰；重新 acknowledge 的 terminal entry 移到 MRU 端；完整 active catalog 中不存在的 ref 被删除；同 sessionId 不同 projectPath 保持独立。compound-key parser 分别接受 POSIX absolute、Win32 drive-qualified 与 UNC projectPath，并拒绝相对路径、空 sessionId、错误数组长度。

- [ ] **Step 3: 运行 RED**

~~~bash
cd packages/cli/web
bun x vitest run --config vitest.config.ts \
  tests/store/session/taskAttention.test.ts
~~~

Expected: 新导入不存在或新增断言失败；既有 unread tests 继续通过。

- [ ] **Step 4: 实现最小纯函数 API**

新增严格类型 TaskTerminalReadLedgerEntry、TaskTerminalReadLedgerV1，以及：

~~~ts
export type TaskTerminalState = Pick<
  Session,
  'taskStatus' | 'taskCompletedAt' | 'taskFailure'
>;

export function taskTerminalSignature(state: TaskTerminalState): string | null;
export function readTaskTerminalReadLedger(
  storage?: Pick<Storage, 'getItem'> | null
): TaskTerminalReadLedgerV1;
export function persistTaskTerminalReadLedger(
  ledger: TaskTerminalReadLedgerV1,
  storage?: Pick<Storage, 'setItem'> | null
): void;
export function acknowledgeTaskTerminal(
  ledger: TaskTerminalReadLedgerV1,
  ref: SessionRef,
  state: TaskTerminalState
): TaskTerminalReadLedgerV1;
export function reconcileTaskAttention(input: {
  ledger: TaskTerminalReadLedgerV1;
  unreadTaskKeys: readonly string[];
  sessions: readonly Session[];
  currentSessionRef: SessionRef | null;
  documentVisible: boolean;
}): {
  ledger: TaskTerminalReadLedgerV1;
  unreadTaskKeys: string[];
};
export function pruneAndCompactTaskTerminalReadLedger(input: {
  ledger: TaskTerminalReadLedgerV1;
  sessions: readonly Session[];
  unreadTaskKeys: readonly string[];
}): TaskTerminalReadLedgerV1;
~~~

parser 必须 JSON.parse compound key 后通过 sessionRefKey 重建并比较 canonical key；禁止 any、as any、as never 与 suppression。持久化失败 fail soft。

- [ ] **Step 5: 运行 GREEN 并提交**

~~~bash
cd packages/cli/web
bun x vitest run --config vitest.config.ts \
  tests/store/session/taskAttention.test.ts
cd ../../..
bun run type-check:web
cd packages/cli
bun x biome check web/src/store/session/taskAttention.ts \
  web/tests/store/session/taskAttention.test.ts
cd ../..
git diff --check
git add packages/cli/web/src/store/session/taskAttention.ts \
  packages/cli/web/tests/store/session/taskAttention.test.ts
git commit -m "feat(web): persist task terminal acknowledgements"
~~~

Expected: focused tests、Web type-check、Biome、diff check 全部通过。

### Task 2: 接入 live event 与 read/clear/remove 入口

**Files:**
- Modify: packages/cli/web/src/store/session/types.ts
- Modify: packages/cli/web/src/store/session/slices/taskListSlice.ts
- Modify: packages/cli/web/src/store/session/slices/sessionSlice.ts
- Modify: packages/cli/web/tests/store/session/taskListSlice.test.ts
- Modify: packages/cli/web/tests/store/session/sessionSlice.test.ts

- [ ] **Step 1: 写 live event 因果 RED**

在 taskListSlice.test.ts 加入这些精确场景：known running exact ref + missing ledger + terminal event 产生 unread；unknown terminal event 只静默建 terminal baseline；ledger null + terminal event 产生 unread；同 signature 重复事件不重复 unread/通知；已 acknowledge terminal 收到新 completedAt 或 failure code 再次 unread；visible current exact ref 被 acknowledge 而不 unread；同 sessionId 不同 projectPath 隔离。另证明已 acknowledge terminal 后收到 running 事件时永不 unread、原子推进 baseline 为 null，下一次 terminal 又能产生 unread。

- [ ] **Step 2: 写 read、clear、remove RED**

断言 markTaskRead 在清 exact key 前推进该 session 当前 signature；clearUnreadTasks 在 catalogLoadState 非 ready 时完全 no-op，在 ready 时只 acknowledge 当前 unread 且存在的 exact refs，并删除 absent stale refs；remove/delete/archive 同时清 exact unread、ledger 和 live projection，不影响另一项目的同 ID ref。

- [ ] **Step 3: 运行 RED**

~~~bash
cd packages/cli/web
bun x vitest run --config vitest.config.ts \
  tests/store/session/taskListSlice.test.ts \
  tests/store/session/sessionSlice.test.ts
~~~

Expected: 新 ledger state、terminal-to-terminal、hydrating clear 或 prune 断言失败。

- [ ] **Step 4: 增加 slice 内存权威状态**

在 TaskListSlice 中新增：

~~~ts
type SessionCatalogOverlay =
  | {
      revision: number;
      kind: 'upsert';
      session: Session;
    }
  | {
      revision: number;
      kind: 'remove';
    };

interface TaskLiveProjection {
  revision: number;
  taskStatus: Session['taskStatus'];
  taskStatusReason?: string;
  taskFailure?: Session['taskFailure'];
  taskPromptSummary?: string;
  taskStartedAt?: string;
  taskCompletedAt?: string;
  taskDiffStat?: Session['taskDiffStat'];
  taskQueuePosition?: number;
  taskQueueDepth?: number;
  taskConcurrencyLimit?: number;
  updatedAt?: string;
}

taskTerminalReadLedger: TaskTerminalReadLedgerV1;
catalogOverlayRevision: number;
sessionCatalogOverlays: Record<string, SessionCatalogOverlay>;
~~~

初始化时只读一次 localStorage。所有更新先提交内存 ledger；persist 只是 best-effort 副作用。task projection 只保存已验证字段，不保存原始 event properties；写入 store 时转成完整 Session upsert overlay。

- [ ] **Step 5: 抽取 next-session projection 并复用 attention 判断**

在 taskListSlice.ts 中增加纯 helper applyTaskStatusProjection(session, projection)。task.status handler 先构造完整 next Session，再递增 revision 和写 exact-key upsert。non-terminal event 永不 unread，并原子推进该 exact ref baseline 为 null；未知 terminal event 使用 `acknowledgeTaskTerminal(ledger, ref, validatedState)` 静默建立 baseline 后继续 syncExactSession，该 sync 成功时也必须写 full-session upsert overlay；known non-terminal 或已有不同 acknowledged signature 的 terminal result 才 unread。只有 live path 播放 sound/Notification，catalog catch-up 不播放。

- [ ] **Step 6: 原子实现 acknowledge 与清理**

markTaskRead、clearUnreadTasks 和 removeSession 使用单次 Zustand updater 同时更新 unread 与 ledger；updater 后分别 best-effort persist。session.deleted/archive 写 remove tombstone，session.updated 和完成的 created/unarchived exact sync 写 full-session upsert。retryTask 与 deliverTask 保持调用 markTaskRead。clear 在 loading/hydrating/error/idle 都不改状态。

- [ ] **Step 7: 运行 GREEN 并提交**

~~~bash
cd packages/cli/web
bun x vitest run --config vitest.config.ts \
  tests/store/session/taskAttention.test.ts \
  tests/store/session/taskListSlice.test.ts \
  tests/store/session/sessionSlice.test.ts \
  tests/components/tasks/RecentTasksStrip.test.tsx \
  tests/components/tasks/TaskSwitcher.test.tsx
cd ../../..
bun run type-check:web
cd packages/cli
bun x biome check web/src/store/session/taskAttention.ts \
  web/src/store/session/types.ts \
  web/src/store/session/slices/taskListSlice.ts \
  web/src/store/session/slices/sessionSlice.ts \
  web/tests/store/session/taskAttention.test.ts \
  web/tests/store/session/taskListSlice.test.ts \
  web/tests/store/session/sessionSlice.test.ts
cd ../..
git diff --check
git add packages/cli/web/src/store/session/types.ts \
  packages/cli/web/src/store/session/slices/taskListSlice.ts \
  packages/cli/web/src/store/session/slices/sessionSlice.ts \
  packages/cli/web/tests/store/session/taskListSlice.test.ts \
  packages/cli/web/tests/store/session/sessionSlice.test.ts
git commit -m "fix(web): retain terminal task attention"
~~~

### Task 3: 用完整 catalog 与 live revision overlay 恢复 missed unread

**Files:**
- Modify: packages/cli/web/src/store/session/taskAttention.ts
- Modify: packages/cli/web/src/store/session/slices/sessionSlice.ts
- Modify: packages/cli/web/src/store/session/slices/taskListSlice.ts
- Modify: packages/cli/web/tests/store/session/taskAttention.test.ts
- Modify: packages/cli/web/tests/store/session/sessionSlice.test.ts
- Modify: packages/cli/web/tests/store/session/taskListSlice.test.ts

- [ ] **Step 1: 写 catalog reconcile 的因果 RED**

用顺序 mock 的 listSessionPage 做三轮完整 load：第一轮 exact ref 为 running，断言 ledger 建 null baseline 且不 unread；第二轮同 ref 为 completed 且 completedAt 非空，断言补 unread；调用 markTaskRead 后第三轮同 snapshot，断言 unread 不复活。另覆盖首次 terminal 静默 baseline、重复 snapshot 幂等、visible exact session 自动 acknowledge、完整 cursor exhaustion 后 prune、旧 generation 无权 reconcile。

在 taskAttention.test.ts 直接测试 `reconcileTaskAttention(...)` 的同一矩阵，保证首次 baseline、missed terminal、visible acknowledge、幂等与 compound identity 不依赖 Zustand 或 network mock。sessionSlice 只验证完整 accumulator、overlay 和一次原子 commit 的集成。

- [ ] **Step 2: 写两个 live/catalog 竞态 RED**

用 deferred page promises 和显式 microtask barrier 编排，不使用固定 sleep：一条让 terminal task.status 落在 page 1 与 page 2 之间；另一条让事件落在 final page resolve 后、final store commit 前。两条都断言 final Session 保留 live terminal projection、unread 只出现一次、ledger 不被旧 catalog 写回 null。再覆盖 hydration 期间 session.created/upsert 不被丢弃，以及 session.deleted/session.archived tombstone 不被旧 accumulator 复活。

- [ ] **Step 3: 实现 load-local accumulator 与 overlay**

loadSessions() 捕获 startRevision，以局部数组累积并按 exact SessionRef 去重所有页，直到 nextCursor 缺失。逐页 UI merge 和 final snapshot 都应用 revision > startRevision 的 sessionCatalogOverlays：upsert 替换/新增 exact Session，remove tombstone 删除 exact Session。winning generation 才能在一个同步 updater 中提交 merged sessions、reconciled unread、ledger、清理后的 overlays、ready 状态；旧 generation 在每个 await 后直接退出。final commit 丢弃 revision <= startRevision 的旧 overlay，但保留更新的 upsert/tombstone 给下一次完整 catalog 吸收。

- [ ] **Step 4: 运行 focused 与全 Web GREEN**

~~~bash
cd packages/cli/web
bun x vitest run --config vitest.config.ts \
  tests/store/session/taskAttention.test.ts \
  tests/store/session/taskListSlice.test.ts \
  tests/store/session/sessionSlice.test.ts \
  tests/App.test.tsx
cd ../../..
bun run test:web
bun run type-check:web
bun run lint:web
git diff --check
~~~

Expected: focused pagination/race/bootstrap/navigation tests 与全部 Web tests 通过。

- [ ] **Step 5: 提交 reconcile 切片**

~~~bash
git add packages/cli/web/src/store/session/slices/sessionSlice.ts \
  packages/cli/web/src/store/session/slices/taskListSlice.ts \
  packages/cli/web/src/store/session/taskAttention.ts \
  packages/cli/web/tests/store/session/sessionSlice.test.ts \
  packages/cli/web/tests/store/session/taskListSlice.test.ts \
  packages/cli/web/tests/store/session/taskAttention.test.ts
git commit -m "fix(web): recover missed task attention"
~~~

### Task 4: 建立 production Chromium + real DeepSeek 用户旅程

**Files:**
- Create: packages/cli/tests/support/durableTaskUnreadWebDriver.ts
- Create: packages/cli/tests/integration/real-api/durable-task-unread-trajectory.test.ts
- Modify: packages/cli/scripts/test-config.js
- Modify: packages/cli/tests/unit/scripts/qualification.test.ts

- [ ] **Step 1: 写 runner/registry contract RED**

新增测试约束 realApiQualification 包含 durable-task-unread trajectory，并且它调用 required DeepSeek matrix、生产 serve 与 Chromium availability gate。新增 typed evidence interface，字段固定为 model、frameworkRetries、modelMaxRetries、selectedBefore、backgroundTask、statusSequence、unreadAfterMissedCompletion、unreadAfterReload、titleCountAfterReload、selectedAfterClick、siblingUnreadPreserved、browserFaults、serverFaults、leakedSecrets、durationMs。

- [ ] **Step 2: 运行 RED**

~~~bash
cd packages/cli
bun x vitest run --config vitest.config.ts --project=unit \
  tests/unit/scripts/qualification.test.ts
~~~

Expected: 新 trajectory 尚未注册而失败。

- [ ] **Step 3: 实现 production browser driver**

复用 tests/integration/real-api/testConfig.ts 的 Flash/Pro model resolution 和临时 HOME config，启动 dist/blade.js serve --trust-workspace。用 Playwright Chromium 打开生产 Web；让 browser catalog 先观察 exact task B running 且 localStorage ledger 已有 null baseline，再通过关闭页面或受控断开全局 feed错过 terminal event。所有等待用 HTTP/SSE/DOM condition polling，不用固定 sleep。

- [ ] **Step 4: 断言完整 GUI 契约**

断言 Session A 未被抢焦点；catalog resync 后 B 在 RecentTasksStrip、Sidebar 或 TaskSwitcher 显示 unread；document.title 计数正确；第二次 reload 后 B 仍 unread；点击 B 后 URL/store 对应 exact compound ref、终态消息可见且仅 B 被清；跨项目同 ID sibling unread 保留。browser/server faults 与 secret scan 必须为空。

- [ ] **Step 5: 跑双模型真实资格并提交**

~~~bash
cd packages/cli
bun run build
REAL_API_TEST=1 \
REAL_API_RELEASE_MATRIX=1 \
DEEPSEEK_MODELS=deepseek-v4-flash,deepseek-v4-pro \
bun x vitest run --config vitest.config.ts --project=real-api --retry=0 \
  tests/integration/real-api/durable-task-unread-trajectory.test.ts
~~~

配置只能通过既有 ~/.blade/config.json helper 读取；framework retry 与 model maxRetries 均为 0，日志不得输出 credential。两模型通过后：

~~~bash
git add packages/cli/tests/support/durableTaskUnreadWebDriver.ts \
  packages/cli/tests/integration/real-api/durable-task-unread-trajectory.test.ts \
  packages/cli/scripts/test-config.js packages/cli/tests/unit/scripts/qualification.test.ts
git commit -m "test(web): qualify durable task unread recovery"
~~~

### Task 5: 双重复审、证据、全量门禁与独立发布

**Files:**
- Create: docs/testing/web-durable-task-unread-evidence.md
- Create: docs/en/testing/web-durable-task-unread-evidence.md
- Modify: CHANGELOG.md
- Modify: CHANGELOG.zh.md
- Modify: packages/cli/package.json

- [ ] **Step 1: 冻结候选并做双重复审**

规格 reviewer 核对首次 baseline、missed transition、read-no-revival、compound identity、pagination/live race 与 GUI 资格。质量 reviewer 检查 storage 限界、隐私、竞态、localStorage failure、重复通知和测试真实性。Critical/Important 必须归零。

- [ ] **Step 2: 写双语 evidence**

记录 RED/GREEN 命令与失败原因、最终源码 blob hash、review verdict、focused/full Web 结果、Flash/Pro 真实运行时间、production Chromium checkpoints、browser/server fault 摘要和边界。不得记录 credential、临时 HOME、私有绝对路径或模型原始输出。

- [ ] **Step 3: 运行发布候选全量门禁**

~~~bash
bun run format:check
bun run lint
bun run type-check
bun run build
bun run test:all
git diff --check
~~~

若 unchanged-source 出现间歇失败，先比较 blob hash 并精确重跑；报告使用“intermittent failures in unchanged sources”，不得把一次重跑通过说成根因修复。

- [ ] **Step 4: 准备下一个 patch release metadata**

查询 npm、git tag 与 packages/cli/package.json 后选择严格下一个 patch。只更新 CLI package version、CHANGELOG.md、CHANGELOG.zh.md 和双语 evidence；不得改 root package.json、bun.lock、docs/changelog.md 或 docs/en/changelog.md。

- [ ] **Step 5: 发布并核验**

先创建原子 release commit：

~~~bash
git add packages/cli/package.json CHANGELOG.md CHANGELOG.zh.md \
  docs/testing/web-durable-task-unread-evidence.md \
  docs/en/testing/web-durable-task-unread-evidence.md
git commit -m "chore: release v<version>"
~~~

再 push main，创建并 push annotated tag：

~~~bash
git push origin main
git tag -a v<version> -m "v<version>"
git push origin v<version>
~~~

等待 tag workflow 完成，然后核验 workflow success/headSha、npm version/gitHead/latest、GitHub Release、local HEAD、origin/main、tag peeled SHA 与 clean worktree一致。不得运行 release script 或手工 npm publish。
