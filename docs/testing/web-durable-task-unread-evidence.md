# Web 长任务 Durable Unread 恢复证据

- 日期：2026-09-04
- 目标版本：blade-code@0.10.131
- 基线：v0.10.130 / 4b62b083dbfa3999c38ee6dbffce12ee7df77b25
- 已验证代码候选：5a7133e5eaa6c4991f1363c3d80a38f02da5d3ff
- Framework retry：0
- Provider model retry：0

## 结果

Blade Web 现在为每个 exact compound SessionRef 持久化版本化的“已读终态指纹”。当浏览器 reload 或全局任务事件流断开时，完整 Session catalog 会与该指纹对账：已知 running 任务若在离线窗口进入 completed、failed 或 interrupted，Web 会恢复 unread，而不是因为错过 live task.status 就静默丢失提醒。

状态机同时保证：首次看到历史 terminal Session 时只建立基线；成功打开 exact Session 或 clear 后同一终态不复活；projectPath + sessionId 共同构成 identity；只有完整 cursor 的 winning generation 可 reconcile；分页期间的 task/session upsert 与 delete/archive tombstone 不被旧 catalog 回滚；catalog catch-up 不补播声音或系统通知；ledger 不保存 prompt、模型输出、failure message 或 status reason。

## TDD 证据

Task 1 首次观察到 13 个新 helper 契约因 API 缺失而失败，既有 3 个测试通过。自审又以两个独立 RED 发现并闭合 1,025 条相同 snapshot 的 MRU 轮转，以及容量已满时新 terminal baseline 被淘汰。最终纯函数测试 17/17 通过。

Task 2 观察到 12 个因果失败：missing-ledger baseline、unknown terminal、non-terminal → null、terminal-to-terminal 新 completedAt/failure code、visible acknowledge、mark/clear、remove/delete/archive exact ledger 与 overlay。规格复审再增加一条因果 RED，证明级联 archive 中未加载子 Session 会遗留 unread/ledger；修复后由 ref.projectPath + archivedSessionIds 构造全部 exact keys。

~~~text
Task 2 focused: 5 files passed, 183 tests passed
~~~

Task 3 观察到 9 个因果 catalog 失败：三轮 running → missed terminal → read-no-revival、首次 terminal 静默基线、cursor exhaust、旧 generation、两个 live task.status 竞态窗口、created/updated upsert、deleted tombstone、archived tombstone。两个初版 fake-timer timeout 属于测试夹具问题，已在 production 修改前改为 deferred/microtask 编排。

~~~text
Task 3 focused: 4 files passed, 193 tests passed
Full Web:       66 files passed, 632 tests passed
~~~

## Production Chromium 与真实 API

~~~bash
cd packages/cli
bun run build
REAL_API_TEST=1 REAL_API_RELEASE_MATRIX=1 \
DEEPSEEK_MODELS=deepseek-v4-flash,deepseek-v4-pro \
bun x vitest run --config vitest.config.ts --project=real-api --retry=0 \
  tests/integration/real-api/durable-task-unread-trajectory.test.ts
~~~

~~~text
Tests  2 passed | 1 skipped gate placeholder
Total  29.55s
~~~

| 模型 | 测试时长 | Driver 时长 | 上游请求 | 注入响应 | Retry |
| --- | ---: | ---: | ---: | ---: | ---: |
| deepseek-v4-flash | 14.203s | 14,046ms | 1 | 0 | 0 |
| deepseek-v4-pro | 13.564s | 13,404ms | 1 | 0 | 0 |

两个模型均走真实 Provider 上游。recording proxy 只 hold 后透传首个请求，不生成或替换响应。两条轨迹均证明：running → completed；浏览器先持久化 B 的 null baseline，再关闭页面错过 terminal event；新 Chromium context 从完整 catalog 恢复 B unread，同时 sibling unread 保留且 title count 为 2；再次 reload 后状态不丢；TaskSwitcher DOM 显示 B 的 New；点击 B 后进入 exact compound SessionRef，terminal content 与 completed 状态可见，只清 B；browserFaults、serverFaults、leakedSecrets 均为空。

初次真实矩阵中，两模型都真实完成，但 macOS 默认临时目录中的连字符路径无法被既有 Session 存储路径编码稳定 round-trip，导致测试 catalog 为空。资格 fixture 改用隔离且无连字符的 /tmp 根后通过。本 patch 不宣称修复该独立 path-codec 行为。

## 全仓门禁

~~~text
format:check  PASS — 1554 files
lint          PASS — CLI 1352 files, Web 200 files, VSCode PASS
type-check    PASS — CLI, Web, VSCode
build         PASS
main tests    474 files passed, 95 skipped
              5482 passed, 85 skipped, 362.63s
performance   4 files passed, 1 skipped
              9 passed, 1 skipped, 6.32s
git diff      PASS
~~~

Build 只有既有 Browserslist stale-data 与大于 500 KiB chunk warning。

## 最终审查

最终候选 5a7133e5eaa6c4991f1363c3d80a38f02da5d3ff：

- 最终规格审计：APPROVED，Critical 0 / Important 0 / Minor 0；
- 最终质量、安全与并发审计：APPROVED，Critical 0 / Important 0；
- Task 4 production Chromium 规格复审：APPROVED，15 项全部覆盖；
- Task 4 proxy/process/redaction/flake 质量复审：APPROVED。

质量审计仅记录一个非阻断 Minor：旧 pruneUnreadTaskKeys 可在过滤前额外 dedupe；ledger 读取和 unread 写入已 dedupe，不影响本 patch 正确性。

## 最终源码哈希

~~~text
taskAttention.ts                         47ace1a1472ec33eadac9ff427fbd602410ac30e93f33963742f1688cff98bfa
types.ts                                 0931b10f222b7810020583973fca404f42f7020228d3cbab312fbfe32789c28f
taskListSlice.ts                         86f84e4811a04efc62df588118a7c24e9b86d2143f1b4964e4b17abc49a1d049
sessionSlice.ts                          ae29af2080663251c663d7b3d1758b9c09e03908bbef5b354e14dfc152c99201
durableTaskUnreadWebDriver.ts            b49f82155d43af0501ea06b982caa18b9206798a06267ab20dd4eb1b9dca723e
durable-task-unread-trajectory.test.ts   ded024a6e822be43c28ec2a0bb2277f0aeb4704baeee60248b8f83d19281421b
taskAttention.test.ts                    84a0f9ebd7e9b51edaf9a9fd6cd75c28f2c612ba41dd4004873b7e9f53578d88
taskListSlice.test.ts                    69ffcd1c768264dcbba8fb79dadbc895538c90d33274f84a42a27be55d18b3dd
sessionSlice.test.ts                     f3bd23d3ce80173c201d3131fb7121e0ab1abf39a6bbbe236fd635c3ab2385d0
~~~

## 边界

- 没有输出、保存或提交 Provider credential 或真实模型原始输出。
- screenshot 不是成功依据；DOM、title、exact URL/SessionRef、catalog、localStorage、真实 Provider 请求与 fault/leak 断言共同确定结果。
- 普通 test:all 会跳过付费真实 API 单元格；真实 Flash/Pro 资格由上面的 release-matrix 命令单独执行。

