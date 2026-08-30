# ACP Remote Filesystem Ownership 资格验证证据

## 2026-08-30 Final Release Qualification

- 设计提交：`d683bf97`
- 实施计划提交：`46e7a5c9`
- 范围：记录 ACP remote filesystem ownership 的最终 release qualification 证据，
  包括用户契约、确定性测试覆盖、真实 DeepSeek 资格结果、独立审查结论，以及本轮
  fresh 验证命令结果。
- 安全主张：当 ACP Client 在 Session 初始化时声明 text filesystem capability，
  Blade 会把该 Session 的 text-file owner 冻结为 remote；后续 Read / Write / Edit /
  ApplyPatch 只在该 frozen owner 上求值，协议缺失的能力一律 fail closed，不会退回
  Blade 宿主机同名路径。
- 限制：本证据只覆盖 ACP 1.3.0 现有的 `readTextFile` / `writeTextFile` 协议面，不夸大
  binary、stat、mkdir、delete、rename、多文件远端事务或 parent-directory creation
  能力。
- read-back 验证有 5s bounded 约束；ACP `writeTextFile` 调用本身仍依赖 transport
  lifecycle bound，这属于当前协议面的既有可用性限制，而不是本轮已消除的行为差异。

## 用户契约

### owner 选择与冻结

- `fs` capability 缺失，或 `readTextFile=false && writeTextFile=false` 时，Session 使用
 本地 backend；CLI、Web 与 ACP-local 的本地文件语义保持原样。
- 只要 `readTextFile===true` 或 `writeTextFile===true` 其一成立，Session 初始化时就冻结
  remote filesystem ownership；transport reconnect 不会改变 owner。
- capability 变化必须通过重建 Session 生效；旧 Session 不会在运行中切换 owner。
- `isAcpMode()` 仍是 surface / security predicate，只表示当前 surface 是 ACP；
  它不同于 remote filesystem ownership predicate。owner 要看 Session 冻结下来的
  fs capability，而不是只看 ACP transport。

### Read / Write / Edit / ApplyPatch

- remote `Read` 只处理 UTF-8 text；binary、base64、已知二进制扩展名都会在发 ACP
  request 前 fail closed。
- remote `Read`、`Write`、`Edit`、`ApplyPatch` 在 ACP request 失败后都不会 fallback
  到宿主机同名路径。
- remote `Write` 与 `Edit` 都必须同时拥有 `readTextFile=true` 和
  `writeTextFile=true`。read-only 与 write-only Session 都会在任何 I/O 前验证失败。
- existing file 的 remote `Write` / `Edit` 必须先有当前 Session 的 prior matching
  `Read` digest；若远端内容在写入前漂移，则按 stale digest 失败，不发 write request。
- new file 的 remote `Write` 只接受“preflight read 得到明确 ACP not-found”作为
  read-before-write 例外；这不保证 parent directory creation。
- remote `ApplyPatch` 只支持 `Update File`。它会做全量 preflight compare、逐写
  read-back，并在失败时按逆序 verified compensation rollback。`Add File`、
  `Delete File`、`Move to` 全部 fail closed。

### 不确定性与 host-private coordination

- `sideEffectsUncertain: true` 只表示 Blade 无法证明最终 remote 状态，调用方在 retry 前
  必须重新 `Read`；它不意味着“一定失败”，只意味着不能安全重放。
- `sideEffectsUncertain: false` 只表示本次路径上没有不确定副作用，或补偿回滚已验证；
  它不等于“操作一定成功”。
- opaque host-private coordination 只允许 Session-bound hash、token 与 timing 信息；
  不能包含 remote path、remote content、remote digest，也不能作为 remote existence、
  permission 或 mutation 的证据。

## 实现提交职责

