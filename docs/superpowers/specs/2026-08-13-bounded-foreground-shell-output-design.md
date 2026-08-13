# 前台 Shell 有界输出设计

日期：2026-08-13

状态：设计已确认，待书面规格审阅

目标版本：下一个可用 patch 版本；若 main 在实施前未前进，则为 0.10.28

## 1. 背景与决策

Blade 的后台 Bash 已用每流 1 MiB 的 BoundedOutputBuffer 限制内存，前台
Bash 却仍在进程退出前持续拼接完整 stdout 和 stderr。OutputTruncator 只在
命令结束后缩短模型可见内容，不能限制运行期间的内存；timeout、abort 和
部分 sandbox 错误还会把大输出放入 metadata 或 error message。

本地参考实现给出了同一方向：OpenAI Codex 的 shell exec 和 unified exec
设置了输出字节上限，grok-build 也使用带总字节统计的截断机制。Claude Code
快照与 Neovate Code 对比发现的工具阶段 tracing、SDK facade 等能力留给后续
独立 patch。

本设计选择：

- stdout、stderr 各自持有 1 MiB UTF-8 原始字节尾缓冲；
- 采集期内存限制和模型上下文限制保持为两个独立层；
- ToolResult 继续作为唯一 canonical 协议，不新增 LoopEvent、SSE 事件或 ACP
  私有扩展；
- 本地 Bash、LocalTerminalService、CLI/TUI、Web、Headless 和 ACP 使用同一
  输出事实与展示投影；
- 真实 API 准出固定覆盖 DeepSeek Flash/Pro 与 Web 真浏览器、raw PTY TUI、
  ACP SDK 三个入口。

## 2. 问题定义

当前实现存在五类风险：

1. 本地前台 Bash 与 LocalTerminalService 在进程退出前保存完整输出，内存无界。
2. timeout、abort 与 sandbox runtime failure 可通过 metadata 或 error message
   绕过最终截断。
3. ACP Bash 会把远端 terminal 原始增量转发为 tool progress；最终结果即使有界，
   中间内容仍可能进入用户表面。
4. Web 实时路径使用 formatToolDisplay，冷加载路径却直接展示 durable payload，
   刷新前后不一致。
5. Bash formatter 只显示前八行，Web 还会再次裁剪，截断提示容易丢失。

## 3. 目标

1. 对 Blade 自己拥有的本地前台 stdout、stderr 分别建立 1 MiB retained-memory
   上限。
2. 保留最新尾部、完整累计字节数、完整 UTF-16 code-unit 长度和可靠的省略
   字节数。
3. 保持成功、失败、timeout、abort、sandbox、admission 与 finalization 的既有
   控制流和 llmContent 顶层形态。
4. 所有已启动终态只发布、持久化和展示有界输出；未启动失败不伪造输出。
5. 让模型、TUI、Headless、Web 与 ACP 看见同一截断事实，刷新和重连后不漂移。
6. 证明大输出不会泄漏被 capture 省略的前缀 sentinel、API key、完整 PTY
   transcript 或宿主信息。
7. 把真实 Chromium、raw PTY 和 ACP SDK 轨迹纳入 qualify:production 固定矩阵。

## 4. 非目标与证据边界

- 不把完整输出写入临时文件或 artifact；这会引入磁盘配额、敏感数据和下载授权。
- 不修改后台 Bash 和 TaskOutput 的产品语义，只补强共用缓冲实现。
- 不把历史工具卡加入 TUI 或 ACP session/load；两者继续只恢复安全历史。
- 不修改 Headless tool_result v1 wire schema。
- 不解决 command 参数自身可能含 secret 的既有问题，也不扩大 command 暴露面。
- 不承诺 ACP remote host 端到端内存有界。ACP currentOutput 一次返回完整字符串，
  Blade 只能限制收到响应后的 retained/projection；IDE 客户端构造响应前的内存
  不受 Blade 控制。
- 不在本 patch 实施周期空转检测、工具阶段 tracing、presence registry、raw-spawn
  静态门禁、前台转后台或公开 SDK facade。
- 当前执行环境没有 Computer Use 桌面入口。raw PTY 是稳定自动门禁；未来若宿主
  提供 Computer Use，可补充视觉证据，但不能替代协议和宿主断言。

## 5. 方案比较

### 5.1 选定：每流独立尾缓冲

