# ACP Capacity Coordinator 启动竞态修复证据

- 日期：2026-09-04
- 目标版本：`blade-code@0.10.132`
- 基线：`v0.10.131` / `113447eb2de96169c367ae46279c424f1574be0d`
- 已验证代码候选：`5a15eefc45fe6608987137039ac74cb7099cf83c`
- 设计：`docs/superpowers/specs/2026-09-04-acp-capacity-coordinator-open-race-design.md`
- 计划：`docs/superpowers/plans/2026-09-04-acp-capacity-coordinator-open-race.md`

## 问题与根因

ACP remote workspace-reference registry 使用 collision scope 内的私有 SQLite
coordinator，将 1,024 条 binding 上限的检查与发布串行化。修复前，shared
`openDb()` 会先协商 WAL、再安装 `busy_timeout`，而 coordinator 随后又在
`BEGIN IMMEDIATE` 之前将 journal mode 切回 DELETE。两个 fresh Bun 进程并发启动时，
会在事务锁之外争用 persistent journal mode；失败者被固定脱敏为不可重试的
`session_surface_state_invalid`，而不是进入容量临界区后得到预期的可重试
`session_surface_capacity`。

完整文件重复执行在修复前复现了该结果：一个 child 成功，另一个返回
`session_surface_state_invalid`。临时诊断断言在确认 outcome 后已经撤销，没有进入提交。

## 修复边界

- shared SQLite driver 在 WAL negotiation 前安装 busy timeout，普通调用仍默认 5 秒；
- coordinator 从 open/WAL negotiation 阶段开始使用 30 秒 timeout，并继续在连接后显式
  保持该 timeout；
- coordinator 不再把 shared WAL 切回 DELETE；
- `BEGIN IMMEDIATE` 仍是容量检查与 sidecar 发布的唯一跨进程临界区；
- PRAGMA 初始化失败后尽力关闭已经打开的连接，避免依赖 GC 释放锁与文件描述符；
- identity、ownership、mode、realpath、`-journal` / `-shm` / `-wal` auxiliary-file、
  killed-owner recovery、1,024 容量以及固定脱敏错误契约均保持不变。

## TDD 与 focused 证据

首个 source contract RED 为 2/2 失败：shared driver 中 WAL 位于 busy timeout 之前，
且 coordinator 仍包含 `PRAGMA journal_mode=DELETE`。实现最小修复后两项转绿。

首次质量/并发审查随后提出三个 Important：30 秒 coordinator timeout 尚未覆盖 WAL
协商、初始化 PRAGMA 失败后连接未显式关闭，以及缺少发布运行时 Node /
`better-sqlite3` 的行为覆盖。新增契约先以 2 项失败形成 RED；真实 Node 子进程通过
`BEGIN EXCLUSIVE` 持锁的行为测试确认既有 5 秒等待路径可工作。修订后，四项 driver
初始化测试全部通过。

~~~text
driver initialization contract + Node lock behavior: 1 file, 4/4 passed
focused SQLite/ACP/service suite:                  5 files, 86/86 passed
complete workspace-reference file x 10:            10/10 rounds, 15/15 each
CLI TypeScript type-check:                         PASS
focused Biome + git diff --check:                  PASS
~~~

focused suite 包含 projection、read parity、workspace-reference、Session surface service
和初始化顺序/Node 锁行为。真实 Node 测试由独立 Node 进程加载 `better-sqlite3`，持有
DELETE-mode database 的排他事务；父进程使用真实 `openDb()` 等待锁释放并完成 WAL
协商。原有完整 workspace-reference 文件则继续用两个真实 Bun 进程验证 killed-owner
recovery 与严格容量 outcome。

## 独立审查

- 最终规格复审：PASS；所有严重度问题为 0。
- 最终质量与并发复审：APPROVED；首轮 3 个 Important 全部关闭，最终无
  Critical、Important 或 Minor 阻断项。
- 审查确认默认 shared driver 仍为 5 秒，只有 coordinator 使用 30 秒；新增 timeout
  只接受非负安全整数，不形成 SQL 插值入口；公共 wire format、容量与错误语义未变化。

## 最终仓库门禁

在包含 `0.10.132` metadata 的完整候选树上 fresh 执行：

~~~text
format:check  PASS — 1555 files
lint          PASS — CLI 1353 files, Web 200 files, VSCode PASS
type-check    PASS — CLI, Web, VSCode
build         PASS
test:all      475 files passed, 95 skipped
              5486 tests passed, 85 skipped, 308.42s
performance   4 files passed, 1 skipped
              9 tests passed, 1 skipped, 5.15s
coverage      475 files passed, 95 skipped
              5486 tests passed, 85 skipped, 300.67s
              statements 73.39%, branches 66.80%
              functions 75.35%, lines 74.72%
~~~

普通全量测试与 coverage 均包含本补丁的真实 Bun 两进程容量测试及真实 Node /
`better-sqlite3` 锁竞争测试，未再出现 `session_surface_state_invalid` loser。付费
real-API case 按既有 gate 跳过；本补丁不修改模型或交互 surface，因此没有重复消费
Provider 请求来替代直接的 SQLite 跨进程证据。Build 仅保留既有 Browserslist
stale-data 与大于 500 KiB chunk warning。

## 源码哈希

~~~text
AcpRemoteWorkspaceReference.ts               51c92a0a8453918079d5e8edf9b4d53f804ad82d2d75b1c9a986b518e13c4ae7
driver.ts                                    f856bd97c5f1b7820a3cbcca9021027ac86a1a58d5251ad22c11743bd30c62df
driver-initialization-order.test.ts          6d758ba471acf10020f276252907460f670e032a86dcaa9d02eff2c7cc7283d7
~~~

## 边界

- 本补丁不修改 workspace-reference wire format、容量、public error 或 Session API。
- 本补丁不宣称 SQLite busy timeout 可以解决永久锁；30 秒耗尽后仍按既有固定错误
  fail closed。
- 本补丁不涉及模型请求或 GUI/TUI 用户旅程，因此没有伪造一条不相关的 real-API 或
  screenshot 资格证据。
