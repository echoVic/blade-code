/**
 * Headless CLI runner for the full agent loop.
 *
 * This keeps the agent behavior intact while replacing Ink rendering with
 * terminal output. Internal callbacks stay camelCase to match `LoopOptions`,
 * while the exported JSONL contract remains snake_case and versioned.
 */
import type { Argv } from 'yargs';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { Agent } from '../agent/Agent.js';
import { drainLoop } from '../agent/loop/index.js';
import type { LoopEvent } from '../agent/loop/types.js';
import { SessionRuntime } from '../agent/runtime/SessionRuntime.js';
import type { ChatContext } from '../agent/types.js';
import { parseCliAgents } from '../cli/agents.js';
import { globalOptions } from '../cli/config.js';
import {
  loadConfiguration,
  validateOutput,
  validatePermissions,
} from '../cli/middleware.js';
import { MAX_AGENT_TURNS } from '../config/maxTurns.js';
import { PermissionMode } from '../config/types.js';
import type { SessionTaskIsolation } from '../context/types.js';
import {
  type SchemaValidationError,
  type Static,
  StringEnum,
  safeParseSchema,
  Type,
} from '../schema/index.js';
import { Bus } from '../server/bus.js';
import type { Message } from '../services/ChatServiceInterface.js';
import { SessionTaskService } from '../services/SessionTaskService.js';
import type { TaskListItem } from '../tools/builtin/task/taskListTypes.js';
import type {
  ConfirmationDetails,
  ConfirmationResponse,
} from '../tools/types/ExecutionTypes.js';
import {
  formatToolCallSummary,
  formatToolDisplay,
} from '../ui/utils/toolFormatters.js';
import { getCwd } from '../utils/cwd.js';
import {
  createHeadlessJsonlEvent,
  type HeadlessJsonlEventPayload,
  type HeadlessJsonlEventType,
} from './headlessEvents.js';
import {
  initializeCliPlugins,
  normalizeCliInput,
  readCliInput,
} from './shared/commandInput.js';
import { resolveNonInteractiveSession } from './shared/sessionContext.js';

/** Minimal writable stream contract used by headless output sinks. */
interface WritableLike {
  write(chunk: string): boolean | void;
}

/** Output streams used by the headless runner. */
interface HeadlessIO {
  stdout: WritableLike;
  stderr: WritableLike;
}

interface HeadlessRunControl {
  signal?: AbortSignal;
}

function createHeadlessAbortSignal(control?: HeadlessRunControl): {
  signal: AbortSignal;
  dispose: () => void;
} {
  if (control?.signal) {
    return { signal: control.signal, dispose: () => undefined };
  }

  const controller = new AbortController();
  const interrupt = () => controller.abort('interrupt');
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);

  return {
    signal: controller.signal,
    dispose: () => {
      process.removeListener('SIGINT', interrupt);
      process.removeListener('SIGTERM', interrupt);
    },
  };
}

type HeadlessOutputFormat = 'text' | 'jsonl';

const HeadlessOutputFormatSchema = StringEnum(['text', 'jsonl']);

export const HeadlessOptionsSchema = Type.Object({
  headless: Type.Optional(Type.Boolean()),
  message: Type.Optional(Type.String()),
  _: Type.Optional(Type.Array(Type.Union([Type.String(), Type.Number()]))),
  model: Type.Optional(Type.String()),
  systemPrompt: Type.Optional(Type.String()),
  appendSystemPrompt: Type.Optional(Type.String()),
  maxTurns: Type.Optional(
    Type.Refine(
      Type.Integer({ maximum: MAX_AGENT_TURNS }),
      (value) => value === -1 || value > 0,
      () => 'must be -1 or a positive integer'
    )
  ),
  permissionMode: Type.Optional(Type.Enum(PermissionMode)),
  mcpConfig: Type.Optional(Type.Array(Type.String())),
  strictMcpConfig: Type.Optional(Type.Boolean()),
  sessionId: Type.Optional(Type.String()),
  allowedTools: Type.Optional(Type.Array(Type.String())),
  disallowedTools: Type.Optional(Type.Array(Type.String())),
  agents: Type.Optional(Type.String()),
  continue: Type.Optional(Type.Boolean()),
  resume: Type.Optional(Type.Union([Type.String(), Type.Boolean()])),
  forkSession: Type.Optional(Type.Boolean()),
  taskIsolation: Type.Optional(StringEnum(['local', 'worktree'])),
  outputFormat: Type.Optional(HeadlessOutputFormatSchema),
});

