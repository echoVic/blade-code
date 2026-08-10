/**
 * completionPolicy — 完成策略检查
 *
 * 从 executeLoopGenerator 中提取的三个完成检查逻辑：
 * 1. checkOutputRecovery — finishReason === 'length' 时的恢复/截断判断
 * 2. checkIncompleteIntent — 检测 LLM "说了要做但没做"的模式
 * 3. checkStopHook — 执行 stop hook 并加超时保护
 *
 * 所有函数返回 action descriptors，不执行副作用。
 */

import type { PermissionMode } from '../../config/index.js';
import type { BudgetTracker } from '../../context/TokenBudget.js';
import { checkTokenBudget } from '../../context/TokenBudget.js';
import { HookManager } from '../../hooks/HookManager.js';
import { createLogger, LogCategory } from '../../logging/Logger.js';
import type { ToolResult } from '../../tools/types/index.js';
import { getCwd } from '../../utils/cwd.js';
import { isVerificationCommand } from '../../utils/shell/verificationCommand.js';

const logger = createLogger(LogCategory.AGENT);

// ===== Output Recovery =====

const MAX_OUTPUT_RECOVERY_LIMIT = 3;

export type OutputRecoveryAction =
  | { action: 'recover' }
  | { action: 'truncated' }
  | { action: 'budget_stop' }
  | { action: 'none' };

/**
 * 检查是否需要 max-output-tokens 恢复。
 *
 * Bug fix: 当 finishReason === 'length' 且 recovery 次数已达上限时，
 * 返回 action: 'truncated' 而非静默放过（旧代码直接 fall-through）。
 */
export function checkOutputRecovery(
  finishReason: string | undefined,
  recoveryCount: number,
  budgetTracker: BudgetTracker
): OutputRecoveryAction {
  if (finishReason !== 'length') {
    return { action: 'none' };
  }

  if (recoveryCount >= MAX_OUTPUT_RECOVERY_LIMIT) {
    return { action: 'truncated' };
  }

  if (checkTokenBudget(budgetTracker) === 'stop') {
    logger.info('[Loop] Token budget: diminishing returns detected, skipping recovery');
    return { action: 'budget_stop' };
  }

  return { action: 'recover' };
}

export { MAX_OUTPUT_RECOVERY_LIMIT };

// ===== Incomplete Intent Detection =====

