# Bounded Foreground Shell Output Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox `- [ ]` syntax for tracking.

**Goal:** 为 Blade 的前台 Bash 建立每流 1 MiB 的真实字节级内存上限，并让 CLI/TUI、Headless、Web 与 ACP 使用同一安全投影和真实发布资格。

**Architecture:** BoundedOutputBuffer 负责原始字节尾保留，ShellOutputCapture 负责双流累计事实，ShellOutputProjection 负责模型可见结果和结构化统计。ToolResult 仍是唯一 canonical 数据；持久化恢复、TUI、Headless、Web 与 ACP 都从它投影。发布资格通过 DeepSeek Flash/Pro × Chromium/raw PTY/ACP SDK 六格真实入口验证。

**Tech Stack:** TypeScript 5.9、Bun 1.3、Vitest 4、React 19、Ink、Hono、Agent Client Protocol SDK、Playwright Chromium、bun-pty。

---

## 执行前置

- [ ] 调用 superpowers:using-git-worktrees，在仓库内创建隔离 worktree：

~~~bash
git worktree add .worktrees/bounded-foreground-shell-output -b feat/bounded-foreground-shell-output main
~~~

预期：新 worktree 基于包含规格和本计划的 main；主 checkout 不承载生产代码编辑。

- [ ] 在 worktree 中核对基线与依赖：

~~~bash
git status --short --branch
git log -3 --oneline
bun install --frozen-lockfile
~~~

预期：工作树干净；HEAD 包含设计和计划提交；安装退出 0。

- [ ] 运行最小基线，证明后续 RED 来自新测试：

~~~bash
bun run --filter blade-code type-check
(cd packages/cli && bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/tooling/tools/builtin/shell/bounded-output-buffer.test.ts \
  tests/unit/tooling/tools/OutputTruncator.test.ts \
  tests/unit/tooling/tools/builtin/bash.test.ts)
~~~

预期：现有测试全部 PASS。若基线失败，先记录并修复基线，不把失败混入本 feature。

## 文件职责锁定

新增生产文件：

- packages/cli/src/tools/builtin/shell/ShellOutputCapture.ts：双流原始字节 capture、UTF-16 累计和 accounting completeness。
- packages/cli/src/tools/builtin/shell/ShellOutputProjection.ts：capture → 模型 payload、metadata facts 和安全 error preview。
- packages/cli/src/tools/display/ToolResultProjector.ts：durable payload → ToolResult，以及 surface 字符预算。
- packages/cli/scripts/browser-check.ts：无网络 Chromium executable preflight。

新增测试支持文件：

- packages/cli/tests/support/acp/createPairedAcpHarness.ts：真实 ACP SDK 双向 NDJSON harness。
- packages/cli/tests/support/acp/ControlledTerminalClient.ts：typed deterministic terminal client。
- packages/cli/tests/support/acp/ChildBackedRecordingAcpClient.ts：真实 child-backed ACP terminal client。
- packages/cli/tests/integration/real-api/foregroundBoundedOutputFixture.ts：精确双流 fixture 与 prompt。
- packages/cli/tests/integration/real-api/foregroundBoundedOutputHarness.ts：durable trace、lease、secret 和 cleanup 断言。
- packages/cli/tests/support/foregroundBoundedOutputPtyRunner.ts：raw PTY driver。
- packages/cli/tests/support/launch-foreground-bounded-output-gui.ts：production Web launcher。
- packages/cli/tests/integration/real-api/foreground-bounded-output-trajectory.test.ts：六格真实 API matrix。

现有文件只按职责修改；不移动无关 formatter，不重写 Agent loop，不新增 LoopEvent 或 ACP 私有协议。

### Task 1: Harden the raw byte tail buffer

**Files:**
- Modify: packages/cli/src/tools/builtin/shell/BoundedOutputBuffer.ts
- Modify: packages/cli/src/tools/builtin/shell/BackgroundShellManager.ts
- Test: packages/cli/tests/unit/tooling/tools/builtin/shell/bounded-output-buffer.test.ts
- Create: packages/cli/tests/performance/benchmarks/bounded-output-buffer.test.ts

- [ ] **Step 1: 写失败的字节边界、超大 chunk、UTF-8 和 chunk-count 测试**

在 bounded-output-buffer.test.ts 添加真实 Buffer 测试：

~~~ts
it('retains only the tail of one oversized Buffer', () => {
  const buffer = new BoundedOutputBuffer(5);
  buffer.append(Buffer.from('PREFIX-tail'));

  expect(buffer.peek()).toEqual({
    content: '-tail',
    retainedBytes: 5,
    omittedBytes: 6,
    totalBytes: 11,
  });
});

it('realigns after dropping a complete chunk', () => {
  const buffer = new BoundedOutputBuffer(4);
  buffer.append(Buffer.from([0x61, 0x62]));
  buffer.append(Buffer.from([0x82, 0xac, 0x5a]));
  buffer.append(Buffer.from('Q'));

  const snapshot = buffer.peek();
  expect(snapshot.content.startsWith('\uFFFD')).toBe(false);
  expect(snapshot.totalBytes).toBe(snapshot.retainedBytes + snapshot.omittedBytes);
});

it('compacts retained chunks to a constant object bound', () => {
  const buffer = new BoundedOutputBuffer(1024);
  for (let index = 0; index < 10_000; index += 1) {
    buffer.append(Buffer.from('a'));
  }
  expect(buffer.retainedChunkCountForTests()).toBeLessThanOrEqual(32);
});
~~~

在 performance test 中追加 64 MiB：

~~~ts
it('keeps retained storage bounded across 64 MiB', () => {
  const buffer = new BoundedOutputBuffer(1024 * 1024);
  const chunk = Buffer.alloc(64 * 1024, 0x61);
  for (let index = 0; index < 1024; index += 1) buffer.append(chunk);

  const snapshot = buffer.peek();
  expect(snapshot.retainedBytes).toBeLessThanOrEqual(1024 * 1024);
  expect(snapshot.totalBytes).toBe(64 * 1024 * 1024);
  expect(buffer.retainedChunkCountForTests()).toBeLessThanOrEqual(32);
});
~~~

- [ ] **Step 2: 运行测试确认 RED**

~~~bash
(cd packages/cli && bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/tooling/tools/builtin/shell/bounded-output-buffer.test.ts)
~~~

预期：FAIL，提示 retainedBytes 或 retainedChunkCountForTests 不存在，或跨 chunk UTF-8 断言失败。

- [ ] **Step 3: 最小实现 raw-byte tail 和常数 chunk 数**

将 snapshot 扩展为：

~~~ts
export const BACKGROUND_SHELL_OUTPUT_MAX_BYTES = 1024 * 1024;
export const FOREGROUND_SHELL_OUTPUT_MAX_BYTES = 1024 * 1024;

export interface BoundedOutputSnapshot {
  content: string;
  retainedBytes: number;
  omittedBytes: number;
  totalBytes: number;
}
~~~

append 必须：直接使用输入 Buffer；大 chunk 先取 tail；trim 后再次对新首 chunk 对齐；超过 32 chunks 时合并 retained chunks。暴露仅供测试的只读方法：

~~~ts
/** @internal */
retainedChunkCountForTests(): number {
  return this.chunks.length;
}
~~~

- [ ] **Step 4: 让后台 shell 传原始 Buffer**

删除 BackgroundShellManager 对 stdout/stderr 的 setEncoding('utf8')，监听器保留真实联合类型：

~~~ts
child.stdout?.on('data', (chunk: Buffer | string) => {
  processInfo.pendingStdout.append(chunk);
});
child.stderr?.on('data', (chunk: Buffer | string) => {
  processInfo.pendingStderr.append(chunk);
});
~~~

- [ ] **Step 5: 运行 unit、performance 与后台回归确认 GREEN**

~~~bash
(cd packages/cli && bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/tooling/tools/builtin/shell/bounded-output-buffer.test.ts \
  tests/unit/tooling/tools/builtin/task-output.test.ts \
  tests/unit/platform/ui/utils/tool-formatters.test.ts)
(cd packages/cli && bunx vitest run --config vitest.config.ts --project=performance \
  tests/performance/benchmarks/bounded-output-buffer.test.ts)
