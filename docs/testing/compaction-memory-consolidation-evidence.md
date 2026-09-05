# Compaction 项目记忆资格验证证据

- 日期：2026-09-06
- 目标版本：`blade-code@0.10.140`
- 实现与真实 API 资格基线：`79c1d5c64addc85b5dd0dbac16a37017871421a8`
- 确定性命令：`bunx vitest run --config vitest.config.ts --project=integration tests/integration/compaction-memory-consolidation.test.ts`
- 真实 API 命令：`REAL_API_TEST=1 REAL_API_RELEASE_MATRIX=1 bunx vitest run --config vitest.config.ts --project=real-api tests/integration/real-api/compaction-memory-consolidation-trajectory.test.ts`

## 结果

full compaction 现在会从确定被移出模型上下文的可见消息中生成有界、内容不外泄的
项目记忆计划。replacement checkpoint 先提交；只有提交成功后才写入 memory；记忆写入
失败不会破坏已经成功的 compaction，也不会中断任务。该流程不增加 Provider 请求。

确定性 production 测试连续运行三次，每轮 Headless、真实 ACP stdio、raw PTY TUI 与
Chromium Web `4/4` 通过，总计 `12/12` surface executions。每格都注入一次
`context_length_exceeded`，验证 compaction start、durable checkpoint、`written` 投影、
最终响应、精确去重、`MEMORY.md` topic link、新 Session 索引加载及敏感候选拒绝。

真实 API 使用 `deepseek-v4-flash` 和 `deepseek-v4-pro`，在四个 production surface 上
完成 `8/8` 矩阵；最终 release-runner 命令中 Vitest 耗时 120.73 秒，含 production
build 的总耗时 126.18 秒。模型与 framework retry 均为 0；每格经 loopback proxy
注入一次 context-limit，再将 compaction、继续响应和新 Session 发现请求转发到真实
DeepSeek。全部格子都产生一个可发现的 `conventions.md` 条目并完成精确 final marker。

## 覆盖的关键契约

- 仅从用户显式 `remember`/`convention`/`lesson` 和助手已解决问题文本中提取；不读取
  tool output、tool args、reasoning、metadata 或图片 URL；
- 单条 500、最多 20 条、总计 8,000 Unicode code points；
- credential label、Bearer、`sk-*`、AWS access key 和 PEM private key fail closed；
- 进程内与跨进程锁、原子写、`0600` 权限、规范化精确去重、受管索引区块；
- threshold、context-limit、turn-limit 和 manual `/compact` 都遵循
  `checkpoint -> memory -> replacement`；remote ACP workspace 不写宿主项目记忆；
- TUI、Web、ACP、Headless 只投影 outcome/count/topic，不携带内容、路径或存储错误；
- Web reload 不重建瞬态成功提示，后续 Session/run/终态会清理提示；
- durable SSE replay 过滤 hidden message 和非工具 part，避免内部内容绕过公开边界；
- raw PTY 直接验证压缩状态、`Project Memory` 完成消息、精确持久化 final marker 和下一
  Session 的 memory index 加载。

## 测试中发现并修复的问题

1. TUI `MessageArea` 会在每次 history 更新时重建 streaming tool baseline，导致在流式
   回合中较晚加入的 `Project Memory` 完成消息被误判为旧消息而不显示。现在 baseline
   只在 streaming generation 或显式 clear 边界重建。
2. Web Session SSE 的 durable replay 原样发送 `clientVisible:false` 的消息及其 text part。
   现在 live 与 replay 都经同一投影器过滤 hidden message，并拒绝 text、reasoning、image
   与 summary part；tool call/result 仍使用原有安全投影。

## 隐私与清理

测试使用随机临时 HOME、`BLADE_STORAGE_ROOT`、workspace、Session ID 和 loopback 端口。
fixture secret 不写入版本库；真实 API 凭据只从受限本地配置读取。断言扫描公开 JSONL、
ACP updates、PTY 输出、Web SSE、DOM、server output 和记忆文件。Provider proxy、SSE reader、
browser/page、ACP connection、PTY、server 与临时目录均在有界 teardown 中关闭。

## 发布门禁

~~~text
type-check    PASS — CLI 与 Web
lint          PASS — CLI 1,411 files；Web 208 files
web test      PASS — 69 files；665 tests
build         PASS — production CLI 与 Web
test:all      PASS — 497 files passed，100 skipped；5,813 tests passed，88 skipped
performance   PASS — 4 files passed，1 skipped；9 tests passed，1 skipped
coverage      PASS — 497 files passed，100 skipped；5,813 tests passed，88 skipped
                statements 73.88%，branches 67.24%，functions 75.72%，lines 75.25%
real API      PASS — Flash/Pro × Headless/ACP/raw PTY/Web，8/8
git diff      PASS
~~~

最终 `test:all` 主阶段 444.30 秒，performance 5.58 秒，总耗时 455.46 秒。coverage
耗时 481.73 秒。最终 release-runner 真实 API 矩阵的单格耗时分别为 Flash
12.804/12.117/12.734/9.785 秒与 Pro 20.688/15.770/21.631/13.669 秒，顺序均为
Headless/ACP/raw PTY/Web。

首次 `test:all` 暴露三个问题：新增 PTY runner 未进入 inventory、runner 进程内环境未
切换到临时 storage root，以及未修改的 Chromium cross-origin 用例偶发先命中 stale
snapshot。前两项已修复并由后续全量门禁覆盖；Chromium 用例在源码不变时精确复跑通过。
首次尝试计划中的带文件参数 release-runner 命令时，旧 runner 忽略该参数并误跑全部
45 个历史真实 API 文件，在高并发资源压力下产生 16 个既有 Web/进程轨迹失败；新增
runner 参数契约后，同一命令只选择目标 trajectory，并以 8/8、exit 0 完成。

## 完成审计

| 要求 | 可复核实现或证据 | 结论 |
| --- | --- | --- |
| checkpoint-first | `CompactionService` 仅规划；Runtime/`/compact` 在 checkpoint 后写入 | PASS |
| 失败隔离 | checkpoint 失败不写；memory 失败仍继续 replacement | PASS |
| 提取与上限 | 固定 marker/topic、20 条、单条 500、总计 8,000 code points | PASS |
| 安全 | 共享 credential classifier；不读取 tool/reasoning/metadata/image | PASS |
| 并发与持久化 | keyed mutex、file lock、atomic write、0600、精确去重 | PASS |
| 工作区隔离 | 本地 workspace 独立；remote ACP host write disabled | PASS |
| TUI | production raw PTY 显示压缩与 `Project Memory`，精确 final 持久化 | PASS |
| Web GUI | production Chromium 显示 notice，终态/reload 清理，SSE hidden replay 过滤 | PASS |
| ACP | 真实 SDK stdio 接收 `blade/compaction.memory` | PASS |
| Headless | production JSONL 只暴露 outcome/count/topic | PASS |
| 新 Session 发现 | 四端验证 `MEMORY.md` topic link 被新 prompt 加载 | PASS |
| 真实模型 | DeepSeek Flash/Pro × 四端 | PASS |
| 文档与发布 | 双语 guide/reference/evidence、source changelog、CLI package bump | PASS |
