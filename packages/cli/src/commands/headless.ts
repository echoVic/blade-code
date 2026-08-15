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
import { SessionInteractionService } from '../services/SessionInteractionService.js';
import { SessionService } from '../services/SessionService.js';
import { SessionTaskService } from '../services/SessionTaskService.js';
import { STRUCTURED_OUTPUT_TOOL_NAME } from '../services/StructuredOutputService.js';
import { getCurrentModel } from '../store/vanilla.js';
import type { TaskListItem } from '../tools/builtin/task/taskListTypes.js';
import {
  fitToolDisplayForSurface,
  HEADLESS_TOOL_DETAIL_MAX_CHARS,
} from '../tools/display/ToolResultProjector.js';
import type {
  ConfirmationDetails,
  ConfirmationResponse,
  ToolProgressUpdate,
} from '../tools/types/ExecutionTypes.js';
import {
  formatToolCallSummary,
  formatToolDisplay,
} from '../ui/utils/toolFormatters.js';
import { getCwd } from '../utils/cwd.js';
import {
  HeadlessOutputEgress,
  type HeadlessOutputIO,
  type HeadlessWritableLike,
} from './HeadlessOutputEgress.js';
import {
  createHeadlessJsonlEvent,
  type HeadlessJsonlEventPayload,
  type HeadlessJsonlEventType,
} from './headlessEvents.js';
import {
  initializeCliPlugins,
  normalizeCliInput,
  readCliInput,
  readOptionalCliInput,
} from './shared/commandInput.js';
import { resolveCliOutputSchema } from './shared/outputSchema.js';
import { resolveNonInteractiveSession } from './shared/sessionContext.js';

interface HeadlessRunControl {
  signal?: AbortSignal;
  stdin?: NodeJS.ReadStream;
}

interface HeadlessBackgroundHandoff {
  auto_backgrounded: true;
  background_reason: 'foreground_budget';
  foreground_budget_ms: number;
  shell_id: string;
  pid?: number;
  terminal_transport: 'local' | 'acp';
}

function projectBackgroundHandoff(
  metadata: unknown
): HeadlessBackgroundHandoff | undefined {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return undefined;
  }
  const value = metadata as Record<string, unknown>;
  if (
    value.auto_backgrounded !== true ||
    value.background_reason !== 'foreground_budget' ||
    !Number.isSafeInteger(value.foreground_budget_ms) ||
    (value.foreground_budget_ms as number) <= 0 ||
    typeof value.shell_id !== 'string' ||
    !/^bash_[A-Za-z0-9-]+$/.test(value.shell_id) ||
    value.shell_id.length > 128 ||
    (value.terminal_transport !== 'local' && value.terminal_transport !== 'acp') ||
    (value.pid !== undefined &&
      (!Number.isSafeInteger(value.pid) || (value.pid as number) <= 0))
  ) {
    return undefined;
  }
  return {
    auto_backgrounded: true,
    background_reason: 'foreground_budget',
    foreground_budget_ms: value.foreground_budget_ms as number,
    shell_id: value.shell_id,
    ...(value.pid === undefined ? {} : { pid: value.pid as number }),
    terminal_transport: value.terminal_transport,
  };
}