stdout 与 stderr 各自使用 1 MiB 尾缓冲。错误流不会被高吞吐 stdout 挤掉，
并与后台 shell 当前契约一致。最坏 retained payload 约为 2 MiB，加上有界投影副本。

### 5.2 未选：共享 1 MiB

总内存更低，但任一流都可能吞掉另一流的关键诊断。

### 5.3 未选：溢出落盘

可以保留完整输出，却会把内存修复扩大为 artifact 安全系统。

## 6. 三层输出模型

输出经过三个不同层级：

    child or terminal bytes
      -> capture: 每流最多 1 MiB retained tail，累计完整统计
      -> model projection: OutputTruncator 生成 3K 到 20K 字符结果
      -> surface display: formatToolDisplay 生成更短且保留提示的详情

任何下游层都不能重新引入上游省略内容，也不能把展示字符串反向持久化为
第二套 canonical 数据。

## 7. Capture primitive

### 7.1 BoundedOutputBuffer 补强

保留 BACKGROUND_SHELL_OUTPUT_MAX_BYTES 导出，新增
FOREGROUND_SHELL_OUTPUT_MAX_BYTES = 1024 * 1024。若抽取通用常量，旧导出作为别名。

缓冲必须满足：

- append 接收原始 Buffer，不先转字符串；
- 超大 Buffer 只复制需要保留的尾部；
- retained chunk collection 最多 32 个 Buffer 对象；即将超过时合并 retained
  chunks，不能让百万个小 chunk 以百万个对象的形式常驻；
- 删除完整首 chunk 后仍校验新起点是否落在 UTF-8 continuation byte；
- 必要时多省略 1 到 3 bytes，保证 snapshot 不以意外 U+FFFD 开头；
- totalBytes 统计全部原始输入；
- 前台 capture 不调用 consume，始终满足 totalBytes = retainedBytes + omittedBytes；
- 后台 consume 继续保留 lifetime total、重置当前 omitted 的旧语义。

### 7.2 ShellOutputCapture

新增只负责 stdout/stderr 事实的内部组件，供 native Bash 与 terminal service 复用。
每个流的 snapshot 包含：content、totalBytes、retainedBytes、omittedBytes、
totalChars 和 accountingComplete。

StringDecoder 仅用于增量统计完整输出的 UTF-16 code units 与行数，不保存完整字符串。
流结束时调用 decoder.end；残缺尾序列沿用 Node replacement 行为，byte accounting
始终以原始 bytes 为准。

## 8. 本地前台执行

executeWithTimeout 用两个 capture stream 替换无界字符串：

- data handler 追加原始 Buffer；
- timeout 或 abort 先终止进程树，再 finalize，最后构造结果；
- close 分支保持 timeout、abort、admission、finalization、sandbox runtime、普通退出
  的既有优先级；
- 初始 lease/register 或 sandbox prepare 失败发生在 admission 前，继续不附输出；
- gate release、finalization、sandbox runtime 与 child error 发生在命令可能启动之后，
  只能附安全投影与统计；
- sandbox runtime 的 error message 必须使用有界 stderr 投影。

正常成功和非零退出继续使用对象型 llmContent；timeout 和 abort 继续使用当前固定
字符串型 llmContent。

## 9. ACP terminal 执行

TerminalExecuteResult 添加可选 capture stats、transport 和离散 failureKind。
failureKind vocabulary 固定为 timeout、aborted、admission、finalization、unavailable、
spawn。保留 error 字符串兼容字段，Bash 层改用 failureKind 判定。

LocalTerminalService 使用同一 capture primitive，并在没有 remote ACP Session 时报告
local transport。AcpTerminalService 只有调用方显式允许时才可报告 local_fallback。

AcpTerminalService 使用串行、单 pending-read 的轮询，不能由 setInterval 产生重叠的
currentOutput。ACP 输出是合并流：

- 全部数据计入 stdout，stderr stats 为零；
- metadata 明确 terminal_output_merged = true；
- cumulative output 只追加上次 char offset 后的增量；
- output 长度回退、轮询失败或最终读取失败时，设置
  output_accounting_complete = false，已有统计只作为下界；
- 命令结束后若最终 currentOutput 成功，以最终完整响应重新构建 capture 并把
  accounting 标记为完整；只有最终读取失败时才保留轮询所得下界；