| 提交 | 职责 |
| --- | --- |
| `4f0525cf` | 冻结 filesystem backend ownership，阻止 Session 运行中切换远端/本地 owner |
| `2e4c8a19` | 固化 capability snapshot，避免调用方后续修改 capability 对当前 Session 生效 |
| `837feb1a` | 清理 remote filesystem error surface，防止 raw client error logging 泄漏 |
| `2e3b1987` | 增加 session-scoped remote digest ledger 与 lexical remote path normalization |
| `b5c8a40a` | 隔离 remote UTF-8 text read，阻止 host fallback 与 binary 混淆 |
| `2282b980` | 保持 ACP-local / local backend 的原有 metadata 与 fallback 行为 |
| `786c4d26` | 为 remote Write / Edit 增加 read-before-write、readback verification 与 host canary 边界 |
| `f3cef4e4` | 完成 remote mutation uncertainty / classification / cancellation 语义 |
| `2410e060` | 隔离 remote ApplyPatch 的协调状态，不把 host coordination 暴露给 remote owner |
| `01b3b0b5` | 收紧 patch review gap，补足 metadata、ledger、typed fixture 与 host canary 证明 |
| `f978189c` | 把 patch failure metadata 限定到 remote ownership，不污染 ACP-local / local surface |
| `2c69de31` | 新增 remote filesystem ownership qualification，包括 deterministic 与 real-api 轨迹 |
| `e82ef9e2` | 加强 qualification cleanup，避免 timer leak、teardown masking 与 paired-ACP close 歧义 |
| `5617c0e7` | 刷新 durable snapshot fixture contract，使 snapshot 工具测试跟随现行 AcpServiceContext 接口 |
| `8cf43def` | 修复 duplicate initialize 覆盖 owner/ledger，并消除 ApplyPatch ownership predicate 的二次推断 |
| `53229ad3` | 收紧 remote Read redaction、补全 abort-safe compensation，并把 uncertain summary 改为 truthful 语义 |

## 精确 RED 原因

- 缺少 owner freeze / opaque coordination API，Session 会把 ACP mode 与 remote fs owner
  混为一谈。
- 同一 Session 的 duplicate initialize 曾可覆盖已冻结的 owner 与 ledger。
- remote path 处理会落回 host lexical path 或同名宿主文件，违反 remote ownership。
- ApplyPatch 曾对 owner 做二次推断，而不是只服从 Session 冻结下来的 ownership predicate。
- remote error logging 会暴露 raw client error / sentinel payload。
- remote `Read` 曾可能泄露 raw ACP error surface。
- 缺少 digest ledger 与 read-before-write barrier，无法证明 current Session 曾读过同一内容。
- remote mutation 缺少 readback、uncertainty 分类与 cancellation 边界，无法阻止 unsafe retry。
- ApplyPatch 还缺少 remote-only metadata、ledger integration、host canary、typed fixture、
  ACP-local predicate 区分。
- abort 早退曾可能短路已验证写入后的补偿回滚。
- uncertain summary 曾把“无法证明”误表述成更强的结论。
- formatter 缺少 remote mutation uncertainty warning。
- real paired harness 曾缺少 ENOENT / event correlation 的真实断言。
- qualification harness 曾有 timer leak 与 teardown error masking。

## 确定性测试证明了什么

- capability matrix：无 fs / all-false 仍走 local backend；任一 text capability `true`
  即冻结 remote ownership。
- exact remote request sequence：real API 资格强制 `read:source/read:output/write:output/read:output`。
- host canaries：host source file 保持不变，host output parent 不会因 remote write 而被创建。
- ledger barrier：existing remote write/edit 必须经过当前 Session 的 matching read digest。
- rollback uncertainty：remote mutation 与 remote ApplyPatch 都把可证明回滚和不可证明回滚分开。
- opaque locks：远端文件锁与协调键使用 Session-bound opaque identity，不把 host path 暴露给模型或 transcript。

## 真实 DeepSeek ACP 资格结果

命令：

```bash
cd packages/cli
REAL_API_TEST=1 REAL_API_RELEASE_MATRIX=1 bun x vitest run --config vitest.config.ts --project=real-api tests/integration/real-api/acp-remote-filesystem-trajectory.test.ts --retry=0
```

结果：

| 资格 ID | 结果 | 时长 | Framework retry |
| --- | --- | ---: | ---: |
| `deepseek:deepseek-v4-flash` | 通过 | 6.373s | 0 |
| `deepseek:deepseek-v4-pro` | 通过 | 5.000s | 0 |

真实 API 轨迹断言：

- 精确模型 ID 只能是 `deepseek:deepseek-v4-flash` 与 `deepseek:deepseek-v4-pro`。
- 每个 cell 的 `stopReason` 都必须是 `end_turn`。
- 每个 cell 只有 1 次 successful `Write` result。
- request sequence 精确为 `read:source/read:output/write:output/read:output`。
- host source unchanged、host output parent absent、output contains final marker、
  output excludes host canary 四个布尔条件都必须成立。
- framework retry 固定为 0。
- secret scan 必须通过；证据中不记录 API key、raw remote content、client-private error payload。

canonical evidence digest 只基于以下字段：

- `qualificationId`
- `frameworkRetryBudget`
- labeled `requestSequence`
- `writeResultCount`
- `hostSourcePreserved`
- `hostOutputParentAbsent`
- `outputContainsFinalMarker`
- `outputExcludesHostCanary`