~~~

预期：全部 PASS；retained bytes ≤ 1 MiB；chunk count ≤ 32；旧 consume lifetime total
语义与后台 TaskOutput/formatter 均不退化。付费资格只声称本 feature 的前台六格；不把
未列入 fixed matrix 的后台真实轨迹写成已执行证据。

- [ ] **Step 6: 提交 Task 1**

~~~bash
git add packages/cli/src/tools/builtin/shell/BoundedOutputBuffer.ts \
  packages/cli/src/tools/builtin/shell/BackgroundShellManager.ts \
  packages/cli/tests/unit/tooling/tools/builtin/shell/bounded-output-buffer.test.ts \
  packages/cli/tests/performance/benchmarks/bounded-output-buffer.test.ts
git commit -m 'feat(shell): harden bounded output byte retention'
~~~

### Task 2: Add the shared two-stream capture

**Files:**
- Create: packages/cli/src/tools/builtin/shell/ShellOutputCapture.ts
- Create: packages/cli/tests/unit/tooling/tools/builtin/shell/shell-output-capture.test.ts

- [ ] **Step 1: 写双流、split UTF-8、幂等 finish 和 incomplete accounting 测试**

~~~ts
it('tracks bytes and UTF-16 characters across split chunks', () => {
  const capture = new ShellOutputCapture(5);
  const emoji = Buffer.from('😀');
  capture.append('stdout', emoji.subarray(0, 2));
  capture.append('stdout', emoji.subarray(2));
  capture.append('stderr', Buffer.from('warning'));
  capture.finish();

  const snapshot = capture.snapshot();
  expect(snapshot.stdout.totalChars).toBe(2);
  expect(snapshot.stdout.totalBytes).toBe(4);
  expect(snapshot.stdout.content).toBe('😀');
  expect(snapshot.stderr.totalBytes).toBe(7);
});

it('tracks independent stream budgets', () => {
  const capture = new ShellOutputCapture(4);
  capture.append('stdout', Buffer.from('AAAA-tail'));
  capture.append('stderr', Buffer.from('BBBB-end'));
  capture.finish();
  const snapshot = capture.snapshot();
  expect(snapshot.stdout.content).toBe('tail');
  expect(snapshot.stderr.content).toBe('-end');
});
~~~

- [ ] **Step 2: 运行测试确认 RED**

~~~bash
(cd packages/cli && bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/tooling/tools/builtin/shell/shell-output-capture.test.ts)
~~~

预期：FAIL，模块或导出不存在。

- [ ] **Step 3: 创建 capture 类型与实现**

固定 public internal API：

~~~ts
export type ShellOutputStream = 'stdout' | 'stderr';

export interface ShellOutputStreamSnapshot {
  content: string;
  totalBytes: number;
  retainedBytes: number;
  omittedBytes: number;
  totalChars: number;
  accountingComplete: boolean;
}

export interface ShellOutputCaptureSnapshot {
  stdout: ShellOutputStreamSnapshot;
  stderr: ShellOutputStreamSnapshot;
  terminalOutputMerged: boolean;
}

export class ShellOutputCapture {
  constructor(maxBytes?: number, terminalOutputMerged?: boolean);
  append(stream: ShellOutputStream, chunk: string | Buffer): void;
  markAccountingIncomplete(): void;
  finish(): void;
  snapshot(): ShellOutputCaptureSnapshot;
}
~~~

每流用 BoundedOutputBuffer 保存 raw bytes，用 StringDecoder('utf8') 只累计 totalChars；finish 幂等，markAccountingIncomplete 同时标记两流。

- [ ] **Step 4: 运行测试和类型检查确认 GREEN**

~~~bash
(cd packages/cli && bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/tooling/tools/builtin/shell/shell-output-capture.test.ts)
bun run --filter blade-code type-check
~~~

预期：PASS；无 any、as any 或 as never。

- [ ] **Step 5: 提交 Task 2**

~~~bash
git add packages/cli/src/tools/builtin/shell/ShellOutputCapture.ts \
  packages/cli/tests/unit/tooling/tools/builtin/shell/shell-output-capture.test.ts
git commit -m 'feat(shell): add shared foreground output capture'
~~~

### Task 3: Define model projection and metadata facts

**Files:**
- Create: packages/cli/src/tools/builtin/shell/ShellOutputProjection.ts
- Modify: packages/cli/src/tools/builtin/shell/OutputTruncator.ts
- Modify: packages/cli/src/tools/types/ToolTypes.ts
- Test: packages/cli/tests/unit/tooling/tools/OutputTruncator.test.ts
- Create: packages/cli/tests/unit/tooling/tools/builtin/shell/shell-output-projection.test.ts

- [ ] **Step 1: 写 surrogate-safe、capture omission 与双流 projection 测试**

~~~ts
it('labels omitted earliest output and preserves retained tails', () => {
  const projected = projectShellOutput(makeCaptureSnapshot({
    stdoutContent: 'STDOUT_TAIL',
    stderrContent: 'STDERR_TAIL',
    stdoutOmittedBytes: 65_536,
    stderrOmittedBytes: 65_536,
  }), 'node fixture.mjs');

  expect(projected.stdout).toContain('STDOUT_TAIL');
  expect(projected.stderr).toContain('STDERR_TAIL');
  expect(projected.truncationInfo).toContain('earliest');
  expect(projected.truncationInfo).toContain('retained tail');
});
~~~

在 OutputTruncator.test.ts 添加 emoji 边界，断言结果不以孤立 surrogate 开始或结束。

- [ ] **Step 2: 运行测试确认 RED**

~~~bash
(cd packages/cli && bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/tooling/tools/OutputTruncator.test.ts \
  tests/unit/tooling/tools/builtin/shell/shell-output-projection.test.ts)
~~~

预期：FAIL，projectShellOutput 不存在或 surrogate 断言失败。

- [ ] **Step 3: 创建 projection API**

~~~ts
export interface ProjectedShellOutput {
  stdout: string;
  stderr: string;
  truncationInfo?: string;
  captureTruncated: boolean;
  projectionTruncated: boolean;
  stdoutProjectionTruncated: boolean;
  stderrProjectionTruncated: boolean;
  snapshot: ShellOutputCaptureSnapshot;
}

export function projectShellOutput(
  capture: ShellOutputCaptureSnapshot,
  command: string
): ProjectedShellOutput;
~~~

实现必须先对 retained tail 做兼容的 trim，再调用 OutputTruncator；capture omission 与 projection truncation 合并为一次提示。OutputTruncator 的字符裁剪使用不拆 surrogate 的 helper。

- [ ] **Step 4: additive 扩展 BashForegroundMetadata**

加入规格固定字段：capture_truncated、projection_truncated、output_truncated、每流 total/retained/omitted bytes、raw_output_bytes、每流 projection flag、output_accounting_complete、terminal_transport、terminal_output_merged。stdout_length/stderr_length 仍表示完整 UTF-16 code units。

- [ ] **Step 5: 运行投影测试、类型检查与 lint**

~~~bash
(cd packages/cli && bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/tooling/tools/OutputTruncator.test.ts \
  tests/unit/tooling/tools/builtin/shell/shell-output-projection.test.ts)
bun run --filter blade-code type-check
bun run --filter blade-code lint
~~~

预期：全部 PASS，无破坏性 ToolResult 顶层变化。

- [ ] **Step 6: 提交 Task 3**

~~~bash
git add packages/cli/src/tools/builtin/shell/ShellOutputProjection.ts \
  packages/cli/src/tools/builtin/shell/OutputTruncator.ts \
  packages/cli/src/tools/types/ToolTypes.ts \
  packages/cli/tests/unit/tooling/tools/OutputTruncator.test.ts \
  packages/cli/tests/unit/tooling/tools/builtin/shell/shell-output-projection.test.ts
git commit -m 'feat(shell): define bounded output projection facts'
~~~

### Task 4: Route every native Bash terminal branch through bounded capture

**Files:**
- Modify: packages/cli/src/tools/builtin/shell/bash.ts
- Test: packages/cli/tests/unit/tooling/tools/builtin/bash.test.ts
- Test: packages/cli/tests/integration/process-tree-lifecycle.test.ts
- Test: packages/cli/tests/integration/workspace-write-sandbox.test.ts