- createTerminal 失败且调用方明确允许 fallback 时报告 local_fallback；
- remote ACP Session 中的 Bash Tool 必须传 allowLocalFallback = false，和已有 ACP
  user-shell executor 的 fail-closed 契约一致。当前 Bash Tool 漏传该字段是本 patch
  同时修复的 split-brain 安全缺口；remote terminal 失败不得在 Blade 宿主执行命令。

## 10. 原始输出不得进入 progress

前台 Bash 不再把 stdout/stderr chunk 直接传给 updateOutput。

- 启动时仍可发固定状态文案；
- 长命令可按节流后的累计字节数发布状态；
- progress 只包含固定文案和整数，不含 command output；
- 完整安全预览仅在 committed tool_result 发布。

这阻止本应省略的输出从 Web SSE、TUI 或 ACP in-progress update 绕过截断。

## 11. Canonical ToolResult

不新增 ToolResult 顶层字段。成功和普通非零退出的 llmContent 保留现有字段，
additive 增加：output_truncated、stdout_omitted_bytes、stderr_omitted_bytes、
stdout_total_bytes、stderr_total_bytes、output_accounting_complete，以及仅在 ACP
合并流为 true 的 terminal_output_merged。模型因此可以区分独立 stdout/stderr 与
ACP 合并终端，但不会看到 transport、路径或 retained capture。

BashForegroundMetadata additive 增加：

- output_truncated：任一流发生 capture 或 model projection 截断；
- capture_truncated 与 projection_truncated：区分两层限制；
- stdout_total_bytes、stderr_total_bytes：trim 前原始字节累计；
- stdout_retained_bytes、stderr_retained_bytes：model projection 前 retained bytes；
- stdout_omitted_bytes、stderr_omitted_bytes：capture 丢弃的早期字节；
- raw_output_bytes：两个 total 之和；
- stdout_projection_truncated、stderr_projection_truncated；
- output_accounting_complete；
- terminal_transport：local、acp 或显式允许时的 local_fallback；
- terminal_output_merged。

stdout_length 和 stderr_length 保持原字段单位：完整输出解码后的 UTF-16 code-unit 数，
绝不改成 bytes。有效 UTF-8 的结果与旧实现一致；跨 chunk 的有效多字节字符改为正确
流式解码，非法 UTF-8 按 StringDecoder 的 replacement 语义计数，而不保留旧实现因
逐 chunk toString 造成的偶然多重 replacement。
所有字节字段都以 _bytes 结尾。
accounting 不完整时省略 stdout_length/stderr_length，避免把下界伪装成完整长度；
total byte 字段仍可作为下界，但必须同时带 output_accounting_complete = false。

timeout 和 abort 可继续在 metadata 带 stdout/stderr，但必须是 OutputTruncator 后的
短预览，不是 1 MiB capture。未启动错误不添加虚假 accounting。

## 12. Model projection 与错误

共享 projector 接收 capture snapshot 后：

1. 仅对正常模型投影调用现有 trim，保持可见行为；
2. 分别运行 truncateForLLM；
3. 把 capture omission 与 projection truncation 合并成有界 truncation_info；
4. 确保字符串 slice 不拆开 UTF-16 surrogate pair；
5. 非零退出的 error message 仅由同一安全投影构建；
6. failure display 使用持久化 error 和安全 metadata。

truncation_info 是既有模型协议，继续兼容旧会话；结构化字段成为新稳定事实。
发生 capture omission 时，提示必须先明确“省略的是最早输出、当前内容是 retained
tail”，不能把 retained tail 的开头描述成命令原始输出的开头。

## 13. Durable persistence 与恢复

tool result durable commit 成功后才能进入模型上下文或任何 surface，这一顺序不变。

- 成功结果持久化模型实际看到的有界 llmContent；
- 失败结果持久化有界 error message，metadata 只含短 preview 与统计；
- durable metadata 不保存 1 MiB retained capture；
- 省略区 sentinel 不得出现在 JSONL；
- 不持久化 ToolDisplayOutput。

新增共享 durable ToolResult restore projector，从 payload.output、payload.error 与
payload.metadata 重建显示输入。Web realtime、committed replay 和 REST fresh load
调用同一 projector。失败 output 为 null 的旧会话必须兼容。

## 14. Surface contracts

### CLI/TUI

- Bash detail 显示安全预览，失败结果也可显示有界诊断；
- stdout 与 stderr 同时存在时显示两个带标签的有界 head-and-tail section，不能用
  stdout || stderr 丢弃其中一侧；单行超长输出也必须保留每流末尾 marker；
