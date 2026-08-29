# Raw PTY Composer-Ready Handshake Release Evidence

## 2026-08-29 资格验证（`blade-code@0.10.116`）

- 实现提交：`4bd61033180e70a89c6b58b14858828b19d7fa46`
- 目标：消除 raw PTY runner 在 TUI 输入 handler 注册前发送大段 bracketed paste
  的竞态。

### 修复后的握手合约

- 测试进程为每个 PTY child 生成独立的 32 位小写十六进制 nonce，并通过
  `BLADE_TUI_COMPOSER_READY_NONCE` 传入。
- 主 composer 的 active input handler 注册完成后，才输出精确的
  `ESC]99;blade-composer-ready=<nonce>BEL` OSC marker。
- 未设置或设置了 malformed nonce 时不输出 marker，避免环境变量注入任意终端
  控制序列。
- 10 个会发送 prompt 的 raw PTY runner 必须先观察各自 child 的 exact marker，
  再发送 bracketed paste；paste 后的 acknowledgement 和既有 final-marker 合约
  保持不变。
- token-budget runner 不再把 bracketed-paste mode 出现五秒当作 composer ready，
  并在 rolling scan 中保留完整 readiness marker，避免跨 PTY chunk 漏检。

### TDD 与审查披露

- 初始 RED 分别证明 production marker module、shared handshake helper 和
  registration callback 尚不存在。
- 实现后的首次直接 focused 运行是 63 通过、1 失败；失败来自 readiness
  component test 没有使用 production 的 `TerminalInputRouterProvider` 拓扑，而非
  runtime 通过。修正测试夹具并补齐 absent/malformed/valid nonce 覆盖后，测试为
  71/71 通过。
- 首轮独立规格审查发现 1 个 Important：token-budget rolling scan 没有把
  readiness marker 长度纳入 retained tail；同时发现 1 个 Minor：runner
  source-contract 没有锁定 marker wait 与 paste 的先后顺序。两项均先补 RED
  断言，再最小修复。
- 最终 focused unit：3 个文件、80/80 通过。
- 独立规格复审与独立代码质量终审最终均无发现。
- TypeScript type check、Biome（1,292 个文件）、`git diff --check` 以及完整
  CLI、Web、VSCode build 全部退出 0。build 仅输出既有 Browserslist 数据和
  bundle-size 警告。
- 最终 release tree 的 `bun run build && bun run test:all`：非性能 446 个
  文件通过、91 个文件跳过，4,574 个测试通过、85 个跳过；性能 4 个文件
  通过、1 个跳过，9 个测试通过、1 个跳过；0 失败。

### 真实 Provider raw PTY 结果

命令：

```bash
REAL_API_TEST=1 REAL_API_RELEASE_MATRIX=0 bun x vitest run \
  --config vitest.config.ts --project=real-api \
  tests/integration/real-api/token-budget-handoff-trajectory.test.ts \
  tests/integration/real-api/large-prompt-offload-trajectory.test.ts \
  --retry=0 --maxWorkers=1 --no-file-parallelism \
  -t 'deepseek:deepseek-v4-(flash|pro):pty'
```

| 轨迹 | 模型 | 时长 | 结果 |
| --- | --- | ---: | --- |
| Large-prompt offload | DeepSeek V4 Flash | 125.614s | 通过 |
| Large-prompt offload | DeepSeek V4 Pro | 124.859s | 通过 |
| Token-budget handoff | DeepSeek V4 Flash | 22.100s | 通过 |
| Token-budget handoff | DeepSeek V4 Pro | 41.796s | 通过 |

最终结果为 2 个文件通过、4 个目标 cell 通过、12 个非目标 cell 因测试名
过滤而跳过，退出码 0。四个目标 cell 都在首次执行中通过，framework retry 为
0；未发生旧的 `paste:stage_failed`。证据和命令输出均未记录 Provider credential。

### 发布边界

`0.10.116` tag 只在上述实现提交之后加入本 evidence、英文 evidence、双语
changelog 和 package version；不得混入 ACP recovered-metadata egress 竞态修复。