显式排除：

- random path
- sessionId
- nonce
- raw content
- credentials
- client-private errors

canonical evidence digest：

| 模型 | digest |
| --- | --- |
| `deepseek:deepseek-v4-flash` | `b2aef283d1853f971820e0761a68ffab94b4790cf1cb09008657f74d8dc17898` |
| `deepseek:deepseek-v4-pro` | `62e65bc4554273fc5d837ea7fd00cde2ce55dc8e008ddaa0302d1e81adfdf297` |

本次 real API stdout 未直接打印 digest；上述值沿用 canonical helper 的稳定输出。由于本次
trajectory 断言继续通过，且 canonical input 字段集合未变，因此仍将其作为可复现 digest
记录，而不伪称为本次从 stdout 提取。

## 独立审查

- whole-patch specification review：在 `8cf43def` 之后完成最终复核，结论 `✅ Spec compliant`。
- narrow regression spec review：在 `53229ad3` 之后完成窄规格回归复核，结论 `✅ Spec compliant`。
- final quality review：初次复核发现 `2 Critical + 1 Minor`。
- `53229ad3` 后 closure review：结论 `APPROVED`，剩余 `0 Critical / 0 Important`。
- reader test：`PASS`。

这些审查与实现共同确认：

- owner 选择、冻结与 reconnect 边界没有回退空间；
- remote mutation uncertainty 和 ApplyPatch compensation 需要 fail closed；
- 证据只保留结构化、可复跑的事实，不保留 raw secrets 或 remote content。

## Stage A fresh 验证

### focused

命令：

```bash
cd packages/cli
bun x vitest run --config vitest.config.ts \
 tests/unit/agent-runtime/acp/file-system-service.test.ts \
 tests/unit/agent-runtime/acp/service-context.test.ts \
 tests/integration/acp-remote-file-tools.test.ts \
 tests/unit/tooling/tools/execution/file-lock-manager.test.ts \
 tests/unit/agent-runtime/tools/tool-executor-filelock.test.ts \
 tests/integration/apply-patch-tool.test.ts \
 tests/integration/apply-patch-transaction.test.ts \
 tests/unit/integration/remote-filesystem-qualification-harness.test.ts \
 tests/unit/platform/ui/utils/tool-formatters.test.ts \
 tests/unit/tooling/tools/builtin/file/durable-snapshot-tool-integration.test.ts
```

结果：退出码 0；`10 files passed`，`193 tests passed`，`0 failed`。

### repo root

- `bun run type-check`：退出码 0。
- `bun run lint`：退出码 0。
- `bun run build`：退出码 0；仅见既有 Browserslist 数据过期与 Web chunk > 500 kB 警告。
- `bun run test:all`：退出码 0。
  non-performance 结果为 `Test Files 454 passed | 92 skipped (546)`，
  `Tests 4910 passed | 84 skipped (4994)`，duration `304.68s`。
  performance 结果为 `Test Files 4 passed | 1 skipped (5)`，
  `Tests 9 passed | 1 skipped (10)`，duration `5.12s`。
- real API ACP filesystem：
  `Test Files 1 passed (1)`，`Tests 2 passed (2)`；
  `deepseek:deepseek-v4-flash` `6.373s`，
  `deepseek:deepseek-v4-pro` `5.000s`。
- `git diff --check`：退出码 0。

### release metadata 后最终验证

将 `packages/cli/package.json` 更新为 `0.10.126` 并同步两份权威 changelog 后，
从仓库根目录重新执行：

```bash
bun run build && bun run test:all
```

结果：退出码 0。CLI、Web 与 VSCode build 全部成功；build 仍只有既有
Browserslist 数据过期与 Web chunk size warning。non-performance suite 为
`Test Files 454 passed | 92 skipped (546)`、
`Tests 4910 passed | 84 skipped (4994)`，duration `300.59s`；performance suite 为
`Test Files 4 passed | 1 skipped (5)`、`Tests 9 passed | 1 skipped (10)`。


## 没有被证明的事

- 本证据不证明 ACP 1.3.0 支持 binary read、stat、mkdir、delete、rename 或 remote
  parent creation。
- `sideEffectsUncertain=false` 不证明上层业务一定成功；它只证明当前路径上没有未分类的
  远端副作用。
- real-api 资格只证明一条受控 paired ACP remote ownership 轨迹，不证明所有模型都能稳定遵循任意复杂 patch/workflow。
