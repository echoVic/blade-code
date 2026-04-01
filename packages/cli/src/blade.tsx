#!/usr/bin/env node
import { Command } from '@commander-js/extra-typings';
import { render } from 'ink';
import React from 'react';
import type { CommandModule } from 'yargs';
import { applyGlobalOptions, cliConfig } from './cli/config.js';
import {
  loadConfigurationHook,
  setupErrorHandling,
  validateOutputHook,
  validatePermissionsHook,
} from './cli/middleware.js';
import { doctorCommands } from './commands/doctor.js';
import { handleHeadlessMode } from './commands/headless.js';
import { installCommands } from './commands/install.js';
import { mcpCommands } from './commands/mcp.js';
import { handlePrintMode } from './commands/print.js';
import { serveCommand } from './commands/serve.js';
import { updateCommands } from './commands/update.js';
import { webCommand } from './commands/web.js';
import { Logger } from './logging/Logger.js';
import { initializeGracefulShutdown } from './services/GracefulShutdown.js';
import { checkVersionOnStartup } from './services/VersionChecker.js';
import type { AppProps } from './ui/App.js';
import { AppWrapper as BladeApp } from './ui/App.js';

export type OutputFormat = 'text' | 'json' | 'stream-json' | 'jsonl';

export type ExecutionMode =
  | { kind: 'interactive' }
  | { kind: 'print'; prompt: string; outputFormat: OutputFormat }
  | { kind: 'headless'; outputFormat: OutputFormat }
  | { kind: 'acp' };

const rawArgs = process.argv.slice(2);
const debugIndex = rawArgs.indexOf('--debug');
if (debugIndex !== -1) {
  const nextArg = rawArgs[debugIndex + 1];
  const debugValue = nextArg && !nextArg.startsWith('-') ? nextArg : true;
  Logger.setGlobalDebug(debugValue);
}

type YargsCommandLike = Pick<CommandModule, 'command' | 'describe' | 'builder' | 'handler'>;

function registerYargsSubcommand(
  program: Command,
  yargsModule: YargsCommandLike,
) {
  const cmdName = String(yargsModule.command).split(/\s+/)[0];
  const sub = program.command(cmdName);
  if (yargsModule.describe && typeof yargsModule.describe === 'string') {
    sub.description(yargsModule.describe);
  }
  sub.allowUnknownOption(true);
  sub.allowExcessArguments(true);
  sub.action(async () => {
    const yargs = (await import('yargs')).default;
    const { hideBin } = await import('yargs/helpers');
    const cli = yargs(hideBin(process.argv))
      .scriptName('blade')
      .strict(false);
    if (typeof yargsModule.builder === 'function') {
      yargsModule.builder(cli);
    }
    await cli.parse();
  });
}

export async function main() {
  if (process.getuid && process.getuid() === 0) {
    const isSudo = !!process.env.SUDO_USER;
    const isAllowRoot = !!process.env.BLADE_ALLOW_ROOT;

    if (isSudo && !isAllowRoot) {
      console.error('');
      console.error('❌ 请不要使用 sudo 运行 blade');
      console.error('');
      console.error('原因：');
      console.error('  使用 sudo 会创建属于 root 的配置文件，');
      console.error('  导致普通用户无法访问。');
      console.error('');
      console.error('正确用法：');
      console.error('  blade           # 直接运行，不要加 sudo');
      console.error('');
      console.error('如果遇到权限错误，请运行：');
      console.error('  sudo chown -R $USER:$USER ~/.blade/');
      console.error('');
      console.error('如果你确实需要以 root 运行（容器/CI），设置环境变量：');
      console.error('  BLADE_ALLOW_ROOT=1 blade');
      console.error('');
      process.exit(1);
    }
  }

  initializeGracefulShutdown();

  const versionCheckPromise = checkVersionOnStartup();

  if (await handleHeadlessMode()) {
    return;
  }

  if (await handlePrintMode()) {
    return;
  }

  if (rawArgs.includes('--acp')) {
    const { runAcpIntegration } = await import('./acp/index.js');
    await runAcpIntegration();
    return;
  }

  const program = new Command();
  program
    .name(cliConfig.scriptName)
    .usage('[command] [options]')
    .version(cliConfig.version, '-V, --version')
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .showHelpAfterError(true)
    .showSuggestionAfterError(true);

  applyGlobalOptions(program);

  program
    .hook('preAction', validatePermissionsHook)
    .hook('preAction', loadConfigurationHook)
    .hook('preAction', validateOutputHook);

  setupErrorHandling(program);

  registerYargsSubcommand(program, mcpCommands);
  registerYargsSubcommand(program, doctorCommands);
  registerYargsSubcommand(program, updateCommands);
  registerYargsSubcommand(program, installCommands);
  registerYargsSubcommand(program, webCommand);
  registerYargsSubcommand(program, serveCommand);

  program.action(async (_opts, cmd) => {
    const opts = cmd.optsWithGlobals() as Record<string, unknown>;
    const parsedArgs = cmd.args;

    const initialMessage = parsedArgs.length > 0 ? parsedArgs.join(' ') : undefined;

    const appProps = {
      ...opts,
      initialMessage,
      debug: opts.debug,
      print: Boolean(opts.print),
      versionCheckPromise,
    } as unknown as AppProps & Record<string, unknown>;

    render(React.createElement(BladeApp, appProps), {
      patchConsole: true,
      exitOnCtrlC: false,
      alternateBuffer: false,
    });
  });

  try {
    await program.parseAsync(process.argv);
  } catch (error) {
    if (error instanceof Error && 'code' in error) {
      const code = (error as { code: string }).code;
      if (code === 'commander.helpDisplayed' || code === 'commander.version') {
        return;
      }
    }
    console.error('❌ Parse error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

if (import.meta.main) {
  main().catch(console.error);
}