- 截断提示固定在 detail 最后一行，最多一次；
- resize 不重复 result 或丢失提示；
- cold resume 继续不重放历史 tool card。

### Headless

- tool_result v1 schema 不变；
- 复用已有 tool_detail 输出安全预览和提示；
- text 模式写 stderr，不污染 assistant stdout；
- 一次结果最多一个 tool_detail。

### Server SSE 和 Web

- sanitizeToolMetadata 接收 toolName，对 Bash 使用明确 allowlist；历史 metadata 中的
  stdout/stderr 无条件删除；
- allowlist 只暴露 summary、状态、sandbox、transport 和统计；
- tool.result.output 使用共享 formatter；
- Web 卡片增加稳定 data-tool-name、data-tool-status 与 truncation selector；
- 展开详情有严格上限，并固定保留截断提示；
- Web 的最终 500 字符级展示裁剪由共享 helper 生成，按 stdout tail、stderr tail、
  truncation suffix 三段分配预算，不能再对完整 display string 盲目 slice；
- realtime、Last-Event-ID replay 与 fresh load 显示一致。

### ACP

- live tool_call_update 使用相同安全详情与标准 completed/failed status；
- 不新增 Blade 私有元数据；
- session/load 继续只 replay user/assistant；
- remote merged stream 不伪造 stderr。

## 15. 安全不变量

以下内容不得出现于 provider follow-up、durable JSONL、SSE、DOM、PTY evidence、
ACP update 或测试 artifact：

- fixture 中位于首个 64 KiB 省略前缀内的 sentinel；
- API key 或 Authorization header；
- 完整浏览器 network body；
- 完整 PTY transcript；
- 非必要的临时 HOME/storage 绝对路径。

测试失败日志先 redaction，再输出有界 tail。浏览器只访问 loopback Blade server，
API key 不注入 page context。

## 16. Deterministic tests

### Buffer

- ASCII 精确边界、max + 1、单个超大 Buffer；
- UTF-8 字符跨多个 chunks；
- 删除完整首 chunk 后的新 UTF-8 起点；
- emoji、四字节字符与残缺末尾；
- total = retained + omitted、peek 幂等和 consume 旧语义。

### Native Bash

- 大 stdout、大 stderr、双流独立预算；
- 成功、非零、timeout、abort；
- admission release、finalization、sandbox runtime 与 child error；
- trim 前 stats、trim 后模型投影、错误文案均有界；
- 原始 output 不进入 progress。

### ACP service 与 Bash adapter

- remote success、nonzero、timeout、abort；
- cumulative polling 不重叠、不重复计数；
- merged stream、accounting incomplete 和长度回退；
- createTerminal failure、显式 fallback 与 failureKind；
- 通过真实 AcpServiceContext session 和测试 SDK connection 执行 Bash adapter。

### Projector 与协议

- 前八行预览仍固定附加截断提示；
- 双流 display 同时保留 stdout/stderr 标签和各自 tail；单行超长输出不丢 tail；
- stdout/stderr 同时存在不丢统计；
- durable commit 失败不发布 result；
- Headless v1 shape 不变；
- Web realtime/replay/reload 同卡片；
- ACP load 不 replay tools；
- Bash metadata sanitizer 拒绝 raw output。

### Performance

预热后向 capture 追加至少 64 MiB 的 64 KiB chunks，证明 retained bytes 始终不超过
上限、总字节准确且 retained collection 不随总输出增长。不能用跨硬件固定墙钟作为
正确性门槛。

## 17. Real API release qualification

### Fixture

宿主预写依赖无关脚本，分别向 stdout/stderr 输出 1 MiB + 64 KiB ASCII bytes。
每流在最初 4 KiB 内放独立 omitted-prefix sentinel，并在末尾放独立 nonce tail。
由于尾缓冲只保留最后 1 MiB，前缀 sentinel 必然位于被省略的 64 KiB 内；不以
输出中点作为省略证据。脚本先写完两路 sentinel/filler，再在结束前依次写 stdout
tail 和 stderr tail，确保 ACP 合并流的最后 1 MiB 也同时包含两个 tail。模型不能
生成脚本或大文本。