const INCOMPLETE_INTENT_PATTERNS = [
  /：\s*$/,
  /:\s*$/,
  /\.\.\.\s*$/,
  /让我(先|来|开始|查看|检查|修复)/,
  /Let me (first|start|check|look|fix)/i,
  /I('ll| will) (now |)(create|write|edit|update|modify|fix|add|implement)/i,
  /我(现在就|来|要)(创建|写入|编辑|修改|修复|添加|实现)/,
  /\d+\.\s+(First|Next|Then|Finally)/i,
];

const CODE_BLOCK_WITHOUT_TOOL_PATTERN = /```[\s\S]{50,}```/;

const RETRY_PROMPT =
  '请执行你提到的操作，不要只是描述。使用 Edit/Write/ApplyPatch/Bash 工具来实际修改文件。';

/** 最大重试次数 */
const MAX_INCOMPLETE_INTENT_RETRIES = 2;

export type IncompleteIntentAction =
  | { action: 'retry'; prompt: string }
  | { action: 'none' };

/**
 * 检测 LLM 是否表达了意图但未执行工具。
 *
 * Bug fixes:
 * 1. 用显式 retryCount 替代滑动窗口，避免远距离重触发
 * 2. 只检测尾部 200 字符，避免全文误匹配
 * 3. 排除 markdown code block 内的匹配
 */
export function checkIncompleteIntent(
  content: string | undefined,
  retryCount: number,
  hadToolCalls = true
): IncompleteIntentAction {
  if (!content || retryCount >= MAX_INCOMPLETE_INTENT_RETRIES) {
    return { action: 'none' };
  }

  // 检测：输出了代码块但没调用任何工具（说明模型想改代码但没用工具）
  if (!hadToolCalls && CODE_BLOCK_WITHOUT_TOOL_PATTERN.test(content)) {
    return { action: 'retry', prompt: RETRY_PROMPT };
  }

  // 只检测尾部 200 字符
  const tail = content.slice(-200);

  // 排除 markdown code block：如果尾部处于未闭合的代码块中，跳过检测
  const codeBlockMarkers = tail.match(/```/g);
  if (codeBlockMarkers && codeBlockMarkers.length % 2 !== 0) {
    return { action: 'none' };
  }

  const isIncompleteIntent = INCOMPLETE_INTENT_PATTERNS.some((p) => p.test(tail));

  if (isIncompleteIntent) {
    return { action: 'retry', prompt: RETRY_PROMPT };
  }

  return { action: 'none' };
}

export { MAX_INCOMPLETE_INTENT_RETRIES, RETRY_PROMPT };

// ===== Explicit Verification Requirement =====

const EXPLICIT_VERIFICATION_PATTERNS = [
  /\b(?:run|execute|rerun|re-run)\b[\s\S]{0,60}\b(?:tests?|test suite|lint|type-?check|build)\b/i,
  /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|lint|build|type-?check)\b/i,
  /(?:运行|执行|跑|重新运行).{0,30}(?:测试|单测|集成测试|检查|构建)/,
];

type VerificationKind = 'test' | 'lint' | 'type-check' | 'build';

const VERIFICATION_KIND_PATTERNS: Record<VerificationKind, RegExp> = {
  test: /\b(?:tests?|test suite)\b|(?:测试|单测|集成测试)/i,
  lint: /\blint(?:ing)?\b/i,
  'type-check': /\btype[\s-]?check(?:ing)?\b|\btsc\b|类型检查/i,
  build: /\bbuild\b|构建/i,
};

const VERIFICATION_COMMAND_KIND_PATTERNS: Record<VerificationKind, RegExp> = {
  test: /(?:^|\s)(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|(?:^|\s)(?:node|bun)\s+--test\b|(?:^|\s)(?:vitest|jest|pytest|go\s+test|cargo\s+test)\b/i,
  lint: /(?:^|\s)(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?lint\b/i,
  'type-check':
    /(?:^|\s)(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?type-?check\b|(?:^|\s)tsc\b/i,
  build: /(?:^|\s)(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?build\b/i,
};

export const VERIFICATION_RETRY_PROMPT =
  'The user explicitly required verification, but it has not run successfully. ' +
  'Do not finish or explain. Your next action must be a Bash tool call that runs ' +
  'the requested test, lint, type-check, or build command. Inspect the command ' +
  'result and fix any failure before finishing.';

export const VERIFICATION_FAILURE_MESSAGE =
  'Required verification did not run successfully before the retry limit.';

export type VerificationAction =
  | { action: 'retry'; prompt: string }
  | { action: 'fail'; message: string }
  | { action: 'none' };

export const MAX_VERIFICATION_RETRIES = 3;

export { isVerificationCommand };

/** Record only structured, successful verification evidence from tool results. */
export function recordVerificationEvidence(
  commands: Set<string>,
  toolName: string,
  result: ToolResult
): void {
  if (!result.success) return;

  if (['Edit', 'Write', 'ApplyPatch', 'NotebookEdit'].includes(toolName)) {
    commands.clear();
    return;
  }

  if (
    toolName === 'Bash' &&
    typeof result.metadata?.command === 'string' &&
    result.metadata.exit_code === 0 &&
    isVerificationCommand(result.metadata.command)
  ) {
    commands.add(result.metadata.command);
    return;
  }

  if (!['Task', 'TaskOutput'].includes(toolName)) return;
  const delegatedCommands = result.metadata?.verificationCommands;
  if (!Array.isArray(delegatedCommands)) return;
  for (const command of delegatedCommands) {
    if (typeof command === 'string' && isVerificationCommand(command)) {
      commands.add(command);
    }
  }
}

export function checkVerificationRequired(
  userRequest: string | undefined,
  successfulVerificationCommands: ReadonlySet<string>,
  retryCount: number
): VerificationAction {
  if (
    !userRequest ||
    !EXPLICIT_VERIFICATION_PATTERNS.some((pattern) => pattern.test(userRequest))
  ) {
    return { action: 'none' };
  }

  const requiredKinds = (
    Object.keys(VERIFICATION_KIND_PATTERNS) as VerificationKind[]
  ).filter((kind) => VERIFICATION_KIND_PATTERNS[kind].test(userRequest));
  const successfulCommands = [...successfulVerificationCommands];
  const missingKinds = requiredKinds.filter(
    (kind) =>
      !successfulCommands.some((command) =>
        VERIFICATION_COMMAND_KIND_PATTERNS[kind].test(command)
      )
  );
  const verificationSatisfied =
    requiredKinds.length > 0
      ? missingKinds.length === 0
      : successfulCommands.some(isVerificationCommand);

  if (verificationSatisfied) {
    return { action: 'none' };
  }

  if (retryCount >= MAX_VERIFICATION_RETRIES) {
    return { action: 'fail', message: VERIFICATION_FAILURE_MESSAGE };
  }

  const missingHint =
    requiredKinds.length > 1 && missingKinds.length > 0
      ? ` Missing successful verification categories: ${missingKinds.join(', ')}.`
      : '';
  return { action: 'retry', prompt: `${VERIFICATION_RETRY_PROMPT}${missingHint}` };
}

// ===== Explicit Delegation Requirement =====

const EXPLICIT_DELEGATION_PATTERNS = [
  /\bdelegate\b[\s\S]{0,120}\b(?:Task tool|subagent|agent)\b/i,
  /\b(?:call|use|invoke)\b[\s\S]{0,80}\bTask tool\b/i,
  /(?:委派|交给|调用|使用).{0,60}(?:Task|子代理|子智能体)/,
];

const NEGATED_DELEGATION_PATTERNS = [
  /\b(?:do not|don't|never)\s+(?:delegate|call|use|invoke)\b/i,
  /(?:不要|禁止|无需)(?:委派|调用|使用).{0,20}(?:Task|子代理|子智能体)?/,
];

export function isDelegationForbidden(request: string | undefined): boolean {
  return (
    typeof request === 'string' &&
    NEGATED_DELEGATION_PATTERNS.some((pattern) => pattern.test(request))
  );
}

const SINGLE_TASK_DELEGATION_PATTERNS = [
  /\b(?:call|use|invoke)\b[\s\S]{0,30}\bTask(?: tool)?\b[\s\S]{0,30}\bexactly once\b/i,
  /\bexactly once\b[\s\S]{0,30}\b(?:call|use|invoke)\b[\s\S]{0,30}\bTask(?: tool)?\b/i,
  /\bexactly one\b[\s\S]{0,30}\bTask(?: tool)? calls?\b/i,
  /(?:Task|子代理).{0,20}(?:恰好|仅|只)(?:调用|使用)?一次/,
  /(?:恰好|仅|只)(?:调用|使用)?一次.{0,20}(?:Task|子代理)/,
];

const NEGATED_SINGLE_TASK_DELEGATION_PATTERNS = [
  /\b(?:do not|don't|never)\s+(?:call|use|invoke)\s+(?:the\s+)?Task\b[\s\S]{0,30}\bexactly once\b/i,
  /\bTask\b[\s\S]{0,30}\b(?:does not|doesn't|need not)\b[\s\S]{0,30}\bexactly once\b/i,
  /\bmultiple\s+Task(?: tool)?\s+calls?\s+(?:are\s+)?allowed\b/i,
  /(?:不要|禁止).{0,12}(?:Task|子代理).{0,12}(?:恰好|仅|只)(?:调用|使用)?一次/,
];

type SingleTaskDelegationDirective = 'required' | 'multiple-allowed';

function getSingleTaskDelegationDirective(
  request: string | undefined
): SingleTaskDelegationDirective | undefined {
  if (typeof request !== 'string') return undefined;
  if (
    NEGATED_SINGLE_TASK_DELEGATION_PATTERNS.some((pattern) => pattern.test(request))
  ) {
    return 'multiple-allowed';
  }
  return SINGLE_TASK_DELEGATION_PATTERNS.some((pattern) => pattern.test(request))
    ? 'required'
    : undefined;
}

export function isSingleTaskDelegationRequired(request: string | undefined): boolean {
  return getSingleTaskDelegationDirective(request) === 'required';
}

export function resolveSingleTaskDelegationRequirement(
  requests: readonly (string | undefined)[]
): boolean {
  for (const request of requests) {
    const directive = getSingleTaskDelegationDirective(request);
    if (directive !== undefined) return directive === 'required';
  }
  return false;
}

export const DELEGATION_RETRY_PROMPT =
  'The user explicitly required delegation, but no Task tool call completed ' +
  'successfully. Do not solve the task directly or explain. Your next action ' +
  'must be a Task tool call using the requested subagent.';

export const DELEGATION_FAILURE_MESSAGE =
  'Required delegation did not complete before the retry limit.';

export const MAX_DELEGATION_RETRIES = 3;

export type DelegationRequirementAction =
  | { action: 'retry'; prompt: string }
  | { action: 'fail'; message: string }
  | { action: 'none' };

export function checkDelegationRequirement(
  userRequest: string | readonly string[] | undefined,
  successfulTools: ReadonlySet<string>,
  retryCount: number
): DelegationRequirementAction {
  const requests = (
    typeof userRequest === 'string' ? [userRequest] : (userRequest ?? [])
  )
    .map((request) => request.trim())
    .filter(Boolean);
  const singleTaskRequired = resolveSingleTaskDelegationRequirement(requests);
  let generalDelegationRequired = false;
  if (!singleTaskRequired) {
    for (const request of requests) {
      if (NEGATED_DELEGATION_PATTERNS.some((pattern) => pattern.test(request))) {
        break;
      }
      if (EXPLICIT_DELEGATION_PATTERNS.some((pattern) => pattern.test(request))) {
        generalDelegationRequired = true;
        break;
      }
    }
  }

  if (
    requests.length === 0 ||
    (!singleTaskRequired && !generalDelegationRequired) ||
    successfulTools.has('Task')
  ) {
    return { action: 'none' };
  }

  if (retryCount >= MAX_DELEGATION_RETRIES) {
    return { action: 'fail', message: DELEGATION_FAILURE_MESSAGE };
  }

  return { action: 'retry', prompt: DELEGATION_RETRY_PROMPT };
}

// ===== Explicit Worktree Lifecycle Requirement =====

const EXPLICIT_WORKTREE_PATTERNS = [
  /\b(?:use|create|enter|start|work\s+(?:in|inside))\b.{0,60}\bworktree\b/i,
  /(?:使用|创建|进入).{0,30}(?:worktree|工作树)/i,
];

const EXPLICIT_WORKTREE_EXIT_PATTERNS = [
  /\b(?:exit|leave)\b.{0,40}\bworktree\b/i,
  /\bworktree\b.{0,60}\b(?:action\s+)?(?:keep|remove)\b/i,
  /(?:退出|离开).{0,30}(?:worktree|工作树)/i,
];

const NEGATED_WORKTREE_PATTERNS = [
  /\b(?:do not|don't|never|must not|should not)\b[^.!?;\n]{0,80}\b(?:git\s+)?worktree\b/gi,
  /\bwithout\b[^.!?;\n]{0,60}\b(?:git\s+)?worktree\b/gi,
  /(?:不要|禁止|不得|无需)[^。！？；\n]{0,50}(?:worktree|工作树)/gi,
];

function positiveWorktreeRequest(userRequest: string): string {
  return NEGATED_WORKTREE_PATTERNS.reduce(
    (request, pattern) => request.replace(pattern, ' '),
    userRequest
  );
}

export function isExplicitWorktreeRequest(userRequest: string | undefined): boolean {
  if (typeof userRequest !== 'string') return false;
  const positiveRequest = positiveWorktreeRequest(userRequest);
  return EXPLICIT_WORKTREE_PATTERNS.some((pattern) => pattern.test(positiveRequest));
}

export const WORKTREE_ENTER_RETRY_PROMPT =
  'The user explicitly required git worktree isolation, but EnterWorktree has ' +
  'not completed successfully. Do not continue in the original workspace. Your ' +
  'next action must be an EnterWorktree tool call. Wait for its result before ' +
  'using file or Bash tools.';

export const WORKTREE_EXIT_RETRY_PROMPT =
  'The user explicitly required leaving the managed worktree, but ExitWorktree ' +
  'has not completed successfully. Do not finish or explain. Your next action ' +
  'must be an ExitWorktree tool call using the action requested by the user.';

export const WORKTREE_FAILURE_MESSAGE =
  'Required worktree lifecycle did not complete before the retry limit.';

export const MAX_WORKTREE_RETRIES = 3;

export type WorktreeRequirementAction =
  | {
      action: 'retry';
      tool: 'EnterWorktree' | 'ExitWorktree';
      prompt: string;
    }
  | { action: 'fail'; message: string }
  | { action: 'none' };

export function checkWorktreeRequirement(
  userRequest: string | undefined,
  successfulTools: ReadonlySet<string>,
  retryCount: number
): WorktreeRequirementAction {
  if (!userRequest) {
    return { action: 'none' };
  }
  const positiveRequest = positiveWorktreeRequest(userRequest);
  if (!isExplicitWorktreeRequest(positiveRequest)) {
    return { action: 'none' };
  }

  const requiresExit = EXPLICIT_WORKTREE_EXIT_PATTERNS.some((pattern) =>
    pattern.test(positiveRequest)
  );
  if (successfulTools.has('TaskWorktree')) {
    return { action: 'none' };
  }
  const missingTool = !successfulTools.has('EnterWorktree')
    ? ('EnterWorktree' as const)
    : requiresExit && !successfulTools.has('ExitWorktree')
      ? ('ExitWorktree' as const)
      : undefined;

  if (!missingTool) {
    return { action: 'none' };
  }
  if (retryCount >= MAX_WORKTREE_RETRIES) {
    return { action: 'fail', message: WORKTREE_FAILURE_MESSAGE };
  }

  return {
    action: 'retry',
    tool: missingTool,
    prompt:
      missingTool === 'EnterWorktree'
        ? WORKTREE_ENTER_RETRY_PROMPT
        : WORKTREE_EXIT_RETRY_PROMPT,
  };
}

// ===== Stop Hook =====

const STOP_HOOK_TIMEOUT = 30_000;

export type StopHookAction =
  | { action: 'stop' }
  | { action: 'continue'; reason?: string };

/**
 * 执行 stop hook 并加超时保护。
 *
 * Bug fix: 为 stop hook 增加 Promise.race + timeout(30s)，
 * 超时按 shouldStop: true 处理并打 warning。
 */
export async function checkStopHook(context: {
  sessionId: string;
  workspaceRoot?: string;
  permissionMode: PermissionMode;
  reason?: string;
  abortSignal?: AbortSignal;
}): Promise<StopHookAction> {
  try {
    const hookManager = HookManager.getInstance();

    const hookPromise = hookManager.executeStopHooks({
      projectDir: context.workspaceRoot ?? getCwd(),
      sessionId: context.sessionId,
      permissionMode: context.permissionMode,
      reason: context.reason,
      abortSignal: context.abortSignal,
    });

    let timerId: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<'timeout'>((resolve) => {
      timerId = setTimeout(() => resolve('timeout'), STOP_HOOK_TIMEOUT);
    });

    try {
      const raceResult = await Promise.race([hookPromise, timeoutPromise]);

      if (raceResult === 'timeout') {
        logger.warn(
          `[Loop] Stop hook 超时 (${STOP_HOOK_TIMEOUT}ms)，按 shouldStop: true 处理`
        );
        return { action: 'stop' };
      }

      const stopResult = raceResult;
      if (!stopResult.shouldStop) {
        return {
          action: 'continue',
          reason: stopResult.continueReason,
        };
      }

      return { action: 'stop' };
    } finally {
      clearTimeout(timerId!);
    }
  } catch (hookError) {
    logger.warn('[Loop] Stop hook execution failed:', hookError);
    // hook 执行失败时按 stop 处理（保守策略）
    return { action: 'stop' };
  }
}
