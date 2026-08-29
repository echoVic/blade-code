# Durable Subagent Result Adoption Release Evidence

## 2026-08-29 重新验证（`blade-code@0.10.115`）

- Runtime commit：`e3018acd91a61755ab607887843c1f86114bc121`
- 完整命令：`bun run qualify:production`（清除 Trae 注入的 Git hook 环境后执行）
- 完整日志 SHA-256：`9176098ef528bbe47071295604bcfe8ff84f25729a91de60fd4b573a06946dbf`
- pre-amend 完整日志 SHA-256：`1feec045fab1302ed30d279831ebb04016461a2911d44d9f26d3cdedce5ee41f`
- 33 文件 progressive-skip 日志 SHA-256：`98ac9e89e5aa1b50bba0ee3035e273c47c1bd21e0cf15af697f9ea8a20d9983a`

### 修复后的恢复合约

- `turn_aborted.recovery` v3 持久化 `allSuccessfulToolResultsSafeForResume`。
- 只有全部成功结果都来自 host 校验过的 foreground `Task` adoption，且没有
  interrupted tool call 时，恢复才可自动继续。
- 普通成功工具、mixed result、任何 interrupted tool、legacy v1/v2 receipt，
  以及 malformed/unsafe adoption 仍要求显式人工处理。
- malformed v3 safe-proof 降级为 `false` 并保留 recovery 证据；同一损坏
  receipt 中的 embedded acknowledgement 不受信任。
- safe-proof 会跨第二次 abort/restart 保留；ACP completion inspector 同时接受
  合法 v2/v3 failed-attempt receipt，并继续拒绝 v1。

### 确定性与跨 surface 结果

- Focused unit：9 个文件，409/409 通过。
- Type check、Biome、`git diff --check`、production build：全部通过。
- 最终 release tree 的 `bun run build && bun run test:all`：非性能 446 个
  文件、4,554 通过、85 跳过；性能 9 通过、1 跳过；0 失败。
- 两位独立审查者分别检查规格/安全语义和代码质量/兼容性，最终均无发现。

| 模型 | Surface | 时长 | 结果 |
| --- | --- | ---: | --- |
| DeepSeek V4 Flash | Headless bare resume | 2.592s | 通过 |
| DeepSeek V4 Flash | ACP `session/load` | 2.373s | 通过 |
| DeepSeek V4 Flash | raw PTY TUI | 11.117s | 通过 |
| DeepSeek V4 Flash | production Chromium Web GUI | 8.722s | 通过 |
| DeepSeek V4 Pro | Headless bare resume | 4.335s | 通过 |
| DeepSeek V4 Pro | ACP `session/load` | 2.621s | 通过 |
| DeepSeek V4 Pro | raw PTY TUI | 11.631s | 通过 |
| DeepSeek V4 Pro | production Chromium Web GUI | 10.178s | 通过 |

这 8 个 cell 在两轮完整 production qualification 中都以 framework retry=0
首次通过，并验证恢复请求包含 child-only marker、没有创建第二个 child Session、
原 child sidecar 和 lineage 未变化、四个 surface 都消费同一 canonical parent JSONL，
且证据中不含 Provider credential。

### 完整门与未改源码失败披露

第二轮完整 production qualification 的 15 个本地/浏览器门全部通过：

- Unit：395 个文件，4,233 通过、1 跳过；
- Integration：38 个文件，193/193 通过；
- CLI：3 个文件，9/9 通过；
- Headless core：9 个文件，394/394 通过；
- E2E：2 个文件，14/14 通过；
- Snapshot：1 个文件，9/9 通过；
- Security：4 个文件，40/40 通过；
- Web：65 个文件，509/509 通过；
- Performance：9 通过、1 跳过；
- build 与 Chromium preflight：通过。

最终 runtime commit 上的 release-blocking real API 完整执行为 207 通过、7 跳过、
5 失败。adoption 轨迹没有失败；其中 4 个失败位于本 patch 未修改的文件，
另 1 个是 shared ACP runner 在 durable completion 后立即检查异步 metadata 的时序
失败。同一 commit 上使用 `--retry=0` 逐项复验结果如下：

- production ACP pending-resume：38.260s 通过；
- GPT rich-media compaction：12.648s 通过；
- Web side conversation：19.036s 通过；
- DeepSeek Flash token-budget raw PTY：20.322s 通过；
- Claude -> GPT cross-provider fallback：完整门先触发一次 GPT 30s request
  deadline，首次隔离复验再次触发同一 deadline，冷却后的第二次隔离复验
  8.865s 通过。

排除上述 5 个已逐项复验文件后，剩余 33 个 release-blocking 文件在
`--retry=0` 下整体通过：133 通过、4 跳过、0 失败，耗时 2624.33s。