Prompt 提供 shell-quoted 精确命令，只允许 Bash，YOLO、temperature 0、最多两轮，
关闭内置 verification agent。Web/PTY prompt 要求看到 output_truncated、stdout/stderr
两个 omitted bytes 与两个 tail 后才回复 marker；ACP prompt 要求看到
terminal_output_merged、stdout omitted bytes、stderr stats 为零与两个 tail 后回复 marker。

### 固定六格矩阵

对 deepseek-v4-flash 和 deepseek-v4-pro 各运行：

1. production Chromium Web GUI；
2. production raw PTY CLI/TUI；
3. real ACP SDK NDJSON lifecycle。

每格由宿主验证：

- 恰好一次前台 Bash，未使用 background Bash、TaskOutput 或其他工具；
- command 等于 fixture command；
- Web 与 PTY 的本地执行要求 stdout/stderr total bytes 分别符合 fixture，每流
  retained 不超过 1 MiB 且 omitted bytes 精确大于零；
- ACP remote 要求 terminal_output_merged = true、stderr stats 为零、合并 stdout
  total bytes 等于两流总和、retained 不超过 1 MiB 且 stdout omitted bytes 大于零；
- 两个 tail 存在，两个 omitted-prefix sentinel 不存在；
- final marker 存在且 transcript/surface 不含 key；
- runtime、process tree 与 lease 完整回收。

ACP 使用真实 SDK connection 与真实 terminal handle；terminal handle 实际启动 fixture
child process，不能用固定返回值 mock。

## 18. Chromium Web GUI gate

在 packages/cli 增加 playwright devDependency，不引入 @playwright/test。Vitest 继续
管理 matrix、timeout、secret 和 cleanup。

- 新增 browser:install script，明确执行 playwright install chromium；
- 新增无网络、无密钥的 browser:check script；production qualification plan 在任何
  paid real-API 子进程之前先执行该 preflight；
- test runtime 不隐式下载；Chromium 缺失时 fail closed 并打印安装命令；
- qualify:production 在真实轨迹前验证 executable；
- 当前公开 CI 和 publish workflow 没有 paid API 凭据，不虚构在线 real-API gate；
  实际运行 production qualification 的环境必须先安装并缓存 browser；
- 使用 production dist/blade.js serve、真实页面和 stable data attributes；
- 捕获 pageerror、应用 console.error、HTTP 4xx/5xx 和 unexpected request failure；
- 页面 refresh 的预期 navigation/EventSource abort 用窄 allowlist；
- 展开 Bash 卡验证提示、tails 与 sentinel absence；
- refresh 后再次验证同一卡片和零应用错误。

## 19. Raw PTY gate

新增专用 bun-pty runner：

- production dist/blade.js 和 isolated HOME/storage/workspace；
- bracketed paste 提交 prompt；
- runner 只保留有界 ANSI tail，不写完整 transcript；
- 等待 truncation notice 和 final marker；
- PTY resize 后验证提示仍存在且不重复；
- 屏幕只作为 UI 证据，canonical stats 从 durable transcript 读取；
- 结束时关闭 stdin、终止 PTY、等待进程组并检查 foreground lease。

## 20. ACP gate

- 使用真实 ACP SDK codec、dispatcher、Session 和 terminal handle；
- terminal handle 执行 fixture 并返回 cumulative output；
- live tool_call_update 只含有界详情，raw progress 不含 sentinel；
- 不出现 Blade 私有扩展；
- session/load 不回放工具；
- local fallback 由 deterministic test 覆盖，真实矩阵验证 remote ACP。

TerminalService 保留 raw onOutput 作为内部 transport capability，供已有 user-shell
service 使用；该 service 自身已有独立 stream budget。Bash Tool 不把这个 callback
连接到 generic tool progress，只消费 terminal 返回的 canonical capture/result。

## 21. Timeout 与 cleanup

- Provider/runtime 单格 hard deadline 180 秒；
- 每格测试 timeout 240 秒，预留 60 秒清理；
- real-api project 保持单 worker；
- realApiQualification 总 watchdog 从 30 分钟固定提升到 45 分钟；若首次六格实测
  p95 加 20% 超过 45 分钟，必须先定位慢点或显式修订规格，不能运行时动态放宽；
- page、context、browser、SSE/WebSocket、server、PTY、ACP connection、fixture process
  和代理全部 await close；
- TERM 后按 owned-process protocol 升级 KILL；
- foreground lease、端口、临时 root 和 Vitest open handle 均不得残留。

## 22. Qualification 与发布

