import type { Argv } from 'yargs';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { Agent } from '../agent/Agent.js';
import { drainLoop } from '../agent/loop/index.js';
import { SessionRuntime } from '../agent/runtime/SessionRuntime.js';
import { parseCliAgents } from '../cli/agents.js';
import { globalOptions } from '../cli/config.js';
import {
  loadConfiguration,
  validateOutput,
  validatePermissions,
} from '../cli/middleware.js';
import { PermissionMode } from '../config/types.js';
import { SessionInteractionService } from '../services/SessionInteractionService.js';
import { SessionService } from '../services/SessionService.js';
import { renderUserShellCommandForDisplay } from '../services/UserShellCommandService.js';
import { getConfig } from '../store/vanilla.js';
import { getCwd } from '../utils/cwd.js';
import {
  initializeCliPlugins,
  normalizeCliInput,
  readCliInput,
} from './shared/commandInput.js';
import { resolveCliOutputSchema } from './shared/outputSchema.js';
import { resolveNonInteractiveSession } from './shared/sessionContext.js';

interface PrintOptions {
  message?: string;
  model?: string;
  print?: boolean;
  outputFormat?: string;
  jsonSchema?: string;
  outputSchema?: string;
  includePartialMessages?: boolean;
  inputFormat?: string;
  systemPrompt?: string;
  appendSystemPrompt?: string;
  permissionMode?: string;
  maxTurns?: number;
  sessionId?: string;
  continue?: boolean;
  resume?: string | boolean;
  forkSession?: boolean;
  allowedTools?: string[];
  disallowedTools?: string[];
  agents?: string;
  mcpConfig?: string[];
  strictMcpConfig?: boolean;
  _?: (string | number)[];
}

const PERMISSION_MODES: ReadonlySet<string> = new Set(Object.values(PermissionMode));

function toPermissionMode(value?: string): PermissionMode | undefined {
  if (value && PERMISSION_MODES.has(value)) return value as PermissionMode;
  return undefined;
}