export interface HeadlessOptions {
  /** Enables headless execution instead of the Ink UI. */
  headless?: boolean;
  /** Primary user message for this run. */
  message?: string;
  /** Positional arguments forwarded by yargs. */
  _?: (string | number)[];
  /** Optional model override for the current run. */
  model?: string;
  /** Replaces the default system prompt when provided. */
  systemPrompt?: string;
  /** Appends to the default system prompt when provided. */
  appendSystemPrompt?: string;
  /** Maximum number of agent turns for this run. */
  maxTurns?: number;
  /** Permission mode override; defaults to YOLO in headless mode. */
  permissionMode?: PermissionMode | string;
  /** Optional MCP config sources for this run. */
  mcpConfig?: string[];
  /** Whether MCP config loading should fail hard. */
  strictMcpConfig?: boolean;
  /** Session identifier used in the chat context. */
  sessionId?: string;
  /** Tool whitelist for this run. */
  allowedTools?: string[];
  /** Tool blacklist for this run. */
  disallowedTools?: string[];
  /** Invocation-scoped custom agent definitions. */
  agents?: string;
  /** Continue the most recent conversation. */
  continue?: boolean;
  /** Resume a specific conversation. */
  resume?: string | boolean;
  /** Fork resumed history into an independent session. */
  forkSession?: boolean;
  /** Run a new top-level task in the local workspace or an isolated worktree. */
  taskIsolation?: SessionTaskIsolation;
  /** Terminal output format. */
  outputFormat?: string;
}

type ValidatedHeadlessOptions = Static<typeof HeadlessOptionsSchema>;

interface HeadlessStreamSnapshot {
  openedThinking: boolean;
  wroteAssistantContent: boolean;
}

interface HeadlessPhaseContext {
  turn?: number;
  toolName?: string;
  target?: string;
}

type HeadlessPhaseName =
  | 'turn'
  | 'searching'
  | 'inspecting'
  | 'target_hit'
  | 'executing'
  | 'completed';
type HeadlessPhaseStatus = 'ongoing' | 'hit' | 'done';

interface HeadlessPhaseState {
  targetLocked: boolean;
}

class HeadlessStreamState {
  private openedThinking = false;
  private wroteAssistantContent = false;

  markAssistantContent(): void {
    this.wroteAssistantContent = true;
  }

  setThinkingOpened(isOpened: boolean): void {
    this.openedThinking = isOpened;
  }

  hasOpenThinking(): boolean {
    return this.openedThinking;
  }

  completeStream(): HeadlessStreamSnapshot {
    const snapshot = {
      openedThinking: this.openedThinking,
      wroteAssistantContent: this.wroteAssistantContent,
    };
    this.openedThinking = false;
    this.wroteAssistantContent = false;
    return snapshot;
  }
}