- [ ] **Step 1: 写 success、nonzero、timeout、abort 和 raw-progress RED tests**

在 bash.test.ts 增加真实 child command。用 JSON.stringify(process.execPath) 和
JSON.stringify(program) shell-quote Node program。核心断言：

~~~ts
it('never forwards native command output through progress', async () => {
  const progress = vi.fn<(message: string) => void>();
  const sentinel = 'MUST_NOT_ENTER_PROGRESS';
  const program = [
    'process.stdout.write(',
    JSON.stringify(sentinel),
    ')',
  ].join('');
  const command = [
    JSON.stringify(process.execPath),
    '-e',
    JSON.stringify(program),
  ].join(' ');
  const result = await bashTool.execute(
    { command, timeout: 10_000, env: {}, run_in_background: false },
    undefined,
    { updateOutput: progress }
  );
  expect(result.success).toBe(true);
  expect(progress.mock.calls.flat().join('\n')).not.toContain(sentinel);
});
~~~

成功大 stdout 用例断言 omitted prefix 不存在、tail 存在、retained bytes 不超过
1 MiB。另加非零大 stderr、双流独立预算、timeout/abort 顶层 llmContent 仍为 string。

- [ ] **Step 2: 运行 Bash unit tests 确认 RED**

~~~bash
(cd packages/cli && bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/tooling/tools/builtin/bash.test.ts)
~~~

预期：大输出 prefix 仍进入结果，metadata stats 缺失。

- [ ] **Step 3: 将 executeWithTimeout 接到 capture/projector**

用 ShellOutputCapture 取代 stdout/stderr 字符串；data handler 追加 Buffer。抽取单一
result builder，确保 success/nonzero 返回对象，timeout/abort 返回原固定 string，
error.message 只用安全 projection，未启动 failure 无 capture facts，progress 不发 output。

- [ ] **Step 4: 扩展 process lifecycle 的 admission/finalization tests**

沿用现有 fault injection。lease register failure 断言没有 accounting；release 和
finalization failure 先输出大 prefix/tail，断言 metadata 只含 tail 和 stats。保持现有
结果优先级。

- [ ] **Step 5: 扩展 sandbox runtime failure test**

test backend 产生超过 1 MiB stderr，识别 marker 放尾部；断言 error.message 和 metadata
不含 prefix。prepare unavailable/boundary 仍无 output facts。

- [ ] **Step 6: 运行 focused unit/integration tests 确认 GREEN**

~~~bash
(cd packages/cli && bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/tooling/tools/builtin/bash.test.ts)
(cd packages/cli && bunx vitest run --config vitest.config.ts --project=integration \
  tests/integration/process-tree-lifecycle.test.ts \
  tests/integration/workspace-write-sandbox.test.ts)
bun run --filter blade-code type-check
~~~

预期：全部 PASS，进程树和 lease 旧断言不退化。

- [ ] **Step 7: 提交 Task 4**

~~~bash
git add packages/cli/src/tools/builtin/shell/bash.ts \
  packages/cli/tests/unit/tooling/tools/builtin/bash.test.ts \
  packages/cli/tests/integration/process-tree-lifecycle.test.ts \
  packages/cli/tests/integration/workspace-write-sandbox.test.ts
git commit -m 'fix(shell): bound every native Bash terminal branch'
~~~

### Task 5: Bound and classify TerminalService output

**Files:**
- Modify: packages/cli/src/acp/AcpServiceContext.ts
- Create: packages/cli/tests/support/acp/createPairedAcpHarness.ts
- Create: packages/cli/tests/support/acp/ControlledTerminalClient.ts
- Test: packages/cli/tests/unit/agent-runtime/acp/service-context.test.ts

- [ ] **Step 1: 创建 typed ACP harness 并移除 as never**

ControlledTerminalClient 直接 implements acp.Client，terminal request/response 使用 SDK
类型；createPairedAcpHarness 返回真实 ClientSideConnection、AgentSideConnection 和
close。把 service-context.test.ts 的 as never 改成完整 capabilities 与真实 connection。
创建文件前先执行：

~~~bash
mkdir -p packages/cli/tests/support/acp
~~~

- [ ] **Step 2: 写串行 polling、merged output、incomplete 与 fallback RED tests**

~~~ts
it('serializes cumulative terminal output reads', async () => {
  const client = new ControlledTerminalClient();
  const harness = createPairedAcpHarness(client);
  AcpServiceContext.initializeSession(
    harness.agentConnection,
    'acp-shell',
    { terminal: true },
    '/workspace'
  );
  client.enqueueOutput({ output: 'a', truncated: false });
  client.enqueueOutput({ output: 'ab', truncated: false });
  client.complete({ exitCode: 0 });
  const result = await getTerminalService('acp-shell').execute('fixture', {
    cwd: '/workspace',
    allowLocalFallback: false,
  });
  expect(client.maxConcurrentOutputReads).toBe(1);
  expect(result).toMatchObject({
    stdout: 'ab',
    stderr: '',
    transport: 'acp',
    capture: { terminalOutputMerged: true },
  });
});
~~~

另加 SDK truncated=true、长度回退、poll fail + final success、final fail、timeout、abort、
explicit fallback tests。

- [ ] **Step 3: 运行 service tests 确认 RED**

~~~bash
(cd packages/cli && bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/agent-runtime/acp/service-context.test.ts)
~~~

预期：FAIL，transport/failureKind/capture 不存在，或并发读取大于 1。

- [ ] **Step 4: additive 扩展 TerminalService contract**

~~~ts
export type TerminalFailureKind =
  | 'timeout'
  | 'aborted'
  | 'admission'
  | 'finalization'
  | 'unavailable'
  | 'spawn';
export type TerminalTransport = 'local' | 'acp' | 'local_fallback';
export interface TerminalExecuteResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  error?: string;
  failureKind?: TerminalFailureKind;
  transport: TerminalTransport;
  capture?: ShellOutputCaptureSnapshot;
}
~~~

- [ ] **Step 5: 改造 LocalTerminalService 与 AcpTerminalService**

Local service 使用双流 capture。Remote service 使用串行 single-pending poll；SDK
truncated、长度回退或读取失败标 incomplete；最终 output 成功时重建 complete merged
capture。timeout/abort 返回前 await kill + release；只有显式 fallback 才执行 local。

- [ ] **Step 6: 运行 ACP unit tests、type-check 和 lint 确认 GREEN**

~~~bash
(cd packages/cli && bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/agent-runtime/acp/service-context.test.ts)
bun run --filter blade-code type-check
bun run --filter blade-code lint
~~~

预期：PASS；新增 helper 和测试无 as any/as never。

- [ ] **Step 7: 提交 Task 5**

~~~bash
git add packages/cli/src/acp/AcpServiceContext.ts \
  packages/cli/tests/support/acp/createPairedAcpHarness.ts \
  packages/cli/tests/support/acp/ControlledTerminalClient.ts \
  packages/cli/tests/unit/agent-runtime/acp/service-context.test.ts
git commit -m 'refactor(acp): bound and classify terminal output'
~~~

### Task 6: Make ACP Bash fail closed and keep raw output out of progress

**Files:**
- Modify: packages/cli/src/tools/builtin/shell/bash.ts
- Modify: packages/cli/src/acp/Session.ts
- Test: packages/cli/tests/unit/tooling/tools/builtin/bash.test.ts
- Test: packages/cli/tests/unit/agent-runtime/acp/session.test.ts

- [ ] **Step 1: 写真实 AcpServiceContext Bash adapter RED tests**

用 Task 5 typed harness 初始化 session，执行 bashTool。断言 createTerminal 收到精确
command/cwd，generic progress 不含 raw sentinel，llmContent 有
terminal_output_merged=true。另加 createTerminal failure，断言本地 fallback 未执行；
timeout/abort 按 failureKind 映射。

- [ ] **Step 2: 运行 Bash + ACP session tests 确认 RED**

~~~bash
(cd packages/cli && bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/tooling/tools/builtin/bash.test.ts \
  tests/unit/agent-runtime/acp/session.test.ts)
~~~

