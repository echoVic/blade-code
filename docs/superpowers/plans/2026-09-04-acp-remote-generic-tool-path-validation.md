# ACP Remote Generic Tool Path Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 ACP remote 工具声明的所有文件路径统一放到无副作用的执行前置校验中。

**Architecture:** 在 `ToolExecutor` 中把固定单文件字段、写工具通用 `path` 与
`ToolInvocation.getAffectedPaths()` 合并为有序去重候选，并在初始 schema snapshot 与
hook 修改 snapshot 上复用同一校验。错误继续使用现有脱敏结果，不改变 local/ACP-local
或 remote capability allowlist。

**Tech Stack:** TypeScript strict、TypeBox、Vitest、Biome、ACP SDK test harness。

---

### Task 1: 建立通用 declared-path 因果 RED

**Files:**
- Modify: `packages/cli/tests/unit/agent-runtime/tools/tool-executor-filelock.test.ts`

- [ ] **Step 1: 写通用 `path` RED**

新增 remote dynamic MCP write tool，schema 只含 `path`，传入 Win32 ADS 路径。断言
返回 `acp_remote_path_invalid`，且 scheduler、lock 和 invocation 都未运行。

- [ ] **Step 2: 写 `affectedPaths()` RED**

新增参数名为 `target` 的 remote tool，通过 `affectedPaths()` 返回路径；覆盖单路径与
“第一条安全、第二条非法”的多路径场景。

- [ ] **Step 3: 运行 RED**

```bash
cd packages/cli
bun x vitest run --config vitest.config.ts --project=unit \
  tests/unit/agent-runtime/tools/tool-executor-filelock.test.ts
```

期望：新增用例因工具实际执行而失败，证明现有 gate 未覆盖这些路径来源。

### Task 2: 实现统一的 remote declared-path gate

**Files:**
- Modify: `packages/cli/src/tools/execution/ToolExecutor.ts`
- Test: `packages/cli/tests/unit/agent-runtime/tools/tool-executor-filelock.test.ts`

- [ ] **Step 1: 将校验器改为接受 `ToolInvocation`**

收集既有固定字段、写工具 `path` 与 `invocation.getAffectedPaths()`；字符串路径有序
去重，逐项按 frozen `pathStyle` 解析。`ApplyPatch` 的相对 affected paths 保持由现有
事务 preflight 负责，不进入通用绝对路径 gate。

- [ ] **Step 2: 在初始和 hook-modified snapshot 上调用同一校验器**

初始检查位于 concurrency gate 之前；hook 改写检查位于重新计算 permission、scheduler、
lock 和 invocation 之前。

- [ ] **Step 3: 运行 GREEN**

运行 Task 1 的 focused 命令，期望全部通过。

### Task 3: 锁定兼容与脱敏边界

**Files:**
- Modify: `packages/cli/tests/unit/agent-runtime/tools/tool-executor-filelock.test.ts`

- [ ] **Step 1: 写 hook rewrite 与 no-side-effect 测试**

让测试 hook 将安全 `target` 改为非法路径并重建 invocation；断言 permission 后续、
scheduler、lock、tool 和 ACP I/O 不运行，结果不含原始路径。

- [ ] **Step 2: 写 local/readonly compatibility 测试**

证明 local write `path` 不进入 ACP parser；readonly MCP 若没有 `affectedPaths()`，其业务
`path` 字段不被误判。

- [ ] **Step 3: 运行 focused 回归与静态检查**

```bash
cd packages/cli
bun x vitest run --config vitest.config.ts --project=unit \
  tests/unit/agent-runtime/tools/tool-executor-filelock.test.ts \
  tests/unit/tooling/tools/execution/workspace-tool-policy.test.ts
bun x vitest run --config vitest.config.ts --project=integration \
  tests/integration/tool-executor.test.ts \
  tests/integration/acp-remote-file-tools.test.ts
bun run type-check
bun x biome check src/tools/execution/ToolExecutor.ts \
  tests/unit/agent-runtime/tools/tool-executor-filelock.test.ts
git diff --check
```

### Task 4: 复审、全量验证与独立 patch 发布

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `CHANGELOG.zh.md`
- Modify: `packages/cli/package.json`
- Create after qualification: bilingual bounded evidence under `docs/testing/` and `docs/en/testing/`

- [ ] **Step 1: 独立规格与质量/安全/并发复审**

冻结候选 SHA，两个只读 reviewer 分别检查规格覆盖和副作用顺序。

- [ ] **Step 2: 运行全仓门禁**

```bash
bun run format:check
bun run lint
bun run type-check
bun run build
bun run test:all
```

- [ ] **Step 3: 运行现有 ACP remote 真实 API 资格**

使用 `~/.blade/config.json` 中已有 Provider 配置；固定 framework retry 为 0，不在命令、
日志、证据或提交中输出 credential。至少覆盖 DeepSeek Flash/Pro 的真实 ACP remote 文件
调用与拒绝后的正常继续能力。

- [ ] **Step 4: 独立发布**

选择当前 npm、git 与 package 三者最高版本后的下一个 patch；只修改 CLI package 版本与
双语 changelog/evidence，构建测试后提交，创建 annotated tag，由 tag workflow 发布。