function formatValidationIssues(error: SchemaValidationError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || 'options'}: ${issue.message}`)
    .join('; ');
}

function validateHeadlessOptions(options: HeadlessOptions): ValidatedHeadlessOptions {
  const result = safeParseSchema(HeadlessOptionsSchema, options);
  if (!result.success) {
    throw new Error(
      `Invalid headless options: ${formatValidationIssues(result.error)}`
    );
  }
  return result.data;
}

function headlessCommand(yargs: Argv) {
  return yargs.command(
    '* [message]',
    'Run full agent loop without Ink UI and print events to the terminal',
    (y) =>
      y
        .positional('message', {
          describe: 'Message to process',
          type: 'string',
        })
        .option('headless', {
          type: 'boolean',
          describe:
            'Run full agent loop without Ink UI and print events to the terminal',
        })
        .option('model', {
          describe: 'Model ID for this run',
          type: 'string',
        })
        .option('system-prompt', {
          describe: 'Replace the default system prompt',
          type: 'string',
        })
        .option('append-system-prompt', {
          describe: 'Append a system prompt to the default system prompt',
          type: 'string',
        })
        .option('max-turns', {
          alias: ['maxTurns'],
          describe: 'Maximum conversation turns (-1: unlimited, N>0: limit to N turns)',
          type: 'number',
        })
        .option('output-format', {
          alias: ['outputFormat'],
          choices: ['text', 'jsonl'],
          describe: 'Headless output format',
          type: 'string',
        })
        .option('task-isolation', {
          alias: ['taskIsolation'],
          choices: ['local', 'worktree'] as const,
          describe: 'Dispatch a new durable task in the selected workspace mode',
          type: 'string',
        }),
    async (argv: HeadlessOptions) => {
      if (!argv.headless) {
        return;
      }

      const exitCode = await runHeadless(argv);
      process.exit(exitCode);
    }
  );
}

function writeLine(writer: WritableLike, line = ''): void {
  writer.write(`${line}\n`);
}

function formatTask(task: TaskListItem): string {
  return `[task] [${task.status}] ${task.subject}`;
}

function createConfirmationHandler() {
  return {
    requestConfirmation: async (
      _details: ConfirmationDetails
    ): Promise<ConfirmationResponse> => ({
      approved: true,
      reason: 'headless-auto-approved',
      scope: 'session',
    }),
  };
}

/**
 * 从 API 错误中提取用户友好的错误信息
 */
function extractHeadlessErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return 'Unknown error';

  const retryError = error as Error & { lastError?: Error };
  const rootError = retryError.lastError ?? error;
  const apiError = rootError as Error & { responseBody?: string; statusCode?: number };

  if (apiError.responseBody) {
    try {
      const body = JSON.parse(apiError.responseBody);
      const msg = body?.error?.message;
      if (msg) {
        return apiError.statusCode ? `${msg} (HTTP ${apiError.statusCode})` : msg;
      }
    } catch {
      // fallback
    }
  }

  const lastErrorMatch = error.message.match(/Last error:\s*(.+)$/);
  if (lastErrorMatch) return lastErrorMatch[1];

  return error.message;
}

function resolveOutputFormat(outputFormat?: string): HeadlessOutputFormat {
  return outputFormat === 'jsonl' ? 'jsonl' : 'text';
}

function extractToolTarget(
  toolName: string,
  params: Record<string, unknown>
): string | undefined {
  const stringParam = (...keys: string[]) => {
    for (const key of keys) {
      const value = params[key];
      if (typeof value === 'string' && value.trim() !== '') {
        return value;
      }
    }
    return undefined;
  };

  switch (toolName) {
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'UndoEdit':
      return stringParam('file_path');
    case 'NotebookEdit':
      return stringParam('notebook_path');
    case 'Grep':
      return stringParam('path', 'pattern');
    case 'Glob':
      return stringParam('pattern');
    case 'WebFetch':
      return stringParam('url');
    case 'WebSearch':
      return stringParam('query');
    case 'Bash':
      return stringParam('command', 'description');
    case 'Task':
      return stringParam('description');
    case 'LSP':
      return stringParam('filePath', 'operation');
    case 'EnterWorktree':
      return stringParam('name');
    case 'ExitWorktree':
      return stringParam('action');
    default:
      return undefined;
  }
}

function getPhaseForTool(
  toolName: string,
  summary: string,
  target: string | undefined,
  state: HeadlessPhaseState
): {
  phase: HeadlessPhaseName;
  status: HeadlessPhaseStatus;
  message: string;
  shouldLockTarget: boolean;
} {
  const searchTools = new Set(['Glob', 'Grep', 'WebSearch', 'LS']);
  const readTools = new Set(['Read', 'WebFetch']);
  const actionTools = new Set([
    'Edit',
    'Write',
    'NotebookEdit',
    'Bash',
    'LSP',
    'UndoEdit',
    'EnterWorktree',
    'ExitWorktree',
  ]);

  if (actionTools.has(toolName) && !state.targetLocked) {
    return {
      phase: 'target_hit',
      status: 'hit',
      message: `Target locked: ${summary}`,
      shouldLockTarget: true,
    };
  }

  if (state.targetLocked) {
    return {
      phase: 'executing',
      status: 'hit',
      message: target ? `Working within target: ${summary}` : `Executing: ${summary}`,
      shouldLockTarget: false,
    };
  }

  if (searchTools.has(toolName)) {
    return {
      phase: 'searching',
      status: 'ongoing',
      message: `Still searching: ${summary}`,
      shouldLockTarget: false,
    };
  }

  if (readTools.has(toolName)) {
    return {
      phase: 'inspecting',
      status: 'ongoing',
      message: `Inspecting candidate: ${summary}`,
      shouldLockTarget: false,
    };
  }

  return {
    phase: 'executing',
    status: state.targetLocked ? 'hit' : 'ongoing',
    message: `Executing: ${summary}`,
    shouldLockTarget: false,
  };
}

function createEventWriter(io: HeadlessIO, outputFormat: HeadlessOutputFormat) {
  const writeJsonl = <TType extends HeadlessJsonlEventType>(
    type: TType,
    payload: HeadlessJsonlEventPayload<TType>
  ) => {
    io.stdout.write(`${JSON.stringify(createHeadlessJsonlEvent(type, payload))}\n`);
  };

  return {
    contentDelta(delta: string) {
      if (outputFormat === 'jsonl') {
        writeJsonl('content_delta', { delta });
        return;
      }
      io.stdout.write(delta);
    },
    thinkingDelta(delta: string, openedThinking: boolean): boolean {
      if (outputFormat === 'jsonl') {
        writeJsonl('thinking_delta', { delta });
        return openedThinking;
      }
      if (!openedThinking) {
        io.stderr.write('[thinking] ');
      }
      io.stderr.write(delta);
      return true;
    },
    thinking(content: string) {
      if (outputFormat === 'jsonl') {
        writeJsonl('thinking', { content });
        return;
      }
      writeLine(io.stderr, `[thinking] ${content}`);
    },
    streamEnd(wroteAssistantContent: boolean, openedThinking: boolean) {
      if (outputFormat === 'jsonl') {
        writeJsonl('stream_end', {});
        return;
      }
      if (openedThinking) {
        io.stderr.write('\n');
      }
      if (wroteAssistantContent) {
        io.stdout.write('\n');
      }
    },
    content(content: string) {
      if (outputFormat === 'jsonl') {
        writeJsonl('content', { content });
        return;
      }
      writeLine(io.stdout, content);
    },
    toolStart(
      toolName: string,
      summary: string,
      target?: string,
      toolKind?: 'readonly' | 'write' | 'execute'
    ) {
      if (outputFormat === 'jsonl') {
        writeJsonl('tool_start', {
          tool_name: toolName,
          summary,
          target,
          tool_kind: toolKind,
        });
        return;
      }
      writeLine(io.stderr, `[tool:start] ${summary}`);
    },
    toolResult(
      toolName: string,
      summary: string,
      target?: string,
      toolKind?: 'readonly' | 'write' | 'execute',
      result?: {
        success: boolean;
        errorType?: string;
        errorMessage?: string;
      }
    ) {
      if (outputFormat === 'jsonl') {
        writeJsonl('tool_result', {
          tool_name: toolName,
          summary,
          target,
          tool_kind: toolKind,
          success: result?.success,
          error_type: result?.errorType,
          error_message: result?.errorMessage,
        });
        return;
      }
      writeLine(io.stderr, `[tool:result] ${summary}`);
    },
    phase(
      phase: HeadlessPhaseName,
      status: HeadlessPhaseStatus,
      message: string,
      context: HeadlessPhaseContext = {}
    ) {
      if (outputFormat === 'jsonl') {
        writeJsonl('phase', {
          phase,
          status,
          message,
          turn: context.turn,
          tool_name: context.toolName,
          target: context.target,
        });
        return;
      }
      writeLine(io.stderr, `[phase:${phase}] ${message}`);
    },
    toolDetail(toolName: string, detail: string) {
      if (outputFormat === 'jsonl') {
        writeJsonl('tool_detail', { tool_name: toolName, detail });
        return;
      }
      writeLine(io.stderr, detail);
    },
    taskUpdate(tasks: TaskListItem[]) {
      if (outputFormat === 'jsonl') {
        writeJsonl('task_update', { tasks });
        return;
      }
      for (const task of tasks) {
        writeLine(io.stderr, formatTask(task));
      }
    },
    subagent(
      event: Extract<LoopEvent, { kind: 'subagent_spawned' | 'subagent_completed' }>
    ) {
      const spawned = event.kind === 'subagent_spawned';
      if (outputFormat === 'jsonl') {
        writeJsonl('subagent', {
          state: spawned ? 'spawned' : 'completed',
          session_id: event.sessionId,
          subagent_type: spawned ? event.type : undefined,
          success: spawned ? undefined : event.success,
          summary: spawned ? undefined : event.summary,
          resumed_from: event.resumedFrom,
          root_agent_id: event.rootAgentId,
          resume_depth: event.resumeDepth,
        });
        return;
      }
      writeLine(
        io.stderr,
        `[subagent:${spawned ? 'spawned' : 'completed'}] ${event.sessionId}${event.resumedFrom ? ` resumed from ${event.resumedFrom}` : ''}`
      );
    },
    tokenUsage(usage: {
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      maxContextTokens: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      costUsd?: number;
    }) {
      if (outputFormat === 'jsonl') {
        writeJsonl('token_usage', {
          input_tokens: usage.inputTokens,
          output_tokens: usage.outputTokens,
          total_tokens: usage.totalTokens,
          max_context_tokens: usage.maxContextTokens,
          cache_read_tokens: usage.cacheReadTokens,
          cache_write_tokens: usage.cacheWriteTokens,
          cost_usd: usage.costUsd,
        });
        return;
      }
      writeLine(
        io.stderr,
        `[tokens] in=${usage.inputTokens} out=${usage.outputTokens} total=${usage.totalTokens} / ${usage.maxContextTokens}`
      );
    },
    compacting(isCompacting: boolean) {
      if (outputFormat === 'jsonl') {
        writeJsonl('compacting', {
          state: isCompacting ? 'started' : 'completed',
        });
        return;
      }
      writeLine(
        io.stderr,
        isCompacting ? '[context] compacting started' : '[context] compacting completed'
      );
    },
    turnLimit(turnsCount: number) {
      if (outputFormat === 'jsonl') {
        writeJsonl('turn_limit', {
          turns_count: turnsCount,
          action: 'continue',
        });
        return;
      }
      writeLine(io.stderr, `[turn-limit] continuing after ${turnsCount} turns`);
    },
    taskSession(task: {
      sessionId: string;
      projectPath: string;
      sourceProjectPath: string;
      isolation: SessionTaskIsolation;
      worktreeBranch?: string;
      baseCommit?: string;
    }) {
      if (outputFormat === 'jsonl') {
        writeJsonl('task_session', {
          session_id: task.sessionId,
          project_path: task.projectPath,
          source_project_path: task.sourceProjectPath,
          isolation: task.isolation,
          worktree_branch: task.worktreeBranch,
          base_commit: task.baseCommit,
        });
        return;
      }
      writeLine(
        io.stderr,
        `[task:${task.isolation}] ${task.sessionId} ${task.sourceProjectPath} -> ${task.projectPath}${task.worktreeBranch ? ` (${task.worktreeBranch})` : ''}`
      );
    },
    taskAdmission(admission: {
      state: 'queued' | 'running';
      queuePosition?: number;
      queueDepth: number;
      inFlight: number;
      maxConcurrentTasks: number;
    }) {
      if (outputFormat === 'jsonl') {
        writeJsonl('task_admission', {
          state: admission.state,
          queue_position: admission.queuePosition,
          queue_depth: admission.queueDepth,
          in_flight: admission.inFlight,
          max_concurrent_tasks: admission.maxConcurrentTasks,
        });
        return;
      }
      writeLine(
        io.stderr,
        admission.state === 'queued'
          ? `[task:queued] position ${admission.queuePosition ?? 1}/${admission.queueDepth} (running ${admission.inFlight}/${admission.maxConcurrentTasks})`
          : `[task:running] admitted (running ${admission.inFlight}/${admission.maxConcurrentTasks})`
      );
    },
    output(content: string, exitCode = 0) {
      if (outputFormat === 'jsonl') {
        writeJsonl('output', { content, exit_code: exitCode });
        return;
      }
      writeLine(exitCode === 0 ? io.stdout : io.stderr, content);
    },
    error(message: string) {
      if (outputFormat === 'jsonl') {
        writeJsonl('error', { message });
        return;
      }
      writeLine(io.stderr, message);
    },
  };
}

export async function runHeadless(
  options: HeadlessOptions,
  io: HeadlessIO = { stdout: process.stdout, stderr: process.stderr },
  control?: HeadlessRunControl
): Promise<number> {
  let outputFormat: HeadlessOutputFormat = 'text';
  let eventWriter = createEventWriter(io, outputFormat);
  const streamState = new HeadlessStreamState();
  const phaseState: HeadlessPhaseState = { targetLocked: false };
  let runtime: SessionRuntime | undefined;
  let taskAdmissionUnsubscribe: (() => void) | undefined;
  const abortControl = createHeadlessAbortSignal(control);

  try {
    const validatedOptions = validateHeadlessOptions(options);
    outputFormat = resolveOutputFormat(validatedOptions.outputFormat);
    eventWriter = createEventWriter(io, outputFormat);

    await initializeCliPlugins();

    const rawInput = await readCliInput(validatedOptions);
    const normalized = await normalizeCliInput(rawInput);
    if (normalized.mode === 'output') {
      if (normalized.content) {
        eventWriter.output(normalized.content, normalized.exitCode ?? 0);
      }
      return normalized.exitCode ?? 0;
    }

    const permissionMode =
      (validatedOptions.permissionMode as PermissionMode | undefined) ??
      PermissionMode.YOLO;
    if (
      validatedOptions.taskIsolation &&
      (validatedOptions.continue ||
        validatedOptions.resume ||
        validatedOptions.forkSession)
    ) {
      throw new Error(
        '--task-isolation cannot be combined with --continue, --resume, or --fork-session'
      );
    }
    const { sessionId, messages } = await resolveNonInteractiveSession({
      sessionId: validatedOptions.sessionId,
      continue: validatedOptions.continue,
      resume: validatedOptions.resume,
      forkSession: validatedOptions.forkSession,
      fallbackSessionPrefix: 'headless',
    });
    const createdTask = validatedOptions.taskIsolation
      ? await SessionTaskService.createSessionTask({
          sessionId,
          prompt: normalized.content,
          sourceProjectPath: getCwd(),
          isolation: validatedOptions.taskIsolation,
        })
      : undefined;
    const workspaceRoot = createdTask?.metadata.projectPath ?? getCwd();
    if (createdTask) {
      eventWriter.taskSession({
        sessionId,
        projectPath: workspaceRoot,
        sourceProjectPath: createdTask.metadata.taskSourceProjectPath ?? getCwd(),
        isolation: validatedOptions.taskIsolation!,
        worktreeBranch: createdTask.metadata.taskWorktreeBranch,
        baseCommit: createdTask.metadata.taskBaseCommit,
      });
      taskAdmissionUnsubscribe = Bus.subscribe((event) => {
        if (
          event.type !== 'task.status' ||
          event.sessionId !== sessionId ||
          event.projectPath !== workspaceRoot ||
          !['queued', 'running'].includes(String(event.properties.taskStatus)) ||
          typeof event.properties.taskQueueDepth !== 'number' ||
          typeof event.properties.taskInFlight !== 'number' ||
          typeof event.properties.taskConcurrencyLimit !== 'number'
        ) {
          return;
        }
        eventWriter.taskAdmission({
          state: event.properties.taskStatus as 'queued' | 'running',
          queuePosition:
            typeof event.properties.taskQueuePosition === 'number'
              ? event.properties.taskQueuePosition
              : undefined,
          queueDepth: event.properties.taskQueueDepth,
          inFlight: event.properties.taskInFlight,
          maxConcurrentTasks: event.properties.taskConcurrencyLimit,
        });
      });
    }
    const contextMessages: Message[] = [...messages];
    const chatContext: ChatContext = {
      messages: contextMessages,
      userId: 'cli-user',
      sessionId,
      workspaceRoot,
      permissionMode,
      signal: abortControl.signal,
      ...(createdTask?.taskWorktree ? { worktreeActive: true } : {}),
      confirmationHandler: createConfirmationHandler(),
    };

    runtime = await SessionRuntime.create({
      sessionId,
      workspaceRoot,
      modelId: validatedOptions.model,
      mcpConfig: validatedOptions.mcpConfig,
      strictMcpConfig: validatedOptions.strictMcpConfig,
      agents: validatedOptions.agents
        ? parseCliAgents(validatedOptions.agents)
        : undefined,
      ...(createdTask?.taskWorktree ? { taskWorktree: createdTask.taskWorktree } : {}),
      ...(createdTask?.metadata.taskIsolation
        ? { taskIsolation: createdTask.metadata.taskIsolation }
        : {}),
    });
    const effectiveMaxTurns = validatedOptions.maxTurns ?? runtime.getConfig().maxTurns;
    const toolBlacklist = createdTask?.taskWorktree
      ? [
          ...new Set([
            ...(validatedOptions.disallowedTools ?? []),
            'EnterWorktree',
            'ExitWorktree',
          ]),
        ]
      : validatedOptions.disallowedTools;

    const agent = await Agent.createWithRuntime(runtime, {
      sessionId,
      systemPrompt: validatedOptions.systemPrompt,
      appendSystemPrompt: validatedOptions.appendSystemPrompt,
      maxTurns: validatedOptions.maxTurns,
      modelId: validatedOptions.model,
      permissionMode,
      toolWhitelist: validatedOptions.allowedTools,
      toolBlacklist,
      mcpConfig: validatedOptions.mcpConfig,
      strictMcpConfig: validatedOptions.strictMcpConfig,
    });

    // Phase 4: 使用 chatStream() + onEvent 事件驱动消费
    const loopResult = await drainLoop(
      agent.chatStream(normalized.content, chatContext, {
        stream: true,
        signal: abortControl.signal,
        maxTurns: validatedOptions.maxTurns,
        ...(effectiveMaxTurns === -1
          ? {
              onTurnLimitReached: async (data: { turnsCount: number }) => {
                eventWriter.turnLimit(data.turnsCount);
                return { continue: true, reason: 'headless-auto-continue' };
              },
            }
          : {}),
      }),
      async (event: LoopEvent) => {
        switch (event.kind) {
          // --- 流式增量 ---
          case 'content_delta':
            streamState.markAssistantContent();
            eventWriter.contentDelta(event.delta);
            break;
          case 'thinking_delta':
            streamState.setThinkingOpened(
              eventWriter.thinkingDelta(event.delta, streamState.hasOpenThinking())
            );
            break;

          // --- 流结束 flush ---
          case 'stream_end': {
            const snapshot = streamState.completeStream();
            eventWriter.streamEnd(
              snapshot.wroteAssistantContent,
              snapshot.openedThinking
            );
            break;
          }

          // --- 工具事件 ---
          case 'tool_start': {
            const toolCall = event.toolCall;
            if (!('function' in toolCall)) break;
            // 任务列表工具由 task_update 处理，避免重复输出
            if (
              ['TaskCreate', 'TaskUpdate', 'TaskList'].includes(toolCall.function.name)
            )
              break;
            try {
              const params = JSON.parse(toolCall.function.arguments);
              const summary = formatToolCallSummary(toolCall.function.name, params);
              const target = extractToolTarget(toolCall.function.name, params);
              const phaseInfo = getPhaseForTool(
                toolCall.function.name,
                summary,
                target,
                phaseState
              );
              if (phaseInfo.shouldLockTarget) {
                phaseState.targetLocked = true;
              }
              eventWriter.phase(phaseInfo.phase, phaseInfo.status, phaseInfo.message, {
                toolName: toolCall.function.name,
                target,
              });
              eventWriter.toolStart(
                toolCall.function.name,
                summary,
                target,
                event.toolKind
              );
            } catch {
              eventWriter.phase(
                phaseState.targetLocked ? 'executing' : 'searching',
                phaseState.targetLocked ? 'hit' : 'ongoing',
                phaseState.targetLocked
                  ? `Working within target: ${toolCall.function.name}`
                  : `Still searching: ${toolCall.function.name}`,
                { toolName: toolCall.function.name }
              );
              eventWriter.toolStart(
                toolCall.function.name,
                toolCall.function.name,
                undefined,
                event.toolKind
              );
            }
            break;
          }
          case 'tool_result': {
            const toolCall = event.toolCall;
            if (!('function' in toolCall)) break;
            let target: string | undefined;
            try {
              const params = JSON.parse(toolCall.function.arguments);
              target = extractToolTarget(toolCall.function.name, params);
            } catch {
              target = undefined;
            }
            const display = formatToolDisplay(toolCall.function.name, event.result);
            eventWriter.toolResult(
              toolCall.function.name,
              display.summary,
              target,
              undefined,
              {
                success: event.result.success,
                errorType: event.result.error?.type,
                errorMessage: event.result.error?.message,
              }
            );
            if (display.detail) {
              eventWriter.toolDetail(toolCall.function.name, display.detail);
            }
            break;
          }

          // --- Token 使用 ---
          case 'token_usage':
            eventWriter.tokenUsage(event.usage);
            break;

          // --- 压缩 ---
          case 'compaction':
            eventWriter.compacting(event.phase === 'start');
            break;

          // --- 业务事件 ---
          case 'task_update':
            eventWriter.taskUpdate(event.tasks);
            break;

          case 'steering_applied':
          case 'follow_up_started':
          case 'goal_updated':
          case 'goal_continuation_started':
            break;

          case 'subagent_spawned':
          case 'subagent_completed':
            eventWriter.subagent(event);
            break;

          // --- 模型降级 ---
          case 'model_fallback':
            // 在 headless 模式下不需要特殊处理
            break;

          // --- 系统事件 ---
          case 'turn_start':
            if (event.turn === 1) {
              phaseState.targetLocked = false;
            }
            eventWriter.phase(
              'turn',
              phaseState.targetLocked ? 'hit' : 'ongoing',
              `Turn ${event.turn} started`,
              { turn: event.turn }
            );
            break;

          default: {
            const _exhaustive: never = event;
            void _exhaustive;
          }
        }
      }
    );

    // 输出截断告警
    if (loopResult.metadata?.outputTruncated) {
      eventWriter.error('[warning] 输出因达到 token 上限被截断，部分内容可能不完整。');
    }

    if (!loopResult.success) {
      eventWriter.error(
        `Error: ${loopResult.error?.message ?? 'Agent execution failed'}`
      );
      return 1;
    }

    eventWriter.phase('completed', 'done', 'Headless run completed');

    return 0;
  } catch (error) {
    if (streamState.hasOpenThinking() && outputFormat === 'text') {
      io.stderr.write('\n');
    }
    eventWriter.error(`Error: ${extractHeadlessErrorMessage(error)}`);
    return 1;
  } finally {
    taskAdmissionUnsubscribe?.();
    try {
      await runtime?.dispose();
    } finally {
      abortControl.dispose();
    }
  }
}

export async function handleHeadlessMode(): Promise<boolean> {
  const argv = process.argv.slice(2);
  const headlessRequested = argv.includes('--headless');
  if (!headlessRequested) {
    return false;
  }

  const {
    headless: _h,
    'output-format': _of,
    'system-prompt': _sp,
    'append-system-prompt': _asp,
    'max-turns': _mt,
    ...cliOptions
  } = globalOptions;

  const cli = yargs(hideBin(process.argv))
    .scriptName('blade')
    .strict(false)
    .options(cliOptions)
    .middleware([loadConfiguration, validatePermissions, validateOutput]);

  headlessCommand(cli);
  await cli.parse();
  return true;
}