预期：FAIL，Bash 漏传 allowLocalFallback=false 或 progress 含 raw output。

- [ ] **Step 3: 最小接线 ACP Bash adapter**

terminalService.execute 显式传 allowLocalFallback: false 并省略 onOutput；用 failureKind
分类；用 capture/projector 构造 ToolResult。user-shell executor 保留 onOutput，但
timedOut/aborted 改用 failureKind。

- [ ] **Step 4: 运行 focused tests 确认 GREEN**

~~~bash
(cd packages/cli && bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/tooling/tools/builtin/bash.test.ts \
  tests/unit/agent-runtime/acp/service-context.test.ts \
  tests/unit/agent-runtime/acp/session.test.ts)
~~~

预期：PASS；remote ACP failure 不执行宿主命令。

- [ ] **Step 5: 提交 Task 6**

~~~bash
git add packages/cli/src/tools/builtin/shell/bash.ts \
  packages/cli/src/acp/Session.ts \
  packages/cli/tests/unit/tooling/tools/builtin/bash.test.ts \
  packages/cli/tests/unit/agent-runtime/acp/session.test.ts
git commit -m 'fix(bash): fail closed for ACP terminal execution'
~~~

### Task 7: Add the canonical live and durable ToolResult projector

**Files:**
- Create: packages/cli/src/tools/display/ToolResultProjector.ts
- Modify: packages/cli/src/ui/utils/toolFormatters.ts
- Test: packages/cli/tests/unit/platform/ui/utils/tool-formatters.test.ts

- [ ] **Step 1: 写 durable output=null、失败诊断、双流 tail 和 suffix RED tests**

~~~ts
it('projects failed durable output null without rendering null', () => {
  const restored = projectDurableToolResult({
    toolName: 'Bash',
    output: null,
    error: 'Command interrupted because Blade restarted',
    metadata: { processRestartRecovery: true },
  });
  const display = formatToolDisplay('Bash', restored);
  expect(display.status).toBe('fail');
  expect(renderToolDisplayToString(display)).toContain('Blade restarted');
  expect(renderToolDisplayToString(display)).not.toContain('null');
});

it('keeps both stream tails and one truncation suffix', () => {
  const display = formatToolDisplay('Bash', makeBoundedBashResult());
  expect(display.detail).toContain('stdout:');
  expect(display.detail).toContain('STDOUT_TAIL');
  expect(display.detail).toContain('stderr:');
  expect(display.detail).toContain('STDERR_TAIL');
  expect(display.detail?.split('Output truncated')).toHaveLength(2);
});
~~~

另加单行超长 output 和 surrogate boundary tests。

- [ ] **Step 2: 运行 formatter tests 确认 RED**

~~~bash
(cd packages/cli && bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/platform/ui/utils/tool-formatters.test.ts)
~~~

预期：FAIL，durable projector 不存在；失败 detail 为空；Bash 丢 stderr/tail。

- [ ] **Step 3: 创建 projector 类型与纯函数**

创建文件前先执行：

~~~bash
mkdir -p packages/cli/src/tools/display
~~~

~~~ts
export interface DurableToolResultPayload {
  toolCallId?: string;
  toolName?: string;
  output?: unknown | null;
  error?: unknown | null;
  metadata?: unknown;
}

export function projectDurableToolResult(
  payload: DurableToolResultPayload
): ToolResult;

export function fitToolDisplayForSurface(
  display: ToolDisplayOutput,
  maxChars: number
): ToolDisplayOutput;
~~~

projectDurableToolResult 不得 stringify null；error 存在时 success=false。fit helper 按
stdout tail、stderr tail、suffix 分配预算并保持 suffix 最后一行。

- [ ] **Step 4: 重写 Bash display branch**

失败结果允许安全 detail；stdout/stderr 分段带标签；每流保留 tail；truncation notice
恰好一次。formatToolDisplay 从原路径继续导出，其他 formatter 不移动。

- [ ] **Step 5: 运行 formatter tests、type-check 确认 GREEN**

~~~bash
(cd packages/cli && bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/platform/ui/utils/tool-formatters.test.ts)
bun run --filter blade-code type-check
~~~

预期：PASS，detail ≤ 指定 surface budget，omitted sentinel 不出现。

- [ ] **Step 6: 提交 Task 7**

~~~bash
git add packages/cli/src/tools/display/ToolResultProjector.ts \
  packages/cli/src/ui/utils/toolFormatters.ts \
  packages/cli/tests/unit/platform/ui/utils/tool-formatters.test.ts
git commit -m 'refactor(tool-display): add canonical result projector'
~~~

### Task 8: Project bounded results through TUI, Headless and live ACP

**Files:**
- Modify: packages/cli/src/ui/utils/loopEventHandler.ts
- Modify: packages/cli/src/commands/headless.ts
- Modify: packages/cli/src/acp/Session.ts
- Test: packages/cli/tests/unit/platform/ui/utils/loopEventHandler.test.ts
- Test: packages/cli/tests/unit/cli/headless.test.ts
- Test: packages/cli/tests/unit/cli/headless-events.test.ts
- Test: packages/cli/tests/unit/agent-runtime/acp/session.test.ts

- [ ] **Step 1: 写三个 surface 的 RED contract tests**

TUI 断言 truncation suffix 最后一行且 resize/update 不重复；Headless 断言一个 v1
tool_result 后最多一个 tool_detail，text detail 只写 stderr；ACP 断言标准
tool_call_update content 使用相同 bounded display，session/load 不 replay tools。

- [ ] **Step 2: 运行 tests 确认 RED**

~~~bash
(cd packages/cli && bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/platform/ui/utils/loopEventHandler.test.ts \
  tests/unit/cli/headless.test.ts \
  tests/unit/cli/headless-events.test.ts \
  tests/unit/agent-runtime/acp/session.test.ts)
~~~

预期：Bash suffix 或失败 detail 缺失；现有 event schema 本身保持可解析。

- [ ] **Step 3: 只接 canonical formatter，不加新协议**

所有路径调用 formatToolDisplay + fitToolDisplayForSurface。不得修改 Headless event
version，不新增 ACP _meta，不改变 ACP session/load replay policy。

- [ ] **Step 4: 运行 tests 确认 GREEN**

~~~bash
(cd packages/cli && bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/platform/ui/utils/loopEventHandler.test.ts \
  tests/unit/cli/headless.test.ts \
  tests/unit/cli/headless-events.test.ts \
  tests/unit/agent-runtime/acp/session.test.ts)
~~~

预期：PASS；Headless v1 golden shape 不变。

- [ ] **Step 5: 提交 Task 8**

~~~bash
git add packages/cli/src/ui/utils/loopEventHandler.ts \
  packages/cli/src/commands/headless.ts \
  packages/cli/src/acp/Session.ts \
  packages/cli/tests/unit/platform/ui/utils/loopEventHandler.test.ts \
  packages/cli/tests/unit/cli/headless.test.ts \
  packages/cli/tests/unit/cli/headless-events.test.ts \
  packages/cli/tests/unit/agent-runtime/acp/session.test.ts
git commit -m 'fix(surfaces): project bounded shell details consistently'
~~~

### Task 9: Sanitize Bash metadata and project committed SSE replay

**Files:**
- Modify: packages/cli/src/server/routes/session.ts
- Modify: packages/cli/src/services/SessionService.ts
- Test: packages/cli/tests/unit/agent-runtime/server/mcp-tool-metadata.test.ts
- Test: packages/cli/tests/unit/agent-runtime/server/session-routes.test.ts
- Test: packages/cli/tests/unit/services/session-service-resume.test.ts

- [ ] **Step 1: 写 Bash allowlist、REST restore 与 committed replay RED tests**

sanitizeToolMetadata 新测试传入 Bash metadata，其中 raw stdout/stderr/content 和
omitted sentinel 必须被删；stats 保留。SessionService 测试覆盖成功 output object、失败
output=null 和 process-restart old record。route test 覆盖 live、Last-Event-ID replay 和
GET message 三条路径同一 display。

- [ ] **Step 2: 运行 server/service tests 确认 RED**

~~~bash
(cd packages/cli && bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/agent-runtime/server/mcp-tool-metadata.test.ts \
  tests/unit/agent-runtime/server/session-routes.test.ts \
  tests/unit/services/session-service-resume.test.ts)
