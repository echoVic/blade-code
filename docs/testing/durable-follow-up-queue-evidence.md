# Durable Follow-up Queue 资格验证证据

- 日期：2026-09-05
- 目标版本：blade-code@0.10.134
- 基线：v0.10.133
- Framework retry：0
- Provider model retry：0

## 覆盖结论

实现以 durable inbox V2 为唯一队列事实源，并把同一个 versioned snapshot 投影到
Runtime、HTTP/SSE、TUI、Web 与 ACP。Web GUI 和 TUI 都提供可见的顺序、锁定状态、删除
与重排控制；ACP 仅接收五个 counts-only 字段，不声明 mutation capability。

确定性测试覆盖：

- v1→v2 迁移、跨实例并发 enqueue、原子 replace 和锁失败；
- stale version、claim/mutation race、acknowledgement 与 owner restart；
- 160 条 item 上限、preview 上限、artifact、output schema 与 immutable barrier；
- HTTP exact Session identity、archive、history-only、TypeBox 校验和 SSE reconnect；
- Web keyboard/drag controls、mutation pending、stale refresh 与 focus restore；
- TUI `/queue` 快捷键、活动回合可用性、owner fencing 与 transcript promotion；
- ACP 初始、pending、locked、empty、reload 投影，以及 metadata 隐私扫描。

## Production raw PTY

~~~bash
bun run build:cli
cd packages/cli
bunx vitest run --config vitest.config.ts --project=integration \
  tests/integration/follow-up-queue-pty.test.ts
~~~

~~~text
Test Files  1 passed
Tests       1 passed
~~~

该轨迹启动 production `dist/blade.js` 和真实 `bun-pty`，用本地确定性流式 Provider
保持首个回合，在 TUI 中依次提交 A、B、C，打开 `/queue`，把 C 移到 B 前并删除 B。
随后 resize、关闭并重开面板，释放 Provider，并从第二个上游请求确认仅消费 A、C，且各
出现一次。runner 输出有界，退出时执行 `TERM → KILL`。

## Flash / Pro 三表面真实 API

~~~bash
cd packages/cli
REAL_API_TEST=1 REAL_API_RELEASE_MATRIX=1 \
DEEPSEEK_MODELS=deepseek-v4-flash,deepseek-v4-pro \
bunx vitest run --config vitest.config.ts --project=real-api --retry=0 \
  tests/integration/real-api/follow-up-queue-trajectory.test.ts
~~~

~~~text
Test Files  1 passed
Tests       6 passed | 1 skipped gate placeholder
Duration    95.36s
Models      deepseek-v4-flash, deepseek-v4-pro
Surfaces    Web, TUI, ACP
~~~

每条轨迹都设置 `overrides.maxRetries=0` 并断言 framework retry 为 0。透明 proxy 不
生成或替换响应，每条表面轨迹记录 2 个上游请求：1 个初始请求和 1 个 queue-consumption
请求。Web/TUI 证明 A→C 的 mutation 后顺序、B 不出现且无重复；ACP 证明 A→C 的 durable
应用顺序以及 `pending → locked → empty` metadata 生命周期。

六条轨迹的 `cleanupComplete` 均为 true，browser/server fault 为空，credential scan 为空。
ACP runner 通过真实 SDK stdio child 执行，验证不声明 mutation capability、只发送五字段
metadata、reload 后再次投影，并以 `session/close` 和 stdin EOF 正常退出。

## 发布门禁

以下结果须在版本提交前从干净 production build 重新记录：

~~~text
format:check  PENDING
lint          PENDING
type-check    PASS — CLI focused; final root gate pending
build         PASS — production CLI/Web
test:all      PENDING
coverage      PENDING
git diff      PASS
~~~

本页不会记录 Provider credential、原始响应或完整 request body。最终 evidence 只保留模型、
表面、请求数量、retry budget、marker 顺序、删除缺失、清理与 secret-scan 结果。
