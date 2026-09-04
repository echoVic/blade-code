# ACP Remote 通用工具路径前置校验设计

状态：已根据既有 `v0.10.128` 发布审查结论收敛

## 背景

Blade 已经在 ACP remote workspace 中对 `Read`、`Write`、`Edit` 的
`file_path` / `notebook_path` 做路径语法前置校验，并为 `ApplyPatch` 提供专用
preflight。当前通用 `ToolExecutor` 边界仍只识别上述固定字段：工具通过
`affectedPaths()` 声明的路径，或写工具使用通用 `path` 字段时，不会进入同一
remote path gate。

这不是扩大 ACP remote 工具能力的需求，而是对已允许工具的 defense-in-depth。
未来 builtin 或动态 MCP 工具若声明新的路径参数，必须在 permission、hook、
scheduler、lock、tool invocation 或 ACP I/O 之前经过 frozen remote path style 校验。

## 目标

1. 对 ACP remote 工具调用收集并校验全部声明路径。
2. 保留现有 `file_path` / `notebook_path` 兼容行为。
3. 对 `ToolKind.Write` 的通用 `path` 字段提供窄 fallback。
4. 将 `invocation.getAffectedPaths()` 视为工具显式声明的路径权威，并校验其中每一项。
5. 初始 schema-cloned invocation 与 hook 改写后的 invocation 都使用同一校验器。
6. 任一路径非法时返回固定、脱敏的 `acp_remote_path_invalid`，且在任何外部副作用前停止。
7. local 与 ACP-local 执行语义保持不变。

## 非目标

- 不新增 ACP capability。
- 不让当前 host-only builtin 在 remote workspace 可用。
- 不把任意 readonly 工具的业务 `path` 字段自动解释为文件路径。
- 不替代 `ApplyPatch` 的事务级 remote preflight。
- 不改变本地 worktree containment。
- 不在错误、metadata、日志或 surface 中回显被拒绝的原始路径。

## 方案

### 路径来源

`ToolExecutor` 在 schema validation 生成 immutable invocation 后收集：

- 现有单文件契约中的 `file_path` / `notebook_path`；
- `ToolKind.Write` 的字符串 `path`；
- `invocation.getAffectedPaths()` 返回的每个字符串。

`affectedPaths()` 是显式工具契约，因此不受工具 kind 或并发属性限制。通用
`path` fallback 只用于 `ToolKind.Write`，避免把 readonly MCP 工具中的 URL、资源名
或其他业务标识误判成文件路径。空数组表示工具没有声明通用文件目标。
`ApplyPatch` 是唯一显式例外：它的 `affectedPaths()` 按工具协议返回相对 patch 路径，
并由事务层的 `preflightRemotePatchTransaction()` 结合 remote workspace root 做专用校验；
通用绝对路径 gate 不消费这些相对值。

### 执行顺序

初始调用顺序保持为：

1. runtime-owned workspace/capability policy；
2. TypeBox schema validation 与参数快照；
3. remote declared-path validation；
4. concurrency gate；
5. worktree、permission 与 hook；
6. hook 如改写输入，重新执行 declared-path validation；
7. scheduler、file lock、tool invocation 与 ACP I/O。

校验始终使用 `workspaceToolPolicy.pathStyle`，不接受 caller context 选择 path style。
所有候选逐项调用 `parseAcpRemotePath()`；任何 `AcpRemotePathError` 都映射为统一
`ToolResult`。`affectedPaths()` 自身抛出的错误也 fail closed 为同一个固定结果，避免
不可信工具定义通过异常消息回显 raw remote path。

### 结果语义

非法路径结果保持：

- `error.code = 'acp_remote_path_invalid'`；
- 无 `error.details`；
- 无 raw `file_path` / `path` metadata；
- `ToolKind.Write` / `ToolKind.Execute` 返回 `sideEffectsUncertain: false`，因为工具尚未启动；
- `ToolKind.ReadOnly` 不附加 mutation metadata。

## 测试

因果 RED 必须覆盖：

1. remote write MCP 工具仅使用通用 `path`，非法 Win32 ADS spelling 被拒绝；
2. remote tool 仅通过 `affectedPaths()` 暴露非法路径时被拒绝；
3. 多路径声明中后续路径非法时仍 fail closed；
4. hook 改写后的 `affectedPaths()` 重新校验；
5. 拒绝发生前 hook（初始路径）、scheduler、host/opaque lock、invocation、ACP I/O 均为零；
6. readonly MCP 的未声明业务 `path` 保持可用；
7. local executor 对同一字符串保持既有行为。
8. `affectedPaths()` 抛出包含原始路径的异常时，返回固定脱敏错误。

完成门禁包括 focused unit/integration、TypeScript、Biome、`git diff --check`、全仓测试与
现有 ACP remote real-API qualification。该 patch 不增加新的 UI 状态；CLI/TUI、Web、
Headless 与 ACP 都通过共享 `ToolExecutor` 获得同一前置保护。
