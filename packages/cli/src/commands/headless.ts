/**
 * Headless CLI runner for the full agent loop.
 *
 * This keeps the agent behavior intact while replacing Ink rendering with
 * terminal output. Internal callbacks stay camelCase to match `LoopOptions`,
 * while the exported JSONL contract remains snake_case and versioned.
 */
import type { Argv } from 'yargs';
import type { ChatCompletionMessageToolCall } from 'openai/resources/chat';
import { z } from 'zod';
import { Agent } from '../agent/Agent.js';
import type { ChatContext, LoopOptions } from '../agent/types.js';
import { PermissionMode } from '../config/types.js';
import type { Message } from '../services/ChatServiceInterface.js';
import type { TodoItem } from '../tools/builtin/todo/types.js';
import type {
  ConfirmationDetails,
  ConfirmationResponse,
} from '../tools/types/ExecutionTypes.js';
import type { ToolResult } from '../tools/types/index.js';
import {
  initializeCliPlugins,
  normalizeCliInput,
  readCliInput,
} from './shared/commandInput.js';
import {
  type HeadlessJsonlEventPayload,
  type HeadlessJsonlEventType,
  createHeadlessJsonlEvent,
} from './headlessEvents.js';
import {
  formatToolCallSummary,
  generateToolDetail,
  shouldShowToolDetail,
} from '../ui/utils/toolFormatters.js';

/** Minimal writable stream contract used by headless output sinks. */
interface WritableLike {
  write(chunk: string): boolean | void;
}

/** Output streams used by the headless runner. */
interface HeadlessIO {
  stdout: WritableLike;
  stderr: WritableLike;
}

type HeadlessOutputFormat = 'text' | 'jsonl';

const HeadlessOutputFormatSchema = z.enum(['text', 'jsonl']);