~~~

预期：raw Bash metadata 穿透，committed.part_created 未投影为 tool.result，fresh load
直接 stringify payload。

- [ ] **Step 3: 将 sanitizer 改为 tool-aware allowlist**

签名固定为 sanitizeToolMetadata(toolName, metadata)。Bash 只允许 summary、status、
sandbox、transport 和规格中的 accounting 字段；stdout/stderr/content/newContent/
oldContent 无条件删除。非 Bash 保持现有 MCP/edit 规则。

- [ ] **Step 4: 统一 durable restore 与 committed replay**

SessionService tool_result 分支调用 projectDurableToolResult + formatter，message content
存 canonical display，metadata 保留供内部恢复的结构化 durable payload。server 的
projectClientMessages 对 tool role 再调用 sanitizeToolMetadata(toolName, nestedMetadata)，
因此 REST 永远不返回历史 raw stdout/stderr。SSE replay 把 committed tool_call/tool_result
投影成与 live tool.start/tool.result 同 shape并保留 seq。投影后的 tool.result 自包含
toolName、toolCallId、messageId、status、output 和 sanitized metadata；当 Last-Event-ID
落在 tool_call 与 tool_result 之间时，只重放 terminal result 也能物化卡片。其他
committed event 继续旧 envelope。

- [ ] **Step 5: 运行 tests 确认 GREEN**

~~~bash
(cd packages/cli && bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/agent-runtime/server/mcp-tool-metadata.test.ts \
  tests/unit/agent-runtime/server/session-routes.test.ts \
  tests/unit/services/session-service-resume.test.ts)
~~~

预期：PASS；失败 output=null 不显示 null；旧 raw metadata 不进 REST/SSE。

- [ ] **Step 6: 提交 Task 9**

~~~bash
git add packages/cli/src/server/routes/session.ts \
  packages/cli/src/services/SessionService.ts \
  packages/cli/tests/unit/agent-runtime/server/mcp-tool-metadata.test.ts \
  packages/cli/tests/unit/agent-runtime/server/session-routes.test.ts \
  packages/cli/tests/unit/services/session-service-resume.test.ts
git commit -m 'fix(server): sanitize and replay bounded Bash results'
~~~

### Task 10: Unify Web realtime, replay and fresh-load cards

**Files:**
- Modify: packages/cli/web/src/store/session/handlers/eventHandlers.ts
- Modify: packages/cli/web/src/store/session/utils/aggregateMessages.ts
- Modify: packages/cli/web/src/components/chat/ChatMessage.tsx
- Test: packages/cli/web/tests/store/session/eventHandlers.test.ts
- Test: packages/cli/web/tests/store/session/aggregateMessages.test.ts
- Test: packages/cli/web/tests/components/chat/ChatMessage.test.tsx

- [ ] **Step 1: 写四路径等价与 stable selector RED tests**

从 live tool.result、仅 terminal replay tool.result、完整 replay、REST aggregate 四条
输入构造同一
Bash card 并比较 toolCall projection。React test 断言 data-tool-name=Bash、
data-tool-status=success 或 error、data-tool-truncated、data-tool-truncation-notice，以及
双 tail/suffix。

- [ ] **Step 2: 运行 Web tests 确认 RED**

~~~bash
(cd packages/cli/web && bunx vitest run --config vitest.config.ts \
  tests/store/session/eventHandlers.test.ts \
  tests/store/session/aggregateMessages.test.ts \
  tests/components/chat/ChatMessage.test.tsx)
~~~

预期：fresh-load output 不同、selectors 缺失、blind slice 删除 tail/suffix。

- [ ] **Step 3: 最小接线 Web store 和 component**

handleToolResult 找不到既有 call 时，用 terminal result 的 toolName/toolCallId 在当前
assistant message 物化 completed/error card；没有 assistant message 时复用现有
materialization helper 创建。aggregateMessages 对新的 tool message content 不再重新
stringify。ChatMessage 删除 blind slice，使用已 fit output，并把 stable data attributes
放 card root，truncation notice 放独立节点。

- [ ] **Step 4: 运行 Web tests、type-check 和 lint 确认 GREEN**

~~~bash
(cd packages/cli/web && bunx vitest run --config vitest.config.ts \
  tests/store/session/eventHandlers.test.ts \
  tests/store/session/aggregateMessages.test.ts \
  tests/components/chat/ChatMessage.test.tsx)
bun run type-check:web
bun run lint:web
~~~

预期：PASS；三路径 card 数据一致；output ≤ 500 chars 且保留两个 tail 和 suffix。

- [ ] **Step 5: 提交 Task 10**

~~~bash
git add packages/cli/web/src/store/session/handlers/eventHandlers.ts \
  packages/cli/web/src/store/session/utils/aggregateMessages.ts \
  packages/cli/web/src/components/chat/ChatMessage.tsx \
  packages/cli/web/tests/store/session/eventHandlers.test.ts \
  packages/cli/web/tests/store/session/aggregateMessages.test.ts \
  packages/cli/web/tests/components/chat/ChatMessage.test.tsx
git commit -m 'fix(web): unify bounded Bash cards across recovery paths'
~~~

### Task 11: Add Chromium dependency and a no-secret production preflight

**Files:**
- Modify: packages/cli/package.json
- Modify: bun.lock
- Create: packages/cli/scripts/browser-check.ts
- Create: packages/cli/tests/unit/scripts/browser-check.test.ts
- Modify: packages/cli/scripts/qualification.ts
- Modify: packages/cli/tests/unit/scripts/qualification.test.ts

- [ ] **Step 1: 写 browser-check 和 qualification ordering RED tests**

browser-check tests 注入不存在与存在的 executable path；不得实际下载。qualification test
断言 production plan 为 14 local checks → browser-check → paid real-api，local plan 不含
browser-check，browser-check environment 不含任何 provider key，preflight failure 会阻止
paid executor。

- [ ] **Step 2: 运行 tests 确认 RED**

~~~bash
(cd packages/cli && bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/scripts/browser-check.test.ts \
  tests/unit/scripts/qualification.test.ts)
~~~

预期：browser-check module/script 和 plan item 不存在。

- [ ] **Step 3: 添加 Playwright library 与 scripts**

~~~bash
bun add --dev --cwd packages/cli playwright@1.62.1
~~~

package scripts 添加：browser:install = playwright install chromium；browser:check =
node scripts/run-bun.js run scripts/browser-check.ts。不要添加 @playwright/test，不要把
playwright 加到 runtime dependencies。版本 1.62.1 是计划编写时查询到的 registry
版本；执行时若该精确版本不可用，停止并修订计划，不静默换成 latest。

- [ ] **Step 4: 实现无网络 browser check**

导出 resolveChromiumExecutablePath 和 checkChromiumExecutable；验证 executable 存在且
可执行，可 launch/close 一个无页面 Chromium，但不访问网络。失败信息固定附带：

~~~text
Install with: bun run --filter blade-code browser:install
~~~

- [ ] **Step 5: 将 browser-check 插入 production qualification**

新增非 paid QualificationCheck，位于 real-api 前。resolveQualificationCheckEnvironment
沿用 local sanitizer，因此不会得到 API key。

- [ ] **Step 6: 运行 tests、browser check、type-check 确认 GREEN**

~~~bash
(cd packages/cli && bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/scripts/browser-check.test.ts \
  tests/unit/scripts/qualification.test.ts)
bun run --filter blade-code browser:check
bun run --filter blade-code type-check
~~~

预期：tests PASS；若本机尚未装 Chromium，browser:check 应以精确安装提示 fail closed，
此时运行一次 browser:install 后重跑，不能在 check 内隐式下载。

- [ ] **Step 7: 提交 Task 11**

~~~bash
git add packages/cli/package.json bun.lock \
  packages/cli/scripts/browser-check.ts \
  packages/cli/scripts/qualification.ts \
  packages/cli/tests/unit/scripts/browser-check.test.ts \
  packages/cli/tests/unit/scripts/qualification.test.ts
git commit -m 'test(qualification): add Chromium preflight'
~~~

### Task 12: Build the deterministic large-output fixture and host assertions