function createHeadlessAbortSignal(control?: HeadlessRunControl): {
  signal: AbortSignal;
  abort: (reason?: unknown) => void;
  dispose: () => void;
} {
  const controller = new AbortController();
  const abort = (reason?: unknown) => {
    if (!controller.signal.aborted) controller.abort(reason);
  };
  const interrupt = () => abort('interrupt');
  const forwardAbort = () => abort(control?.signal?.reason);

  if (control?.signal) {
    control.signal.addEventListener('abort', forwardAbort, { once: true });
    if (control.signal.aborted) forwardAbort();
  } else {
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', interrupt);
  }

  return {
    signal: controller.signal,
    abort,
    dispose: () => {
      control?.signal?.removeEventListener('abort', forwardAbort);
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
  verificationAgent: Type.Optional(Type.Boolean()),
  maxTurns: Type.Optional(
    Type.Refine(
      Type.Integer(),
      (value) => value === -1 || value > 0,
      () => 'must be -1 (unlimited) or a positive integer'
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
  jsonSchema: Type.Optional(Type.String()),
  outputSchema: Type.Optional(Type.String()),
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
  /** Enables the built-in independent verification subagent. */
  verificationAgent?: boolean;
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
  /** Inline JSON Schema for the final response. */
  jsonSchema?: string;
  /** Path to a JSON Schema file for the final response. */
  outputSchema?: string;
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
        .option('verification-agent', {
          describe:
            'Run the built-in independent verification agent after non-trivial changes',
          type: 'boolean',
          default: true,
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
        .option('json-schema', {
          alias: ['jsonSchema'],
          describe: 'Inline JSON Schema for the structured final response',
          type: 'string',
        })
        .option('output-schema', {
          alias: ['outputSchema'],
          describe: 'Path to a JSON Schema file for the structured final response',
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

function writeLine(writer: HeadlessWritableLike, line = ''): void {
  writer.write(`${line}\n`);
}

function formatTask(task: TaskListItem): string {
  return `[task] [${task.status}] ${task.subject}`;
}

function createConfirmationHandler() {
  return {
    requestConfirmation: async (
      details: ConfirmationDetails
    ): Promise<ConfirmationResponse> =>
      details.type === 'mcpElicitation'
        ? {
            approved: false,
            reason: 'headless-mcp-elicitation-unavailable',
            elicitation: { action: 'cancel' },
          }
        : details.type === 'mcpSampling'
          ? {
              approved: false,
              reason: 'headless-mcp-sampling-unavailable',
            }
          : {
              approved: true,
              reason: 'headless-auto-approved',
              scope: 'session',
            },
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
    case 'ApplyPatch':
      return 'multi-file patch';
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
    'ApplyPatch',
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

function createEventWriter(
  io: HeadlessOutputIO,
  outputFormat: HeadlessOutputFormat,
  structuredOutputExpected = false
) {
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
      if (structuredOutputExpected) return;
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
    structuredOutput(event: Extract<LoopEvent, { kind: 'structured_output' }>) {
      if (outputFormat === 'jsonl') {
        writeJsonl('structured_output', {
          output: event.output,
          schema_digest: event.schemaDigest,
        });
        return;
      }
      writeLine(io.stdout, JSON.stringify(event.output));
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
    toolProgress(
      toolName: string,
      message: string,
      progress?: number,
      total?: number,
      admission?: ToolProgressUpdate['admission']
    ) {
      if (outputFormat === 'jsonl') {
        writeJsonl('tool_progress', {
          tool_name: toolName,
          message,
          progress,
          total,
          admission: admission
            ? {
                kind: admission.kind,
                scope: admission.scope,
                queue_position: admission.queuePosition,
                in_flight: admission.inFlight,
                limit: admission.limit,
              }
            : undefined,
        });
        return;
      }
      writeLine(io.stderr, `[tool:progress] ${toolName}: ${message}`);
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
        background?: HeadlessBackgroundHandoff;
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
          background: result?.background,
        });
        return;
      }
      writeLine(io.stderr, `[tool:result] ${summary}`);
    },
    mcpCatalogChanged(event: Extract<LoopEvent, { kind: 'mcp_catalog_changed' }>) {
      if (outputFormat === 'jsonl') {
        writeJsonl('mcp_catalog_changed', {
          revision: event.revision,
          server_name: event.serverName,
          added: event.added,
          removed: event.removed,
          updated: event.updated,
        });
        return;
      }
      writeLine(
        io.stderr,
        `[mcp:catalog] r${event.revision} ${event.serverName} ` +
          `+${event.added.length} -${event.removed.length} ~${event.updated.length}`
      );
    },
    mcpContentChanged(event: Extract<LoopEvent, { kind: 'mcp_content_changed' }>) {
      if (outputFormat === 'jsonl') {
        writeJsonl('mcp_content_changed', {
          revision: event.revision,
          server_name: event.serverName,
          content_kind:
            event.contentKind === 'resourceTemplates'
              ? 'resource_templates'
              : event.contentKind,
          added: event.added,
          removed: event.removed,
          updated: event.updated,
        });
        return;
      }
      writeLine(
        io.stderr,
        `[mcp:${event.contentKind}] r${event.revision} ${event.serverName} ` +
          `+${event.added.length} -${event.removed.length} ~${event.updated.length}`
      );
    },
    mcpResourceUpdated(event: Extract<LoopEvent, { kind: 'mcp_resource_updated' }>) {
      if (outputFormat === 'jsonl') {
        writeJsonl('mcp_resource_updated', {
          revision: event.revision,
          server_name: event.serverName,
          uri: event.uri,
        });
        return;
      }
      writeLine(
        io.stderr,
        `[mcp:resource] r${event.revision} ${event.serverName} updated ${event.uri}`
      );
    },
    mcpConnectionChanged(
      event: Extract<LoopEvent, { kind: 'mcp_connection_changed' }>
    ) {
      if (outputFormat === 'jsonl') {
        writeJsonl('mcp_connection_changed', {
          revision: event.revision,
          server_name: event.serverName,
          phase: event.phase,
          reason: event.reason,
          attempt: event.attempt,
          max_attempts: event.maxAttempts,
          ...(event.nextRetryAt !== undefined
            ? { next_retry_at: event.nextRetryAt }
            : {}),
          ...(event.error ? { error: event.error } : {}),
        });
        return;
      }
      writeLine(
        io.stderr,
        `[mcp:connection] r${event.revision} ${event.serverName} ` +
          `${event.phase} ${event.attempt}/${event.maxAttempts}`
      );
    },
    mcpLog(event: Extract<LoopEvent, { kind: 'mcp_log' }>) {
      if (outputFormat === 'jsonl') {
        writeJsonl('mcp_log', {
          revision: event.revision,
          server_name: event.serverName,
          level: event.level,
          logger: event.logger,
          message: event.message,
          projected_bytes: event.projectedBytes,
          data_sha256: event.dataSha256,
          truncated: event.truncated,
          details_omitted: event.detailsOmitted,
          timestamp: event.timestamp,
          synthetic: event.synthetic,
        });
        return;
      }
      writeLine(
        io.stderr,
        `[mcp:log] ${event.level} ${event.serverName}` +
          `${event.logger ? ` logger=${event.logger}` : ''}: ${event.message}`
      );
    },
    mcpInstructionsChanged(
      event: Extract<LoopEvent, { kind: 'mcp_instructions_changed' }>
    ) {
      if (outputFormat === 'jsonl') {
        writeJsonl('mcp_instructions_changed', {
          revision: event.revision,
          server_name: event.serverName,
          action: event.action,
          reason: event.reason,
          text: event.text,
          source_bytes: event.sourceBytes,
          projected_bytes: event.projectedBytes,
          sha256: event.sha256,
          truncated: event.truncated,
          details_omitted: event.detailsOmitted,
        });
        return;
      }
      writeLine(
        io.stderr,
        `[mcp:instructions] ${event.action} ${event.serverName}` +
          `${event.truncated ? ' (truncated)' : ''}`
      );
    },
    mcpTaskChanged(event: Extract<LoopEvent, { kind: 'mcp_task_changed' }>) {
      if (outputFormat === 'jsonl') {
        writeJsonl('mcp_task_changed', {
          revision: event.revision,
          task_id: event.taskId,
          server_name: event.serverName,
          tool_name: event.toolName,
          status: event.status,
          status_message: event.statusMessage,
          created_at: event.createdAt,
          updated_at: event.updatedAt,
          completed_at: event.completedAt,
          has_result: event.hasResult,
          error: event.error,
        });
        return;
      }
      writeLine(
        io.stderr,
        `[mcp:task] ${event.taskId} ${event.serverName}/${event.toolName} ` +
          event.status
      );
    },
    projectRulesLoaded(event: Extract<LoopEvent, { kind: 'project_rules_loaded' }>) {
      if (outputFormat === 'jsonl') {
        writeJsonl('project_rules_loaded', {
          files: event.files.map((file) => ({
            id: file.id,
            relative_path: file.relativePath,
            source: file.source,
            conditional: file.conditional,
            content_sha256: file.contentSha256,
          })),
          trigger_paths: event.triggerPaths,
          blocked_write: event.blockedWrite,
        });
        return;
      }
      writeLine(
        io.stderr,
        `[project-rules] loaded ${event.files.length} file(s)` +
          `${event.blockedWrite ? ' before write' : ''}`
      );
    },
    userShellStarted(executionId: string, command: string, auxiliary: boolean) {
      if (outputFormat === 'jsonl') {
        writeJsonl('user_shell_started', {
          execution_id: executionId,
          command,
          auxiliary,
        });
        return;
      }
      writeLine(io.stderr, `[user-shell:start] ${command}`);
    },
    userShellOutput(
      executionId: string,
      stream: 'stdout' | 'stderr',
      chunk: string,
      streamTruncated: boolean
    ) {
      if (outputFormat === 'jsonl') {
        writeJsonl('user_shell_output', {
          execution_id: executionId,
          stream,
          chunk,
          stream_truncated: streamTruncated,
        });
        return;
      }
      (stream === 'stderr' ? io.stderr : io.stdout).write(chunk);
    },
    userShellCompleted(
      result: Awaited<ReturnType<SessionRuntime['executeUserShellCommand']>>
    ) {
      if (outputFormat === 'jsonl') {
        writeJsonl('user_shell_completed', {
          execution_id: result.executionId,
          message_id: result.messageId,
          status: result.record.status,
          exit_code: result.record.exitCode,
          duration_ms: result.record.durationMs,
          stdout: result.record.stdout,
          stderr: result.record.stderr,
          truncated: result.record.truncated,
          auxiliary: result.auxiliary,
        });
        return;
      }
      writeLine(
        io.stderr,
        `[user-shell:${result.record.status}] exit=${result.record.exitCode ?? 'null'} ` +
          `${result.record.durationMs}ms`
      );
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
    goal(event: Extract<LoopEvent, { kind: 'goal_updated' }>) {
      if (outputFormat === 'jsonl') {
        writeJsonl('goal', {
          state: event.goal ? 'updated' : 'cleared',
          goal_id: event.goal?.goalId,
          status: event.goal?.status,
          verification_attempt: event.goal?.completionVerification?.attempt,
          verification_status: event.goal?.completionVerification?.status,
          verifier_session_id: event.goal?.completionVerification?.verifierSessionId,
          verification_evidence_sha256:
            event.goal?.completionVerification?.evidenceSha256,
        });
        return;
      }
      if (event.goal) {
        writeLine(io.stderr, `[goal:${event.goal.status}] ${event.goal.objective}`);
      } else {
        writeLine(io.stderr, '[goal:cleared]');
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
          subagent_type: event.type,
          success: spawned ? undefined : event.success,
          summary: spawned ? undefined : event.summary,
          verification_verdict: spawned ? undefined : event.verificationVerdict,
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
    compacting(event: Extract<LoopEvent, { kind: 'compaction' }>) {
      const isCompacting = event.phase === 'start';
      if (outputFormat === 'jsonl') {
        writeJsonl('compacting', {
          state: isCompacting ? 'started' : 'completed',
          reason: event.reason,
          strategy: event.strategy,
          outcome: event.outcome,
          pre_tokens: event.preTokens,
          post_tokens: event.postTokens,
        });
        return;
      }
      writeLine(
        io.stderr,
        isCompacting
          ? `[context] compacting started${event.reason ? ` (${event.reason})` : ''}`
          : `[context] compacting ${event.outcome ?? 'completed'}`
      );
    },
    providerRetry(event: Extract<LoopEvent, { kind: 'provider_retry' }>) {
      if (outputFormat === 'jsonl') {
        writeJsonl('provider_retry', {
          phase: event.phase,
          attempt: event.attempt,
          max_retries: event.maxRetries,
          reason: event.reason,
          status_code: event.statusCode,
          delay_ms: event.delayMs,
          next_retry_at: event.nextRetryAt,
          mode: event.mode,
          recovery_budget_ms: event.recoveryBudgetMs,
          recovery_elapsed_ms: event.recoveryElapsedMs,
          recovery_remaining_ms: event.recoveryRemainingMs,
          exhausted_by: event.exhaustedBy,
        });
        return;
      }
      const delay =
        event.delayMs !== undefined
          ? ` in ${Math.max(0, Math.ceil(event.delayMs / 1000))}s`
          : '';
      writeLine(
        io.stderr,
        `[provider-retry:${event.phase}] ${event.attempt}/${event.maxRetries} ${event.reason}${delay}`
      );
    },
    providerStall(event: Extract<LoopEvent, { kind: 'provider_stall' }>) {
      if (outputFormat === 'jsonl') {
        writeJsonl('provider_stall', {
          phase: event.phase,
          stall_count: event.stallCount,
          duration_ms: event.durationMs,
          warning_after_ms: event.warningAfterMs,
          timeout_ms: event.timeoutMs,
          output_started: event.outputStarted,
        });
        return;
      }
      writeLine(
        io.stderr,
        `[provider-stall:${event.phase}] ${event.durationMs}ms / ${event.timeoutMs}ms`
      );
    },
    actionStationarity(event: Extract<LoopEvent, { kind: 'action_stationarity' }>) {
      if (outputFormat === 'jsonl') {
        writeJsonl('action_stationarity', {
          phase: event.phase,
          tool_name: event.toolName,
          run_length: event.runLength,
          nudge_threshold: event.nudgeThreshold,
          halt_threshold: event.haltThreshold,
          progress_aware: event.progressAware,
        });
        return;
      }
      writeLine(
        io.stderr,
        `[action-stationarity:${event.phase}] ${event.toolName} ${event.runLength}/${event.haltThreshold}`
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
  io: HeadlessOutputIO = { stdout: process.stdout, stderr: process.stderr },
  control?: HeadlessRunControl
): Promise<number> {
  let outputFormat: HeadlessOutputFormat = 'text';
  const streamState = new HeadlessStreamState();
  const phaseState: HeadlessPhaseState = { targetLocked: false };
  let runtime: SessionRuntime | undefined;
  let taskAdmissionUnsubscribe: (() => void) | undefined;
  const abortControl = createHeadlessAbortSignal(control);
  let outputFailed = false;
  const outputEgress = new HeadlessOutputEgress(io, {
    signal: abortControl.signal,
    onFailure: (error) => {
      outputFailed = true;
      abortControl.abort(error);
    },
  });
  const outputIo: HeadlessOutputIO = {
    stdout: {
      write: (chunk) => outputEgress.write('stdout', chunk),
    },
    stderr: {
      write: (chunk) => outputEgress.write('stderr', chunk),
    },
  };
  let eventWriter = createEventWriter(outputIo, outputFormat);
  const flushOutput = async (): Promise<boolean> => {
    try {
      await outputEgress.flush();
      return !outputFailed;
    } catch {
      return false;
    }
  };
  const finish = async (exitCode: number): Promise<number> => {
    taskAdmissionUnsubscribe?.();
    taskAdmissionUnsubscribe = undefined;
    return (await flushOutput()) ? exitCode : 1;
  };

  try {
    const validatedOptions = validateHeadlessOptions(options);
    outputFormat = resolveOutputFormat(validatedOptions.outputFormat);
    const outputSchema = await resolveCliOutputSchema(validatedOptions);
    eventWriter = createEventWriter(outputIo, outputFormat, Boolean(outputSchema));

    await initializeCliPlugins();

    const acceptsInputlessResume =
      validatedOptions.forkSession !== true &&
      (validatedOptions.continue === true ||
        (typeof validatedOptions.resume === 'string' &&
          validatedOptions.resume.length > 0));
    const rawInput = acceptsInputlessResume
      ? await readOptionalCliInput({
          message: validatedOptions.message,
          _: validatedOptions._,
          stdin: control?.stdin,
        })
      : await readCliInput({
          ...validatedOptions,
          stdin: control?.stdin,
        });
    const inputlessResume = rawInput === undefined;
    const normalized = inputlessResume
      ? ({ mode: 'agent', content: '' } as const)
      : await normalizeCliInput(rawInput);
    if (normalized.mode === 'output') {
      if (normalized.content) {
        eventWriter.output(normalized.content, normalized.exitCode ?? 0);
      }
      return await finish(normalized.exitCode ?? 0);
    }
    const userShellCommand = normalized.content.trimStart().startsWith('!')
      ? normalized.content.trimStart().slice(1).trim()
      : undefined;
    if (userShellCommand !== undefined && validatedOptions.taskIsolation) {
      throw new Error('User shell commands cannot be combined with --task-isolation');
    }
    if (userShellCommand !== undefined && outputSchema) {
      throw new Error('Output schemas cannot be combined with user shell commands');
    }

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
    const { sessionId, messages, metadata } = await resolveNonInteractiveSession({
      sessionId: validatedOptions.sessionId,
      continue: validatedOptions.continue,
      resume: validatedOptions.resume,
      forkSession: validatedOptions.forkSession,
      fallbackSessionPrefix: 'headless',
    });
    const permissionMode =
      (validatedOptions.permissionMode as PermissionMode | undefined) ??
      (metadata?.permissionMode as PermissionMode | undefined) ??
      PermissionMode.YOLO;
    const taskModelId =
      validatedOptions.model && validatedOptions.model !== 'inherit'
        ? validatedOptions.model
        : getCurrentModel()?.id;
    const createdTask = validatedOptions.taskIsolation
      ? await SessionTaskService.createSessionTask({
          sessionId,
          prompt: normalized.content,
          sourceProjectPath: getCwd(),
          isolation: validatedOptions.taskIsolation,
          dispatch: {
            version: 1,
            prompt: normalized.content,
            sourceProjectPath: getCwd(),
            isolation: validatedOptions.taskIsolation,
            permissionMode,
            ...(taskModelId ? { modelId: taskModelId } : {}),
            ...(outputSchema ? { outputSchema } : {}),
          },
        })
      : undefined;
    const workspaceRoot =
      createdTask?.metadata.projectPath ?? metadata?.projectPath ?? getCwd();
    if (!createdTask) {
      await SessionService.setSessionPermissionMode(
        sessionId,
        workspaceRoot,
        permissionMode
      );
    }
    const recoveredInteraction = createdTask
      ? false
      : await SessionInteractionService.cancelPendingNonInteractive(
          workspaceRoot,
          sessionId
        );
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
    const contextMessages: Message[] = recoveredInteraction
      ? await SessionService.loadSessionModelContext(sessionId, workspaceRoot)
      : [...messages];
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
      permissionMode,
      mcpConfig: validatedOptions.mcpConfig,
      strictMcpConfig: validatedOptions.strictMcpConfig,
      agents: validatedOptions.agents
        ? parseCliAgents(validatedOptions.agents)
        : undefined,
      ...(createdTask?.taskWorktree ? { taskWorktree: createdTask.taskWorktree } : {}),
      ...(createdTask?.metadata.taskIsolation
        ? { taskIsolation: createdTask.metadata.taskIsolation }
        : {}),
      ...(messages.length > 0
        ? {
            sessionStart: {
              isResume: true,
              resumeSessionId: sessionId,
            },
          }
        : {}),
    });
    const pendingInputOnly = inputlessResume && runtime.getPendingSteeringCount() > 0;
    const resumedGoal =
      inputlessResume && !pendingInputOnly ? await runtime.getGoal() : null;
    const goalContinuationOnly =
      resumedGoal?.status === 'active' || resumedGoal?.status === 'verifying';
    const recoveredFinalResponse =
      inputlessResume && !pendingInputOnly && !goalContinuationOnly
        ? await runtime.getRecoveredFinalResponse()
        : undefined;
    if (inputlessResume && !pendingInputOnly && !goalContinuationOnly) {
      if (!recoveredFinalResponse) {
        throw new Error('No unfinished turn or active goal to resume');
      }
      if (resumedGoal) {
        eventWriter.goal({ kind: 'goal_updated', goal: resumedGoal });
      }
      if (
        recoveredFinalResponse.structuredOutput &&
        recoveredFinalResponse.structuredOutputSchemaDigest
      ) {
        eventWriter.structuredOutput({
          kind: 'structured_output',
          output: recoveredFinalResponse.structuredOutput,
          schemaDigest: recoveredFinalResponse.structuredOutputSchemaDigest,
        });
      } else {
        eventWriter.content(recoveredFinalResponse.content);
      }
      eventWriter.phase('completed', 'done', 'Recovered headless run completed');
      return await finish(0);
    }
    if (userShellCommand !== undefined) {
      const result = await runtime.executeUserShellCommand(userShellCommand, {
        signal: abortControl.signal,
        onEvent: async (event) => {
          if (event.type === 'started') {
            eventWriter.userShellStarted(
              event.executionId,
              event.command,
              event.auxiliary
            );
          } else if (event.type === 'output') {
            eventWriter.userShellOutput(
              event.executionId,
              event.stream,
              event.chunk,
              event.streamTruncated
            );
          }
          await flushOutput();
        },
      });
      eventWriter.userShellCompleted(result);
      return await finish(
        result.record.status === 'completed'
          ? 0
          : result.record.status === 'aborted'
            ? 130
            : (result.record.exitCode ?? 1)
      );
    }
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
        builtinVerification: validatedOptions.verificationAgent !== false,
        outputSchema,
        pendingInputOnly,
        goalContinuationOnly,
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
            if (!outputSchema || outputFormat === 'jsonl') {
              streamState.markAssistantContent();
            }
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
            if (toolCall.function.name === STRUCTURED_OUTPUT_TOOL_NAME) break;
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
          case 'tool_progress': {
            const toolCall = event.toolCall;
            if (!('function' in toolCall)) break;
            if (toolCall.function.name === STRUCTURED_OUTPUT_TOOL_NAME) break;
            eventWriter.toolProgress(
              toolCall.function.name,
              event.update.message,
              event.update.progress,
              event.update.total,
              event.update.admission
            );
            break;
          }
          case 'tool_result': {
            const toolCall = event.toolCall;
            if (!('function' in toolCall)) break;
            if (toolCall.function.name === STRUCTURED_OUTPUT_TOOL_NAME) break;
            let target: string | undefined;
            try {
              const params = JSON.parse(toolCall.function.arguments);
              target = extractToolTarget(toolCall.function.name, params);
            } catch {
              target = undefined;
            }
            const display = fitToolDisplayForSurface(
              formatToolDisplay(toolCall.function.name, event.result),
              HEADLESS_TOOL_DETAIL_MAX_CHARS
            );
            eventWriter.toolResult(
              toolCall.function.name,
              display.summary,
              target,
              undefined,
              {
                success: event.result.success,
                errorType: event.result.error?.type,
                errorMessage: event.result.error?.message,
                background: projectBackgroundHandoff(event.result.metadata),
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
            eventWriter.compacting(event);
            break;

          // --- 业务事件 ---
          case 'task_update':
            eventWriter.taskUpdate(event.tasks);
            break;
          case 'structured_output':
            eventWriter.structuredOutput(event);
            break;
          case 'mcp_catalog_changed':
            eventWriter.mcpCatalogChanged(event);
            break;
          case 'mcp_content_changed':
            eventWriter.mcpContentChanged(event);
            break;
          case 'mcp_resource_updated':
            eventWriter.mcpResourceUpdated(event);
            break;
          case 'mcp_connection_changed':
            eventWriter.mcpConnectionChanged(event);
            break;
          case 'mcp_log':
            eventWriter.mcpLog(event);
            break;
          case 'mcp_instructions_changed':
            eventWriter.mcpInstructionsChanged(event);
            break;
          case 'mcp_task_changed':
            eventWriter.mcpTaskChanged(event);
            break;
          case 'project_rules_loaded':
            eventWriter.projectRulesLoaded(event);
            break;

          case 'steering_applied':
          case 'follow_up_started':
          case 'goal_continuation_started':
            break;
          case 'goal_updated':
            eventWriter.goal(event);
            break;

          case 'subagent_spawned':
          case 'subagent_completed':
            eventWriter.subagent(event);
            break;

          // --- 模型降级 ---
          case 'model_fallback':
            // 在 headless 模式下不需要特殊处理
            break;
          case 'provider_retry':
            eventWriter.providerRetry(event);
            break;
          case 'provider_stall':
            eventWriter.providerStall(event);
            break;
          case 'action_stationarity':
            eventWriter.actionStationarity(event);
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
        await flushOutput();
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
      return await finish(1);
    }

    eventWriter.phase('completed', 'done', 'Headless run completed');

    return await finish(0);
  } catch (error) {
    if (!outputFailed) {
      if (streamState.hasOpenThinking() && outputFormat === 'text') {
        outputIo.stderr.write('\n');
      }
      eventWriter.error(`Error: ${extractHeadlessErrorMessage(error)}`);
    }
    return await finish(1);
  } finally {
    taskAdmissionUnsubscribe?.();
    try {
      await runtime?.dispose();
    } finally {
      outputEgress.close();
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