另外，pre-amend 完整门为 211 通过、7 跳过、1 失败：
`provider-retry-trajectory` 仍断言 v2 receipt。测试更新为 v3 并显式要求
`allSuccessfulToolResultsSafeForResume=false` 后，精确真实 API 复验 4.691s
通过，最终 runtime commit 上的完整门也通过该 cell。上述间歇性失败均按原始
结果保留，未改写为完整 qualification 全绿。

### 发布边界

`0.10.115` tag 仅可在上述 runtime commit 之后加入本 evidence、英文 evidence、
双语 changelog 和 package version；不得再改变 runtime、测试或构建输入。

---

- Date: 2026-08-14
- Version: `blade-code@0.10.31`
- Qualified commit: `f8034e25bcda55e69a382c0566f2399195ded091`
- Command: `bun run qualify:production`

## Result

Production qualification passed all 16 checks.

- Unit: 2,869 passed, 1 skipped
- Integration: 160 passed
- Web: 407 passed
- Performance: 7 passed, 1 skipped
- Chromium preflight: passed
- Release-blocking real API: 59 passed across 14 files

The built CLI and `packages/cli/package.json` both reported `0.10.31`.
A supplemental unchanged-source integration run also passed all 160 tests across
30 files in 67.58s.

## Result Adoption Matrix

Every cell started from the same cross-store commit-gap fixture:

1. a foreground Task child completed through a real Provider and persisted a
   model-authored marker that did not exist in the parent input;
2. the child Session sidecar contained the terminal result and immutable lineage;
3. the parent Session retained an active turn, durable inbox item, and orphan
   Task call;
4. the parent had not committed the Task result, terminal subtask reference,
   turn abort, inbox acknowledgement, or final assistant response.

| Model | Surface | Duration | Result |
| --- | --- | ---: | --- |
| DeepSeek V4 Flash | Headless bare resume | 2.702s | passed |
| DeepSeek V4 Flash | ACP `session/load` | 3.072s | passed |
| DeepSeek V4 Flash | raw PTY TUI | 12.528s | passed |
| DeepSeek V4 Flash | production Chromium Web GUI + reload | 10.401s | passed |
| DeepSeek V4 Pro | Headless bare resume | 3.460s | passed |
| DeepSeek V4 Pro | ACP `session/load` | 3.220s | passed |
| DeepSeek V4 Pro | raw PTY TUI | 12.223s | passed |
| DeepSeek V4 Pro | production Chromium Web GUI + reload | 13.935s | passed |

All eight cells passed without a test retry and proved:

- adoption required the exact compound owner, child Session ID, description,
  explicit subagent type, resume lineage, terminal status, and bounded result;
- recovery atomically committed one canonical Task result, one terminal
  `subtask_ref`, and one parent `turn_aborted(process_restart)`;
- the adopted result used `subagentResultAdopted=true` and
  `sideEffectsUncertain=false`;
- the resumed Provider request contained the child-only marker;
- the parent produced one final assistant response and acknowledged its durable
  inbox item once;
- the child sidecar bytes, child count, child Session ID, and lineage remained
  unchanged, proving the Task was not executed again;
- Headless, ACP, raw PTY TUI, and Web consumed the standard result and lifecycle
  events instead of reconstructing surface-specific state;
- Web exposed the same durable child Session identity, terminal status, and
  bounded result summary both live and after a fresh reload;
- Provider credentials were absent from JSONL output, ACP updates, PTY evidence,
  browser DOM, and captured diagnostics;
- owned PTY, browser, server, port, proxy, temporary root, and process resources
  were reclaimed.

## Deterministic Coverage

The full unit and Web suites cover:

- exact owner, child identity, description, type, lineage, status, and result
  admission checks;
- conservative `sideEffectsUncertain=true` fallback for every mismatch;
- atomic result/subtask/abort persistence and idempotent restart behavior;
- shared normal-completion and restart-adoption Task result construction;
- successful and failed child projection as one `tool_result` followed by one
  `subagent_completed`;
- one-shot startup projection before the next Provider request;
- bounded TUI Task detail;
- Web live-card update, fresh-load aggregation, and durable child Session
  selectors.

## Retry Disclosure

The first full production qualification attempt stopped at 57 of 59
release-blocking real-API tests after both the leaderless foreground-group launch
trajectory and the existing GPT ACP durable-interaction trajectory exhausted
their configured retry. Each passed in an isolated unchanged-source rerun.

The final full production qualification passed all 16 checks and all 59
release-blocking real-API tests. Its existing GPT ACP durable-interaction case
timed out on the first configured attempt and passed on retry. The new
completed-subagent adoption eight-cell matrix passed without retry.

## Release Boundary

The release tag may include an evidence-only commit after the qualified commit.
No runtime, test, package, lockfile, documentation other than this evidence file,
or build input may differ from
`f8034e25bcda55e69a382c0566f2399195ded091`.
