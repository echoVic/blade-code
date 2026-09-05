# Provider 429 共享冷却资格验证证据

- 日期：2026-09-05
- 目标版本：`blade-code@0.10.139`
- 设计起点：`62a062e1`
- 真实 API 实现基线：`27a6accc`
- 最终 release HEAD：`df2ff5c9db9b5992e63f0a1257e3f7d71092608f`
- 测试对象：首个权威 `429 + Retry-After`、相同 failure domain 跨 Session 抑制、唯一 HalfOpen probe、TUI/Web/ACP/Headless 投影

## 确定性生产表面验证

`provider-rate-limit-cooldown.test.ts` 从当前 production `dist` 启动真实 Headless、
ACP stdio、raw PTY TUI 与 Chromium Web。它使用本地 HTTP Provider fixture，只在首个
请求返回带私有 body 的 `429` 和 `Retry-After-Ms: 5000`，随后返回确定性 Bash tool
call 与最终 marker。

验证结果：连续运行三次，每次 `4/4` passed，共 `12/12`。覆盖：

- 首次 429 以一个失败样本立即进入 `opened -> waiting`；
- 冷却期间第二个同 domain Session 不产生额外物理请求；
- 到期时全进程只发放一个 `probe`，成功后进入 `closed`；
- Headless JSONL 包含 `provider_circuit`、`provider_recovery`、`turn_activity` 及终态 clear；
- ACP metadata revision 单调，投影 `blade/providerRecovery` 与 `blade/turnActivity`；
- raw PTY 直接看到 `Provider 请求受限，等待恢复探测`、probe、Bash 活动和 composer 恢复；
- Web reload 后恢复限流 banner，随后恢复工具活动 strip，并在终态清除两者；
- API key 与私有 429 response body 不进入 JSONL、ACP、PTY、DOM、SSE 或 transcript。

## 真实 Provider 矩阵

命令：

```bash
REAL_API_TEST=1 REAL_API_RELEASE_MATRIX=1 bunx vitest run \
  --config vitest.config.ts --project=real-api \
  tests/integration/real-api/provider-rate-limit-cooldown-trajectory.test.ts
```

最终显式运行使用 framework retry `0`，结果为 `8/8` passed，115.11s：

| 模型 | Headless | ACP stdio | raw PTY TUI | Chromium Web |
| --- | ---: | ---: | ---: | ---: |
| `deepseek-v4-flash` | 8.917s | 10.070s | 10.317s | 15.363s |
| `deepseek-v4-pro` | 12.629s | 16.060s | 15.107s | 25.349s |

每个 cell 都由本地代理注入一次 `429 + Retry-After-Ms: 2000`，之后才转发到真实
DeepSeek。Headless 与 PTY 验证单 Session 恢复；ACP 与 Web 还在冷却期启动第二个同域
Session，验证零提前上游请求、唯一 probe、两个 Session 最终完成。所有轨迹都要求精确
Edit、精确 Bash 验证、最终 marker、文件 diff 范围及无 secret/private-body 泄漏。

开发期第一次矩阵运行中，ACP 与 PTY 已通过；Headless 和 Web 仍保留了旧四次 503
轨迹的 attempt 断言。修正为首个 429 的 `attempt=1` 与 circuit-first recovery 投影后，
在 release 模式关闭框架重跑，完整八格一次通过。

## 最终门禁

在实现与文档 HEAD `d28fdcd28085b1940b87101200f0ebd29565dc50` 上取得：

- `bun run build`、`bun run type-check`、`bun run lint`：passed；CLI lint 检查
  1,403 个文件，Web lint 检查 208 个文件；
- `bun run test:all`：passed；非 performance 阶段 495 files passed、99 skipped，
  5,767 tests passed、88 skipped；performance 阶段 4 files passed、1 skipped，9 tests
  passed、1 skipped；总耗时 439.50s；
- `bun run test:coverage`：passed；495 files / 5,767 tests passed，99 files / 88
  tests skipped；statements 73.79%、branches 67.19%、functions 75.65%、lines 75.16%；
- `bun run test:web`：passed；69 files、663 tests。

上述版本元数据冻结在 `df2ff5c9db9b5992e63f0a1257e3f7d71092608f`；tag 前再次
运行 `bun run build && bun run test:all`，结果将在下方追加。