**Files:**
- Create: packages/cli/tests/integration/real-api/foregroundBoundedOutputFixture.ts
- Create: packages/cli/tests/integration/real-api/foregroundBoundedOutputHarness.ts
- Create: packages/cli/tests/unit/integration/foreground-bounded-output-harness.test.ts

- [ ] **Step 1: 写 exact byte layout 和 local/ACP trace RED tests**

fixture test 用固定 nonce 生成 script，执行后断言 stdout/stderr 各恰好
1024*1024+64*1024 bytes，prefix sentinel 在首 4 KiB，两个 tail 在合并输出末 1 MiB。
harness test 构造 durable tool trace，local 契约要求双流 stats，ACP 契约要求 merged
stdout + zero stderr stats；额外工具、background 或 sentinel 均 fail。

- [ ] **Step 2: 运行 tests 确认 RED**

~~~bash
(cd packages/cli && bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/integration/foreground-bounded-output-harness.test.ts)
~~~

预期：模块不存在。

- [ ] **Step 3: 实现 fixture API**

~~~ts
export interface ForegroundBoundedOutputFixture {
  scriptPath: string;
  command: string;
  localPrompt: string;
  acpPrompt: string;
  stdoutPrefixSentinel: string;
  stderrPrefixSentinel: string;
  stdoutTail: string;
  stderrTail: string;
  stdoutBytes: number;
  stderrBytes: number;
}

export async function createForegroundBoundedOutputFixture(
  workspace: string,
  nonce: string
): Promise<ForegroundBoundedOutputFixture>;
~~~

脚本先写两路 prefix/filler，再写 stdout tail、stderr tail。command 使用可靠 shell quoting；
模型只执行一次，不生成脚本。

- [ ] **Step 4: 实现 canonical host assertions**

复用 readSessionEvents、extractDurableToolTrace、assertNoSecrets；新增
assertForegroundBoundedOutputToolTrace、assertNoForegroundLeases、
assertOwnedProcessesGone。断言不把完整 output 放进失败消息。

- [ ] **Step 5: 运行 tests 确认 GREEN**

~~~bash
(cd packages/cli && bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/integration/foreground-bounded-output-harness.test.ts)
~~~

预期：PASS，所有失败证据为 redacted bounded tail。

- [ ] **Step 6: 提交 Task 12**

~~~bash
git add packages/cli/tests/integration/real-api/foregroundBoundedOutputFixture.ts \
  packages/cli/tests/integration/real-api/foregroundBoundedOutputHarness.ts \
  packages/cli/tests/unit/integration/foreground-bounded-output-harness.test.ts
git commit -m 'test(shell): add bounded output qualification fixture'
~~~

### Task 13: Add the real Chromium Web driver

**Files:**
- Create: packages/cli/tests/support/launch-foreground-bounded-output-gui.ts
- Create: packages/cli/tests/support/foregroundBoundedOutputWebDriver.ts
- Create: packages/cli/tests/unit/integration/foreground-bounded-output-web-driver.test.ts

- [ ] **Step 1: 写 launcher argument、ready handshake、fault collection 和 cleanup RED tests**

用短命 fake server/child 验证：ready JSON 不含 key/HOME/storage；TERM grace 后 KILL；
expected refresh EventSource/navigation abort 的窄 allowlist；pageerror、console.error、4xx/5xx
和 unexpected requestfailed 均 fail。

- [ ] **Step 2: 运行 tests 确认 RED**

~~~bash
(cd packages/cli && bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/integration/foreground-bounded-output-web-driver.test.ts)
~~~

预期：driver/launcher 不存在。

- [ ] **Step 3: 实现 production launcher**

接收 root、model qualification ID、port、fixture command、session ID；写隔离 config，
关闭 hooks/MCP/verification agent，只允许 Bash；启动 dist/blade.js serve。stdout 只写一行
safe ready JSON。使用 owned process termination，不记录完整 provider body。

- [ ] **Step 4: 实现 Playwright Web driver**

真实 composer selector textarea[data-blade-composer] 提交 prompt；等待 marker；定位
data-tool-name=Bash + data-tool-status=success card；展开后断言双 tail、suffix、sentinel absence；
reload 后重复断言；收集并校验浏览器 fault。finally await page/context/browser/launcher close。

- [ ] **Step 5: 运行 deterministic driver tests 与 production build**

~~~bash
(cd packages/cli && bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/integration/foreground-bounded-output-web-driver.test.ts)
bun run build:cli
~~~

预期：PASS，launcher cleanup 无 open handle。

- [ ] **Step 6: 提交 Task 13**

~~~bash
git add packages/cli/tests/support/launch-foreground-bounded-output-gui.ts \
  packages/cli/tests/support/foregroundBoundedOutputWebDriver.ts \
  packages/cli/tests/unit/integration/foreground-bounded-output-web-driver.test.ts
git commit -m 'test(web): add real bounded output browser driver'
~~~

### Task 14: Add the raw PTY driver

**Files:**
- Create: packages/cli/tests/support/foregroundBoundedOutputPtyRunner.ts
- Create: packages/cli/tests/support/foregroundBoundedOutputPtyDriver.ts
- Create: packages/cli/tests/unit/integration/foreground-bounded-output-pty-driver.test.ts

- [ ] **Step 1: 写 bounded evidence、resize、timeout 和 cleanup RED tests**

runner evidence 固定为 booleans/counts + 小型 redacted ansiTail，不返回完整 transcript。
测试用短命 PTY fixture 验证 bracketed paste、截断提示、final marker、resize 后提示仍一次，
关闭 stdin + kill + await exit。

- [ ] **Step 2: 运行 tests 确认 RED**

~~~bash
(cd packages/cli && bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/integration/foreground-bounded-output-pty-driver.test.ts)
~~~

预期：runner/driver 不存在。

- [ ] **Step 3: 实现 runner 与 owned driver**

生产 CLI 参数固定 trust workspace、yolo、max-turns 2、session-id；bracketed paste prompt；
等待 truncation 和 marker；resize；输出 ≤ 24K 的 redacted JSON。父 driver 用 runOwnedCommand
或等价 owned process helper，210 秒 wrapper，finally 检查 PID/lease/root cleanup。

- [ ] **Step 4: 运行 tests 和 production CLI smoke**

~~~bash
(cd packages/cli && bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/integration/foreground-bounded-output-pty-driver.test.ts)
bun run --filter blade-code start -- --help
~~~

预期：PASS，无 PTY/open handle 残留。

- [ ] **Step 5: 提交 Task 14**

~~~bash
git add packages/cli/tests/support/foregroundBoundedOutputPtyRunner.ts \
  packages/cli/tests/support/foregroundBoundedOutputPtyDriver.ts \
  packages/cli/tests/unit/integration/foreground-bounded-output-pty-driver.test.ts
git commit -m 'test(tui): add raw PTY bounded output driver'
~~~

### Task 15: Add the child-backed real ACP driver

**Files:**
- Create: packages/cli/tests/support/acp/ChildBackedRecordingAcpClient.ts
- Create: packages/cli/tests/unit/integration/foreground-bounded-output-acp-driver.test.ts

- [ ] **Step 1: 写 real SDK terminal lifecycle RED tests**

client 直接 implements acp.Client，真实实现 createTerminal、terminalOutput、
waitForTerminalExit、killTerminal、releaseTerminal。测试要求实际启动短 child，output 是
cumulative merged string，release 幂等且 await pipes/child；updates 有界且无私有 meta。

- [ ] **Step 2: 运行 tests 确认 RED**

~~~bash
(cd packages/cli && bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/integration/foreground-bounded-output-acp-driver.test.ts)
~~~

预期：ChildBackedRecordingAcpClient 不存在。

- [ ] **Step 3: 实现 child-backed client**

用 bun-pty 启动 client-side fixture command，让 stdout/stderr 经过真实 terminal 合并流，
不能在 JavaScript 中把两个独立 pipe 任意串接。terminalOutput 返回 SDK 要求的
output/truncated/exitStatus；kill TERM→KILL；release await 全部资源并从 Map 删除。只在
client 内保留本 fixture 所需 cumulative output，evidence 只导出摘要。

- [ ] **Step 4: 添加 paired SDK prompt/load helper**