function printCommand(yargs: Argv) {
  return yargs.command(
    '* [message]',
    'Print response and exit (useful for pipes)',
    (y) =>
      y
        .positional('message', {
          describe: 'Message to process',
          type: 'string',
        })
        .option('p', {
          alias: 'print',
          describe: 'Print response and exit (useful for pipes)',
          type: 'boolean',
        })
        .option('output-format', {
          describe: 'Output format: "text", "json", "stream-json"',
          type: 'string',
          default: 'text',
        })
        .option('include-partial-messages', {
          describe: 'Include partial message chunks as they arrive',
          type: 'boolean',
        })
        .option('input-format', {
          describe: 'Input format: "text", "stream-json"',
          type: 'string',
          default: 'text',
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
        .option('model', {
          describe: 'Model for the current session',
          type: 'string',
        })
        .option('append-system-prompt', {
          describe: 'Append a system prompt to the default system prompt',
          type: 'string',
        })
        .option('system-prompt', {
          describe: 'Replace the default system prompt',
          type: 'string',
        })
        .option('max-turns', {
          alias: ['maxTurns'],
          describe: 'Maximum conversation turns (-1: unlimited, N>0: limit to N turns)',
          type: 'number',
        }),
    async (argv) => {
      if (!argv.p) {
        return;
      }

      const exitCode = await runPrint(argv);
      process.exit(exitCode);
    }
  );
}

export async function runPrint(
  options: PrintOptions,
  io: Pick<typeof process, 'stdout' | 'stderr'> = process
): Promise<number> {
  let runtime: SessionRuntime | undefined;

  try {
    await initializeCliPlugins();

    const rawInput = await readCliInput({
      message: options.message,
      _: options._,
      defaultMessage: 'Hello',
    });
    const normalized = await normalizeCliInput(rawInput);
    if (normalized.mode === 'output') {
      if (normalized.content) {
        io.stdout.write(`${normalized.content}\n`);
      }
      return normalized.exitCode ?? 0;
    }
    const input = normalized.content;
    const outputSchema = await resolveCliOutputSchema(options);
    const userShellCommand = input.trimStart().startsWith('!')
      ? input.trimStart().slice(1).trim()
      : undefined;
    if (userShellCommand !== undefined && outputSchema) {
      throw new Error('Output schemas cannot be combined with user shell commands');
    }

    const { sessionId, messages, metadata } = await resolveNonInteractiveSession({
      sessionId: options.sessionId,
      continue: options.continue,
      resume: options.resume,
      forkSession: options.forkSession,
      fallbackSessionPrefix: 'print',
    });
    const workspaceRoot = metadata?.projectPath ?? getCwd();
    const permissionMode =
      toPermissionMode(options.permissionMode) ??
      (metadata?.permissionMode as PermissionMode | undefined) ??
      getConfig()?.permissionMode ??
      PermissionMode.DEFAULT;
    await SessionService.setSessionPermissionMode(
      sessionId,
      workspaceRoot,
      permissionMode
    );
    const recoveredInteraction =
      await SessionInteractionService.cancelPendingNonInteractive(
        workspaceRoot,
        sessionId
      );
    const contextMessages = recoveredInteraction
      ? await SessionService.loadSession(sessionId, workspaceRoot)
      : messages;

    runtime = await SessionRuntime.create({
      sessionId,
      workspaceRoot,
      modelId: options.model,
      permissionMode,
      mcpConfig: options.mcpConfig,
      strictMcpConfig: options.strictMcpConfig,
      agents: options.agents ? parseCliAgents(options.agents) : undefined,
      ...(contextMessages.length > 0
        ? {
            sessionStart: {
              isResume: true,
              resumeSessionId: sessionId,
            },
          }
        : {}),
    });
    if (userShellCommand !== undefined) {
      const result = await runtime.executeUserShellCommand(userShellCommand);
      if (options.outputFormat === 'json') {
        io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      } else if (options.outputFormat === 'stream-json') {
        io.stdout.write(
          `${JSON.stringify({
            type: 'user_shell_completed',
            executionId: result.executionId,
            record: result.record,
          })}\n`
        );
      } else {
        io.stdout.write(`${renderUserShellCommandForDisplay(result.record)}\n`);
      }
      return result.record.status === 'completed'
        ? 0
        : result.record.status === 'aborted'
          ? 130
          : (result.record.exitCode ?? 1);
    }

    const agent = await Agent.createWithRuntime(runtime, {
      sessionId,
      systemPrompt: options.systemPrompt,
      appendSystemPrompt: options.appendSystemPrompt,
      maxTurns: options.maxTurns,
      modelId: options.model,
      permissionMode,
      toolWhitelist: options.allowedTools,
      toolBlacklist: options.disallowedTools,
      mcpConfig: options.mcpConfig,
      strictMcpConfig: options.strictMcpConfig,
    });

    const chatContext = {
      messages: [...contextMessages],
      userId: 'cli-user',
      sessionId,
      workspaceRoot,
      permissionMode,
    };
    const loopResult = await drainLoop(
      outputSchema
        ? agent.chatStream(input, chatContext, { outputSchema })
        : agent.chatStream(input, chatContext)
    );
    if (!loopResult.success) {
      throw new Error(loopResult.error?.message ?? 'Agent execution failed');
    }
    const response = loopResult.finalMessage || '';
    const structuredOutput = loopResult.metadata?.structuredOutput;

    if (options.outputFormat === 'json') {
      io.stdout.write(
        `${JSON.stringify(
          {
            response,
            ...(structuredOutput
              ? {
                  structured_output: structuredOutput,
                  output_schema_digest:
                    loopResult.metadata?.structuredOutputSchemaDigest,
                }
              : {}),
            input,
            model: options.model,
            timestamp: new Date().toISOString(),
          },
          null,
          2
        )}\n`
      );
    } else if (options.outputFormat === 'stream-json') {
      io.stdout.write(
        `${JSON.stringify(
          structuredOutput
            ? {
                type: 'structured_output',
                output: structuredOutput,
                schema_digest: loopResult.metadata?.structuredOutputSchemaDigest,
              }
            : { type: 'response', content: response }
        )}\n`
      );
    } else {
      io.stdout.write(`${response}\n`);
    }

    return 0;
  } catch (error) {
    io.stderr.write(`Error: ${error instanceof Error ? error.message : '未知错误'}\n`);
    return 1;
  } finally {
    await runtime?.dispose();
  }
}

/**
 * 检查命令行参数是否包含 --print 选项
 * 如果包含,则以 print 模式运行
 */
export async function handlePrintMode(): Promise<boolean> {
  const argv = process.argv.slice(2);
  const printIndex = argv.findIndex((arg) => arg === '--print' || arg === '-p');

  if (printIndex === -1) {
    return false;
  }

  try {
    const {
      print: _p,
      'output-format': _of,
      'include-partial-messages': _ipm,
      'input-format': _if,
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

    printCommand(cli);

    await cli.parse();
    return true;
  } catch (error) {
    console.error(
      `Print mode error: ${error instanceof Error ? error.message : '未知错误'}`
    );
    process.exit(1);
  }
}