qualify:local 覆盖 deterministic tests、type-check、lint、build、Web tests 和
performance，不消费真实 API。

qualify:production 在 local 通过后运行固定真实 API 文件，并加入
foreground-bounded-output-trajectory.test.ts。缺少 Flash、Pro、API credential 或
Chromium 时均 fail closed。密钥从受限 config/auth 存储或测试环境 materialize，
不写入仓库、命令或 artifact。

当前 release.js 配置不运行测试，tag workflow 也只校验版本、构建和发布；因此这里的
release-blocking 指发布流程要求，而不是已经存在的远端自动保护。本 patch 不把 paid
API secret 引入公共 tag workflow。发布者必须在待发布 HEAD 上显式运行
qualify:production，并在 bounded-foreground-output evidence 文档中记录 HEAD、模型矩阵、
命令、退出码和无密钥检查，然后才允许创建 tag。把该证据机械绑定到 tag 的通用
qualification receipt 属于后续独立 release-infrastructure patch。

功能作为独立 npm patch 发布。实施完成时按最新 main 解析版本，更新 package version、
CHANGELOG 和相关文档，执行 qualify:local 与 qualify:production，再走 tag-driven release。
设计文档提交本身不触发版本发布。

## 23. 预计文件影响

生产代码：

- packages/cli/src/tools/builtin/shell/BoundedOutputBuffer.ts
- packages/cli/src/tools/builtin/shell/ShellOutputCapture.ts（新）
- packages/cli/src/tools/builtin/shell/bash.ts
- packages/cli/src/tools/builtin/shell/OutputTruncator.ts
- packages/cli/src/acp/AcpServiceContext.ts
- packages/cli/src/tools/types/ToolTypes.ts
- packages/cli/src/ui/utils/toolFormatters.ts 或提取出的共享 projector
- packages/cli/src/server/routes/session.ts
- packages/cli/src/services/SessionService.ts
- packages/cli/web/src/store/session/utils/aggregateMessages.ts
- packages/cli/web/src/components/chat/ChatMessage.tsx

测试与门禁：

- buffer、Bash、process lifecycle、sandbox、ACP、formatter、Headless、server 和 Web
  现有测试；
- packages/cli/tests/integration/real-api/foregroundBoundedOutputFixture.ts
- packages/cli/tests/support/foregroundBoundedOutputPtyRunner.ts
- packages/cli/tests/support/launch-foreground-bounded-output-gui.ts
- packages/cli/tests/integration/real-api/foreground-bounded-output-trajectory.test.ts
- packages/cli/scripts/test-config.js 及声明/门禁测试
- packages/cli/scripts/qualification.ts
- packages/cli/scripts/browser-check.ts（新）
- packages/cli/tests/unit/scripts/qualification.test.ts
- packages/cli/package.json 与 bun.lock
- docs/testing/bounded-foreground-output-evidence.md

文档与发布：

- docs/reference/process-lifecycle.md
- docs/reference/tool-list.md
- docs/testing/qualification.md
- docs/changelog.md
- packages/cli/package.json version

如共享 projector 需要独立模块，应提取小型纯函数文件并从旧 formatter re-export，
避免一次性移动所有 formatter。

## 24. 完成标准

只有全部满足时本 patch 才完成：

- native 与 LocalTerminalService 每流 retained output 不超过 1 MiB；
- ACP remote 的 Blade retained/projection 有界，协议边界准确；
- UTF-8 chunk 边界无意外 U+FFFD；
- 成功、非零、timeout、abort、sandbox、admission、finalization 有确定性测试；
- raw output 不进入 progress、metadata sanitizer 或 durable transcript；
- CLI/TUI、Headless、Web realtime/replay/reload、ACP live 使用同一截断事实；
- Headless v1 与 ACP 标准协议无破坏性变化；
- DeepSeek Flash/Pro 乘 Web/PTY/ACP 六格真实 API 全绿；
- Chromium、PTY、ACP、process tree、lease、端口和临时根全部清理；
- bun run qualify:local 退出 0；
- bun run qualify:production 退出 0；
- evidence 文档记录待发布 HEAD、六格模型/入口矩阵、精确命令、退出码与 secret 检查；
- git diff --check 退出 0，工作树只含预期改动；
- 版本、changelog、reference、qualification 文档与实现一致；
- 独立 patch 经 tag-driven release 后核验 npm 版本。