通过真实 ndJsonStream、ClientSideConnection、AgentSideConnection 和 BladeAgent 执行
initialize → newSession → setSessionMode(yolo) → prompt。session/load 后断言没有历史
tool_call replay。关闭 writer 并 await connection.closed 和 BladeAgent.destroy。

- [ ] **Step 5: 运行 tests 确认 GREEN**

~~~bash
(cd packages/cli && bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/integration/foreground-bounded-output-acp-driver.test.ts)
~~~

预期：PASS；真实 child PID 消失；terminal release 只一次有效副作用。

- [ ] **Step 6: 提交 Task 15**

~~~bash
git add packages/cli/tests/support/acp/ChildBackedRecordingAcpClient.ts \
  packages/cli/tests/unit/integration/foreground-bounded-output-acp-driver.test.ts
git commit -m 'test(acp): add child-backed terminal driver'
~~~

### Task 16: Wire the six-cell real API release matrix

**Files:**
- Create: packages/cli/tests/integration/real-api/foreground-bounded-output-trajectory.test.ts
- Modify: packages/cli/tests/integration/real-api/testConfig.ts
- Modify: packages/cli/scripts/test-config.js
- Modify: packages/cli/scripts/test-config.d.ts
- Modify: packages/cli/tests/unit/scripts/test-runner.test.ts

- [ ] **Step 1: 写 fixed-matrix 与 timeout RED tests**

test-runner.test.ts 断言新 trajectory 位于 realApiQualification.files，外层 timeout 为
45*60*1000，real-api project 仍单 worker。testConfig 新 helper 必须恰好返回 Flash、Pro
两个 TestModelConfig；缺任何模型 fail closed。

- [ ] **Step 2: 运行 runner/config tests 确认 RED**

~~~bash
(cd packages/cli && bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/scripts/test-runner.test.ts \
  tests/unit/scripts/qualification.test.ts)
~~~

预期：fixed file 不存在，timeout 仍是 30 分钟。

- [ ] **Step 3: 创建顺序六格 Vitest matrix**

~~~ts
const surfaces = ['web', 'pty', 'acp'] as const;
const models = isRealApiTestEnabled()
  ? resolveRequiredDeepSeekQualificationModels()
  : [];
const matrix = models.flatMap((model) =>
  surfaces.map((surface) => ({ model, surface }))
);

describe.skipIf(!isRealApiTestEnabled())(
  'bounded foreground output release matrix',
  () => {
    it.each(matrix)('$model.model × $surface', async ({ model, surface }) => {
      // 每格创建全新 root/session/fixture，180 秒 AbortSignal，finally 全清理。
    }, 240_000);
  }
);
~~~

REAL_API_TEST=1 时 matrix 长度不是 6 必须在文件加载期 throw，不能 skip。每格调用对应
真实 driver，然后统一执行 canonical trace、secret、PID、lease、port/root assertions。

- [ ] **Step 4: 接入 fixed release list 和声明**

realApiQualification timeout 固定为 45 分钟；files 添加新 trajectory；test-config.d.ts
显式暴露 realApiQualification，以防 JS config shape 漂移。

- [ ] **Step 5: 运行无付费的 collection/config 验证**

~~~bash
(cd packages/cli && bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/scripts/test-runner.test.ts \
  tests/unit/scripts/qualification.test.ts)
(cd packages/cli && bunx vitest list --config vitest.config.ts --project=real-api \
  tests/integration/real-api/foreground-bounded-output-trajectory.test.ts)
~~~

预期：unit PASS；real-api file 可收集且在 REAL_API_TEST 未启用时不调用网络。

- [ ] **Step 6: 提交 Task 16**

~~~bash
git add packages/cli/tests/integration/real-api/foreground-bounded-output-trajectory.test.ts \
  packages/cli/tests/integration/real-api/testConfig.ts \
  packages/cli/scripts/test-config.js \
  packages/cli/scripts/test-config.d.ts \
  packages/cli/tests/unit/scripts/test-runner.test.ts
git commit -m 'test(qualification): add bounded output six-cell gate'
~~~

### Task 17: Document the runtime and qualification contract

**Files:**
- Modify: docs/reference/process-lifecycle.md
- Modify: docs/reference/tool-list.md
- Modify: docs/testing/qualification.md
- Modify: docs/changelog.md

- [ ] **Step 1: 更新用户与资格文档**

process lifecycle 写 native/LocalTerminalService 每流 1 MiB 和 ACP remote-host boundary；
tool list 写结构化 truncation fields；qualification 写六格、browser:install/check、45 分钟、
真实/确定性边界、Computer Use 不可用时 raw PTY contract。

- [ ] **Step 2: 在 qualification 文档定义最终 evidence 必填字段**

列出 Qualified candidate SHA、版本、日期、deterministic commands、六格结果、cleanup、
sentinel/credential absence、失败与重跑、scope boundary。此阶段不创建 evidence 文件，
也不写任何假状态。

- [ ] **Step 3: 只更新 Unreleased changelog**

记录前台内存上限、ACP fail-closed、统一 surface projection、真浏览器/raw PTY/ACP
资格；不得创建版本 heading，不得提前写“全部通过”。

- [ ] **Step 4: 检查文档 diff 并提交**

~~~bash
git diff --check
git add docs/reference/process-lifecycle.md docs/reference/tool-list.md \
  docs/testing/qualification.md docs/changelog.md
git commit -m 'docs: document bounded foreground output qualification'
~~~

预期：文档无 TBD、TODO、NOT RUN、NOT_YET 或预填 PASS。

### Task 18: Run deterministic completion gates and review the patch

**Files:**
- Modify if review finds defects: only files from Tasks 1-17

- [ ] **Step 1: 运行 focused regression set**

~~~bash
(cd packages/cli && bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/tooling/tools/builtin/shell/bounded-output-buffer.test.ts \
  tests/unit/tooling/tools/builtin/shell/shell-output-capture.test.ts \
  tests/unit/tooling/tools/builtin/shell/shell-output-projection.test.ts \
  tests/unit/tooling/tools/builtin/bash.test.ts \
  tests/unit/agent-runtime/acp/service-context.test.ts \
  tests/unit/platform/ui/utils/tool-formatters.test.ts \
  tests/unit/cli/headless.test.ts \
  tests/unit/agent-runtime/server/session-routes.test.ts)
(cd packages/cli/web && bunx vitest run --config vitest.config.ts \
  tests/store/session/eventHandlers.test.ts \
  tests/store/session/aggregateMessages.test.ts \
  tests/components/chat/ChatMessage.test.tsx)
~~~

预期：全部 PASS。

- [ ] **Step 2: 运行完整 deterministic gate**

~~~bash
bun run qualify:local
~~~

预期：14/14 checks PASS；无付费 API 调用。

- [ ] **Step 3: 执行结构审查**

~~~bash
git diff main...HEAD --check
rg -n 'stdout \+=|stderr \+=' packages/cli/src/tools/builtin/shell/bash.ts \
  packages/cli/src/acp/AcpServiceContext.ts
rg -n 'as any|as never' packages/cli/tests/support/acp \
  packages/cli/tests/unit/agent-runtime/acp/service-context.test.ts
rg -n 'setInterval\(async' packages/cli/src/acp/AcpServiceContext.ts
git status --short --branch
~~~

预期：旧无界拼接、untyped escape、overlapping poll 均无命中；工作树干净。

- [ ] **Step 4: 请求独立代码审查并修复**

使用 superpowers:requesting-code-review；审查范围 main...HEAD，重点核对规格 24 条完成标准、
secret、process cleanup、retry 与 surface recovery。修复后重跑 focused + qualify:local。

- [ ] **Step 5: 提交审查修复（如有）**

先运行 git status --short 和 git diff --name-only，逐个审阅文件后显式 git add 实际
输出的 feature 文件，再执行：

~~~bash
git diff --cached --check
git commit -m 'fix(shell): address bounded output review findings'
~~~

如无修复，不运行 git add/commit，也不创建空提交。

### Task 19: Freeze the release candidate version and documentation

**Files:**
- Modify: packages/cli/package.json
- Modify: docs/changelog.md

- [ ] **Step 1: 重新解析下一个 patch version**

