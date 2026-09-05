# 当前回合活动状态资格验证证据

- 日期：2026-09-05
- 目标版本：`blade-code@0.10.138`
- 实现与真实 API 资格基线：`3ec02e87b17b61d081eefec27544adf1b35eb33f`
- 真实 API 命令：`REAL_API_TEST=1 REAL_API_RELEASE_MATRIX=1 bunx vitest run --config vitest.config.ts --project=real-api tests/integration/real-api/turn-activity-surface-trajectory.test.ts`
- 确定性表面命令：`bunx vitest run --config vitest.config.ts --project=integration tests/integration/turn-activity-surfaces.test.ts`

## 结果

当前回合活动已由 Runtime 统一拥有，并从同一 generation/revision 投影到 Headless、真实 ACP stdio、raw PTY TUI 与 production Chromium Web。

| 模型 | Headless | ACP | raw PTY TUI | production Web |
| --- | ---: | ---: | ---: | ---: |
| `deepseek-v4-flash` | 7.897s | 7.245s | 8.896s | 12.352s |
| `deepseek-v4-pro` | 8.384s | 9.064s | 10.473s | 14.953s |

真实 API 矩阵 `8/8` passed，总耗时 80.42s。每格都关闭 Vitest retry 与模型 retry，恰好发出两个真实 Provider 请求：第一轮产生一个 Bash tool call，第二轮返回精确 marker。

确定性 production TUI/Web 轨迹连续运行三次，每次 `2/2` passed。Web 在工具仍被 barrier 阻塞时 reload，并从 SSE connected frame 恢复 `executing_tools` 与 Bash；工具结束后 activity strip 消失。raw PTY 直接观察到 thinking、Bash active、工具/回合计数、耗时与终态 composer 恢复。

## 契约覆盖

- Runtime generation/revision fence、并行工具、8 项上限、数值进度、compaction、continuation、显式 clear 与非有限 turn limit；
- TUI 与 Web 的阶段、工具、计数、耗时和 specialized-state precedence；
- Web revision-0 anchor、reconnect 权威 hydration、终态/导航清理，以及 assistant message 开始时不丢 generation；
- ACP 初始/live `blade/turnActivity`、相同 revision 去重与 terminal clear；
- Headless JSONL 封闭 `turn_activity` schema 与 terminal clear；
- 工具参数、命令、输出、路径、prompt、error、URL、progress message 和 API key 不进入公开 activity。

## 门禁记录

- `bun run build && bun run type-check && bun run lint`：passed；CLI lint 1401 files，Web lint 208 files；
- 首次 `bun run test:all`：5749 passed、88 skipped、2 failed。`raw-pty-marker-latching.test.ts` 因新增 runner 未登记而确定性失败，已补齐 inventory；未修改源码的 `remote-workspace-reference.test.ts` 跨进程容量用例单独复跑通过。
- 最终 release candidate 的 `test:all`、coverage 与版本/tag 门禁必须在文档和版本元数据冻结后重新运行，最终结果以 release commit 为准。

## 清理与隐私

所有轨迹使用随机临时根、端口和 Session ID。Provider proxy、SSE reader、browser/page、ACP connection、PTY、server 和临时目录均在 `finally` 中关闭。runner 子环境移除无关 credential 变量，只向 Blade 子进程注入该格所需密钥；断言扫描 JSONL、ACP update、PTY 投影、DOM/server output 与 transcript，未发现密钥。
