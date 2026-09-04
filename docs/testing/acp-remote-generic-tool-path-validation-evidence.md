# ACP Remote 通用工具路径校验证据

- 日期：2026-09-04
- 目标版本：`blade-code@0.10.130`
- 基线：`v0.10.129` / `0b221cd080274785401f72577c9eed867f4eb6a8`
- 当前已验证代码候选：`6a36896df7eaf8f5c58e1278c91c1c912e72d184`
- Framework retry：`0`
- Provider model retry：`0`

## 结果

ACP remote 的通用工具执行边界现在会在 schema validation 之后、任何 hook、
scheduler、file lock、tool invocation 或 ACP filesystem I/O 之前校验工具声明的所有
remote 文件路径。相同校验会在 hook 改写参数后再次执行。

校验来源包括：

- `file_path`；
- `notebook_path`；
- `ToolKind.Write` 的通用 `path`；
- `ToolInvocation.getAffectedPaths()` 返回的每个路径。

内置 `ApplyPatch` 保留事务层的相对路径 preflight；该例外绑定 registry 中的 builtin
身份和工具名，动态 MCP 工具不能通过同名获得例外。`affectedPaths()` 推导失败也会
fail closed 为固定、脱敏的 `acp_remote_path_invalid`。local 与 ACP-local 语义不变。

## TDD 证据

初始 RED 在 production 修改前运行：

```bash
cd packages/cli
bun x vitest run --config vitest.config.ts --project=unit \
  tests/unit/agent-runtime/tools/tool-executor-filelock.test.ts --reporter=dot
```

```text
Test Files  1 failed (1)
Tests       3 failed | 48 passed (51)
```

三个因果失败分别证明：

1. remote write MCP 的通用 `path` 被实际执行；
2. 仅通过 `affectedPaths()` 声明的第二条非法路径被实际执行；
3. hook 改写后的 declared path 被实际执行。

审查驱动 RED 另外证明：

- 动态 MCP 同名 `ApplyPatch` 曾可获得仅按名称判断的例外；
- `file_path ?? notebook_path` 会让第二个字段被第一个安全字段遮蔽；
- concurrency-safe MCP 的 `file_path` 曾绕过 gate；
- `affectedPaths()` 抛出的异常可把 raw remote path 带入模型可见错误。

上述各项均先观察到因果失败，再修改 production code。

## 确定性验证

最终 focused unit：

```bash
cd packages/cli
bun x vitest run --config vitest.config.ts --project=unit \
  tests/unit/agent-runtime/tools/tool-executor-filelock.test.ts \
  tests/unit/tooling/tools/execution/workspace-tool-policy.test.ts \
  --reporter=dot
```

```text
Test Files  2 passed (2)
Tests       62 passed (62)
```

覆盖 `ToolExecutor` remote path、workspace policy、双字段、多路径、hook rewrite、
builtin identity、异常脱敏、readonly business `path` 与 local parity。

最终 focused integration：

```bash
cd packages/cli
bun x vitest run --config vitest.config.ts --project=integration \
  tests/integration/tool-executor.test.ts \
  tests/integration/acp-remote-file-tools.test.ts \
  tests/integration/apply-patch-tool.test.ts \
  tests/integration/apply-patch-transaction.test.ts \
  tests/integration/apply-patch-recovery.test.ts \
  --reporter=dot
```

```text
Test Files  5 passed (5)
Tests       190 passed (190)
```

覆盖 ToolExecutor、paired ACP remote Read/Write/Edit、ApplyPatch planning、transaction 与
crash recovery。

静态与构建门禁：

```bash
bun run format:check && bun run lint && bun run type-check && bun run build
git diff --check
```

```text
bun run format:check  PASS
bun run lint          PASS
bun run type-check    PASS
bun run build         PASS
git diff --check      PASS
```

完整仓库测试：

```bash
bun run test:all
```

```text
Main test projects: 474 files passed, 94 skipped
Main tests:         5481 passed, 84 skipped
Duration:           318.36s
Performance:        4 files passed, 1 skipped
Performance tests:  9 passed, 1 skipped
Duration:           5.21s
```

## 真实 API 与 Surface 非干扰

直接相关的 paired ACP remote filesystem 真实 API 轨迹：

```bash
cd packages/cli
REAL_API_TEST=1 REAL_API_RELEASE_MATRIX=1 \
  bun x vitest run --config vitest.config.ts --project=real-api \
  tests/integration/real-api/acp-remote-filesystem-trajectory.test.ts \
  --retry=0 --reporter=verbose
```

| 模型 | 结果 | 时长 | Framework retry |
| --- | --- | ---: | ---: |
| `deepseek-v4-flash` | 通过 | 4.910s | 0 |
| `deepseek-v4-pro` | 通过 | 5.454s | 0 |

共享 runtime 的 production surface 非干扰轨迹：

```bash
cd packages/cli
REAL_API_TEST=1 bun x vitest run --config vitest.config.ts \
  --project=real-api \
  tests/integration/real-api/foreground-bounded-output-trajectory.test.ts \
  --retry=0 -t "× '(pty|web)'" --reporter=verbose
```

| Surface | 模型 | 结果 | 时长 | Framework retry |
| --- | --- | --- | ---: | ---: |
| raw PTY TUI | `deepseek-v4-flash` | 通过 | 27.087s | 0 |
| Chromium Web GUI | `deepseek-v4-flash` | 通过 | 26.877s | 0 |
| raw PTY TUI | `deepseek-v4-pro` | 通过 | 29.122s | 0 |
| Chromium Web GUI | `deepseek-v4-pro` | 通过 | 26.318s | 0 |

这四个 surface 单元格证明共享 ToolExecutor 变更未破坏现有 TUI/Web 真实执行与恢复；
新增 generic-path 分支本身由上述 causal RED/GREEN 和 paired ACP integration 证明，不能
把 surface 非干扰结果误写成模型主动调用动态 generic-path MCP 工具。

## 审查

两位独立 reviewer 均对 exact candidate
`6a36896df7eaf8f5c58e1278c91c1c912e72d184` 给出 `APPROVED`：

- 规格复审：Critical `0`、Important `0`、Minor `0`；
- 质量 / 安全 / 并发复审：Critical `0`、Important `0`、Minor `0`。

早期候选 `3725b248` 的规格复审曾发现 concurrency-safe MCP `file_path` 漏检，
主线程按反馈先复现 RED，再由 `fd4bbb19` 闭合；`6a36896d` 又补上
`affectedPaths()` 异常脱敏。旧 SHA 的结论未作为最终证据。

## 证据边界

- 没有输出、保存或提交 Provider credential。
- 被拒绝的 raw remote path 不进入错误、metadata、模型结果或用户 surface。
- `executionStarted` 与 ToolExecutor 内存 history 保持既有内部诊断契约；当前无生产
  consumer 将其投影到日志或用户 surface。本 patch 不扩大该事件 API。
- 本 patch 不新增 remote capability，不改变内置 `ApplyPatch` 的事务语义，也不修改
  GUI/TUI 交互。

## 当前候选源码哈希

```text
ToolExecutor.ts
aa52cfd2cf0f57353248b662a8ad5d4e804412cf825e419913431dca216e4715

tool-executor-filelock.test.ts
6e9a88bc74a16abdc8fd9f954189e7b2a1c65310a5e51f91a74f2e29a2253e47
```

最终 evidence-only / release metadata 修改后，这两个 production/test 文件哈希必须保持
不变；否则所有资格结果失效并需重新运行。