~~~bash
node -p "require('./packages/cli/package.json').version"
git tag --list 'v*' --sort=-v:refname | head -n 1
npm view blade-code version
~~~

选择三者最高版本的下一个 patch；若仍是 0.10.27，则目标 0.10.28。不要在计划里硬编码
更晚版本。

- [ ] **Step 2: 更新 package version 与 version changelog heading**

只做目标 patch 版本；把本 feature 的 Unreleased 条目原子移动到该版本 heading，其他
Unreleased 内容保持不动；确保 dist 在后续 build 读取新版本。

- [ ] **Step 3: 运行无网络 release-candidate gate**

~~~bash
bun run build
bun run type-check
bun run lint
git diff --check
~~~

预期：全部退出 0。

- [ ] **Step 4: 提交 frozen candidate**

~~~bash
git add packages/cli/package.json docs/changelog.md
git commit -m 'chore: prepare bounded output patch release'
git rev-parse HEAD
~~~

记录该完整 SHA 为 Qualified candidate SHA。此后付费资格完成前禁止再改代码。

### Task 20: Run real production qualification and seal evidence

**Files:**
- Create: docs/testing/bounded-foreground-output-evidence.md

- [ ] **Step 1: 确认 Chromium 和凭据 preflight**

~~~bash
bun run --filter blade-code browser:check
~~~

缺 Chromium 时显式执行 browser:install 后重跑。确认 config/auth 提供 Flash 和 Pro；
不得打印 key。

- [ ] **Step 2: 在 frozen candidate 上运行 production qualification**

~~~bash
git status --short
git rev-parse HEAD
bun run qualify:production
~~~

预期：16/16 qualification checks PASS（14 local + browser-check + real-api）；real-api fixed
matrix 内六格全部 PASS。若现有 plan check 数因实施时主线新增而变化，以实际 plan 为准，
但 browser-check 必须位于 paid real-api 前。

- [ ] **Step 3: 失败时只做证据化重跑，不静默接受**

记录首个失败 cell、日志 redacted tail、cleanup 状态。任何代码修复都会产生新 candidate
commit，并要求从 Task 18 重跑；只有 unchanged source 的 provider/transient failure 可按
现有 file retry 或一次显式整套重跑记录为 intermittent failure。

- [ ] **Step 4: 创建完整的最终 evidence**

只在真实结果已知后创建文件，写入 frozen candidate SHA、日期、版本、每条命令退出码、
六格结果、cleanup、sentinel/credential absence、失败与重跑事实、scope boundary。禁止
TBD、TODO、NOT RUN、NOT_YET 或未验证的 PASS。

- [ ] **Step 5: 提交 evidence-only commit**

~~~bash
git add docs/testing/bounded-foreground-output-evidence.md
! rg -n 'TBD|TODO|NOT RUN|NOT_YET' \
  docs/testing/bounded-foreground-output-evidence.md
git commit -m 'docs: record bounded output qualification evidence'
git diff --name-only HEAD^..HEAD
RECORDED_SHA=$(sed -n 's/^- Qualified candidate SHA: //p' \
  docs/testing/bounded-foreground-output-evidence.md)
test "$RECORDED_SHA" = "$(git rev-parse HEAD^)"
~~~

预期：最后命令只输出 docs/testing/bounded-foreground-output-evidence.md；HEAD^ 即 evidence
中记录的 Qualified candidate SHA。若不是，停止发布。

- [ ] **Step 6: 在 tag HEAD 重跑无网络门禁**

~~~bash
bun run build
bun run type-check
bun run lint
git diff --check
git status --short --branch
~~~

预期：全部退出 0，工作树干净。

### Task 21: Completion audit, integrate to main, tag and verify npm

**Files:**
- No source changes expected

- [ ] **Step 1: 构建 prompt-to-artifact checklist**

逐条映射原目标与规格完成标准：参考仓库证据、runtime memory cap、稳定性/性能/长任务、
CLI/TUI、Web、ACP、真 Chromium、raw PTY、真实 API、Flash/Pro、独立 patch、版本/文档、
qualification、cleanup、secret absence。每条必须指向 source/test/evidence/command；未知视为
未完成。

- [ ] **Step 2: 检查 candidate→tag HEAD 差异和提交范围**

~~~bash
git log --oneline main..HEAD
git diff --stat main...HEAD
git diff --name-only HEAD^..HEAD
git status --short --branch
~~~

预期：candidate 后只有 evidence 文件；无无关改动。

- [ ] **Step 3: 将已资格验证分支 fast-forward 集成到 main**

在主 checkout 执行：

~~~bash
git status --short --branch
git fetch origin main --tags
git merge-base --is-ancestor origin/main main
git merge --ff-only feat/bounded-foreground-shell-output
~~~

预期：主 checkout 原本干净，origin/main 仍是本地 main 的祖先，fast-forward 成功，
main HEAD 等于 feature evidence commit。
如果 origin/main 或本地 main 已前进导致不能 fast-forward，停止：在 feature worktree rebase
到最新 main，重新执行 Task 18-20，生成新的 candidate SHA 和 evidence 后再集成。

- [ ] **Step 4: 创建并推送 tag**

仅在用户授权发布且所有审计通过时：

~~~bash
VERSION=$(node -p "require('./packages/cli/package.json').version")
git tag "v$VERSION"
git push origin main
git push origin "v$VERSION"
~~~

不运行 release:patch 或 release.js（它们会再次 bump 已冻结版本），也不运行 npm publish；
现有 publish.yml 由 tag 自动校验版本、构建并发布。

- [ ] **Step 5: 等待并核验发布**

~~~bash
VERSION=$(node -p "require('./packages/cli/package.json').version")
TAG="v$VERSION"
RUN_ID=''
for attempt in $(seq 1 24); do
  RUN_ID=$(gh run list --workflow publish.yml --branch "$TAG" --limit 1 \
    --json databaseId --jq '.[0].databaseId // empty')
  test -n "$RUN_ID" && break
  sleep 5
done
test -n "$RUN_ID"
gh run watch "$RUN_ID" --exit-status
test "$(npm view blade-code version)" = "$VERSION"
gh release view "$TAG"
~~~

预期：workflow 成功，npm version 等于 VERSION，GitHub Release 存在。

- [ ] **Step 6: 清理 feature worktree 与分支**

只有 main、origin/main、tag 和 npm SHA/版本均核验后：

~~~bash
git worktree remove .worktrees/bounded-foreground-shell-output
git branch -d feat/bounded-foreground-shell-output
~~~

若 worktree 非干净或分支未被 main 包含，停止并保留现场。

- [ ] **Step 7: 只在大目标真正完成时更新 goal**

本 patch 只是开放式“生产级 coding agent”目标中的一个增量，不调用 update_goal complete。
记录下一候选 patch：周期空转检测、工具阶段 tracing、raw-spawn architecture contract、
public SDK facade 等，按新的 brainstorm → spec → plan 循环继续。

## 计划自审清单

- Spec 1-24：Tasks 1-21 均有 source、test 或 release evidence 映射。
- Capture cap/UTF-8/chunk objects：Tasks 1-3。
- Native terminal branches/process lifecycle：Task 4。
- ACP typed service/fail-closed/raw progress：Tasks 5-6。
- Canonical projector/TUI/Headless/ACP：Tasks 7-8。
- Durable restore/SSE sanitizer/replay：Task 9。
- Web realtime/replay/fresh-load/selector：Task 10。
- Playwright preflight：Task 11。
- Deterministic fixture/assertions：Task 12。
- 真 Chromium/raw PTY/ACP SDK drivers：Tasks 13-15。
- Flash/Pro 六格 fixed matrix/45 min watchdog：Task 16。
- Runtime/qualification documentation contract：Task 17。
- Full local verification/review：Task 18。
- Version freeze：Task 19。
- Paid production qualification/evidence-only seal：Task 20。
- Completion audit/main integration/tag/npm：Task 21。
- No placeholders：计划与仓库文档不预建 evidence 占位；Task 20 只写真实完整结果。
- Type consistency：ShellOutputCaptureSnapshot、TerminalExecuteResult、ToolResult projector
  的名称在所有后续任务保持一致。
