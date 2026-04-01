import type { Command as CommandType } from '@commander-js/extra-typings';
import { CommanderError } from '@commander-js/extra-typings';
import type { MiddlewareFunction } from 'yargs';
import { ConfigManager } from '../config/index.js';
import { createLogger, LogCategory } from '../logging/Logger.js';
import { getState } from '../store/vanilla.js';

const logger = createLogger(LogCategory.GENERAL);

type AnyCommand = CommandType<unknown[], Record<string, unknown>, Record<string, unknown>>;

function validatePermissionsCore(opts: Record<string, unknown>): void {
  if (opts.yolo) {
    if (opts.permissionMode && opts.permissionMode !== 'yolo') {
      throw new Error(
        'Cannot use both --yolo and --permission-mode with different values'
      );
    }
  }

  const allowedTools = opts.allowedTools as string[] | undefined;
  const disallowedTools = opts.disallowedTools as string[] | undefined;

  if (Array.isArray(allowedTools) && allowedTools.length > 0 &&
      Array.isArray(disallowedTools) && disallowedTools.length > 0) {
    const intersection = allowedTools.filter((tool: string) =>
      disallowedTools.includes(tool)
    );
    if (intersection.length > 0) {
      throw new Error(
        `Tools cannot be both allowed and disallowed: ${intersection.join(', ')}`
      );
    }
  }
}

async function loadConfigurationCore(opts: Record<string, unknown>): Promise<void> {
  const rawArgs = process.argv.slice(2);
  if (rawArgs.includes('--help') || rawArgs.includes('-h') ||
      rawArgs.includes('--version') || rawArgs.includes('-V')) {
    return;
  }

  try {
    const configManager = ConfigManager.getInstance();
    const config = await configManager.initialize();
    getState().config.actions.setConfig(config);

    if (opts.debug) {
      logger.info('[CLI] 配置已加载到 Store');
    }
  } catch (error) {
    throw new Error(
      `配置初始化失败: ${error instanceof Error ? error.message : '未知错误'}`
    );
  }

  if (opts.continue && opts.resume) {
    throw new Error(
      'Cannot use both --continue and --resume flags simultaneously'
    );
  }
}

function validateOutputCore(opts: Record<string, unknown>): void {
  if (opts.outputFormat && opts.outputFormat !== 'text' && !opts.print && !opts.headless) {
    throw new Error(
      '--output-format can only be used with --print or --headless'
    );
  }

  if (opts.inputFormat === 'stream-json' && opts.print) {
    logger.warn(
      '⚠️  Warning: stream-json input format may not work as expected with --print'
    );
  }
}

export function validatePermissionsHook(thisCommand: AnyCommand, _actionCommand: AnyCommand): void {
  const opts = thisCommand.optsWithGlobals() as Record<string, unknown>;
  validatePermissionsCore(opts);
  if (opts.yolo) {
    thisCommand.setOptionValue('permissionMode', 'yolo');
  }
}

export async function loadConfigurationHook(thisCommand: AnyCommand, _actionCommand: AnyCommand): Promise<void> {
  const opts = thisCommand.optsWithGlobals() as Record<string, unknown>;
  await loadConfigurationCore(opts);
}

export function validateOutputHook(thisCommand: AnyCommand, _actionCommand: AnyCommand): void {
  const opts = thisCommand.optsWithGlobals() as Record<string, unknown>;
  validateOutputCore(opts);
}

/** @deprecated Yargs middleware - kept for backward compatibility with headless/print commands */
export const validatePermissions: MiddlewareFunction = (argv) => {
  validatePermissionsCore(argv as Record<string, unknown>);
  if (argv.yolo) {
    argv.permissionMode = 'yolo';
  }
};

/** @deprecated Yargs middleware - kept for backward compatibility with headless/print commands */
export const loadConfiguration: MiddlewareFunction = async (argv) => {
  await loadConfigurationCore(argv as Record<string, unknown>);
};

/** @deprecated Yargs middleware - kept for backward compatibility with headless/print commands */
export const validateOutput: MiddlewareFunction = (argv) => {
  validateOutputCore(argv as Record<string, unknown>);
};

export function setupErrorHandling(program: AnyCommand): void {
  program.exitOverride((err: CommanderError) => {
    if (err.code === 'commander.helpDisplayed' || err.code === 'commander.version') {
      process.exit(0);
    }
    throw err;
  });

  program.configureOutput({
    outputError(str: string, write: (s: string) => void) {
      write(`❌ ${str}`);
    },
  });
}