export const HeadlessOptionsSchema = z.object({
  headless: z.boolean().optional(),
  message: z.string().optional(),
  _: z.array(z.union([z.string(), z.number()])).optional(),
  model: z.string().optional(),
  systemPrompt: z.string().optional(),
  appendSystemPrompt: z.string().optional(),
  maxTurns: z
    .number()
    .int()
    .refine((value) => value === -1 || value > 0, {
      message: 'must be -1 or a positive integer',
    })
    .optional(),
  permissionMode: z.nativeEnum(PermissionMode).optional(),
  mcpConfig: z.array(z.string()).optional(),
  strictMcpConfig: z.boolean().optional(),
  sessionId: z.string().optional(),
  outputFormat: HeadlessOutputFormatSchema.optional(),
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
  /** Terminal output format. */
  outputFormat?: string;
}

type ValidatedHeadlessOptions = z.infer<typeof HeadlessOptionsSchema>;

interface HeadlessStreamSnapshot {
  openedThinking: boolean;
  wroteAssistantContent: boolean;
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

function formatValidationIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || 'options'}: ${issue.message}`)
    .join('; ');
}

function validateHeadlessOptions(options: HeadlessOptions): ValidatedHeadlessOptions {
  const result = HeadlessOptionsSchema.safeParse(options);
  if (!result.success) {
    throw new Error(`Invalid headless options: ${formatValidationIssues(result.error)}`);
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
          describe: 'Run full agent loop without Ink UI and print events to the terminal',
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

function formatTodo(todo: TodoItem): string {
  return `[todo] [${todo.status}] ${todo.content}`;
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

function resolveOutputFormat(outputFormat?: string): HeadlessOutputFormat {
  return outputFormat === 'jsonl' ? 'jsonl' : 'text';
}

function createEventWriter(
  io: HeadlessIO,
  outputFormat: HeadlessOutputFormat
) {
  const writeJsonl = <TType extends HeadlessJsonlEventType>(
    type: TType,
    payload: HeadlessJsonlEventPayload<TType>
  ) => {
    io.stdout.write(
      `${JSON.stringify(createHeadlessJsonlEvent(type, payload))}\n`
    );
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
    toolStart(toolName: string, summary: string) {
      if (outputFormat === 'jsonl') {
        writeJsonl('tool_start', { tool_name: toolName, summary });
        return;
      }
      writeLine(io.stderr, `[tool:start] ${summary}`);
    },
    toolResult(toolName: string, summary: string) {
      if (outputFormat === 'jsonl') {
        writeJsonl('tool_result', { tool_name: toolName, summary });
        return;
      }
      writeLine(io.stderr, `[tool:result] ${summary}`);
    },
    toolDetail(toolName: string, detail: string) {
      if (outputFormat === 'jsonl') {
        writeJsonl('tool_detail', { tool_name: toolName, detail });
        return;
      }
      writeLine(io.stderr, detail);
    },
    todoUpdate(todos: TodoItem[]) {
      if (outputFormat === 'jsonl') {
        writeJsonl('todo_update', { todos });
        return;
      }
      for (const todo of todos) {
        writeLine(io.stderr, formatTodo(todo));
      }
    },
    tokenUsage(usage: {
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      maxContextTokens: number;
    }) {
      if (outputFormat === 'jsonl') {
        writeJsonl('token_usage', {
          input_tokens: usage.inputTokens,
          output_tokens: usage.outputTokens,
          total_tokens: usage.totalTokens,
          max_context_tokens: usage.maxContextTokens,
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
  io: HeadlessIO = { stdout: process.stdout, stderr: process.stderr }
): Promise<number> {
  let outputFormat: HeadlessOutputFormat = 'text';
  let eventWriter = createEventWriter(io, outputFormat);
  const streamState = new HeadlessStreamState();

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
    const contextMessages: Message[] = [];
    const chatContext: ChatContext = {
      messages: contextMessages,
      userId: 'cli-user',
      sessionId: validatedOptions.sessionId ?? `headless-${Date.now()}`,
      workspaceRoot: process.cwd(),
      permissionMode,
      confirmationHandler: createConfirmationHandler(),
    };

    const loopOptions: LoopOptions = {
      stream: true,
      maxTurns: validatedOptions.maxTurns,
      onContentDelta: (delta: string) => {
        streamState.markAssistantContent();
        eventWriter.contentDelta(delta);
      },
      onThinkingDelta: (delta: string) => {
        streamState.setThinkingOpened(
          eventWriter.thinkingDelta(delta, streamState.hasOpenThinking())
        );
      },
      onThinking: (content: string) => {
        if (!content) return;
        eventWriter.thinking(content);
      },
      onStreamEnd: () => {
        const snapshot = streamState.completeStream();
        eventWriter.streamEnd(
          snapshot.wroteAssistantContent,
          snapshot.openedThinking
        );
      },
      onContent: (content: string) => {
        if (!content.trim()) return;
        eventWriter.content(content);
        streamState.markAssistantContent();
      },
      onToolStart: (toolCall: ChatCompletionMessageToolCall) => {
        if (toolCall.type !== 'function') return;
        // TodoWrite 由 onTodoUpdate 处理，避免重复输出
        if (toolCall.function.name === 'TodoWrite') return;
        try {
          const params = JSON.parse(toolCall.function.arguments);
          const summary = formatToolCallSummary(toolCall.function.name, params);
          eventWriter.toolStart(toolCall.function.name, summary);
        } catch {
          // JSON 解析失败，使用工具名作为 fallback
          eventWriter.toolStart(toolCall.function.name, toolCall.function.name);
        }
      },
      onToolResult: async (
        toolCall: ChatCompletionMessageToolCall,
        result: ToolResult
      ) => {
        if (toolCall.type !== 'function') return;
        const summary = result.metadata?.summary;
        if (summary) {
          eventWriter.toolResult(toolCall.function.name, summary);
        }

        if (shouldShowToolDetail(toolCall.function.name, result)) {
          const detail =
            generateToolDetail(toolCall.function.name, result) ||
            result.displayContent;
          if (detail) {
            eventWriter.toolDetail(toolCall.function.name, detail);
          }
        }
      },
      onTodoUpdate: (todos: TodoItem[]) => {
        eventWriter.todoUpdate(todos);
      },
      onTokenUsage: (usage) => {
        eventWriter.tokenUsage(usage);
      },
      onCompacting: (isCompacting: boolean) => {
        eventWriter.compacting(isCompacting);
      },
      onTurnLimitReached: async (data) => {
        eventWriter.turnLimit(data.turnsCount);
        return { continue: true, reason: 'headless-auto-continue' };
      },
    };

    const agent = await Agent.create({
      systemPrompt: validatedOptions.systemPrompt,
      appendSystemPrompt: validatedOptions.appendSystemPrompt,
      maxTurns: validatedOptions.maxTurns,
      modelId: validatedOptions.model,
      permissionMode,
      mcpConfig: validatedOptions.mcpConfig,
      strictMcpConfig: validatedOptions.strictMcpConfig,
    });

    await agent.chat(normalized.content, chatContext, loopOptions);
    return 0;
  } catch (error) {
    if (streamState.hasOpenThinking() && outputFormat === 'text') {
      io.stderr.write('\n');
    }
    eventWriter.error(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    return 1;
  }
}

export async function handleHeadlessMode(): Promise<boolean> {
  const argv = process.argv.slice(2);
  const headlessRequested = argv.includes('--headless');
  if (!headlessRequested) {
    return false;
  }

  const yargs = (await import('yargs')).default;
  const { hideBin } = await import('yargs/helpers');
  const { globalOptions } = await import('../cli/config.js');
  const {
    loadConfiguration,
    validateOutput,
    validatePermissions,
  } = await import('../cli/middleware.js');

  const cli = yargs(hideBin(process.argv))
    .scriptName('blade')
    .strict(false)
    .options(globalOptions)
    .middleware([validatePermissions, loadConfiguration, validateOutput]);

  headlessCommand(cli);
  await cli.parse();
  return true;
}
