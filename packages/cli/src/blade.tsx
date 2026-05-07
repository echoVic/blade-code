#!/usr/bin/env node
/**
 * Blade Code CLI
 */

import { setProjectRoot } from './bootstrap/state.js';
import { Logger } from './logging/Logger.js';
import { initializeGracefulShutdown } from './services/GracefulShutdown.js';
import type { AppProps } from './ui/App.js';
import { getCwd } from './utils/cwd.js';
import { findProjectRoot, setCwd } from './utils/environment.js';

// NOTE: 关键：在创建任何 logger 之前，先解析 --debug 参数并设置全局配置
// 这样可以确保所有 logger（包括 middleware、commands 中的）都能正确输出到终端
const rawArgs = process.argv.slice(2);
const debugValue = getDebugValue(rawArgs);
const isDebugCli = debugValue !== null;
if (debugValue !== null) {
  Logger.setGlobalDebug(debugValue);
}

function getDebugValue(args: string[]): string | boolean | null {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === '--debug' || arg === '-d') {
      // --debug 可能带参数（分类过滤）或不带（启用全部）
      const nextArg = args[index + 1];
      return nextArg && !nextArg.startsWith('-') ? nextArg : true;
    }

    if (arg.startsWith('--debug=')) {
      return arg.slice('--debug='.length) || true;
    }
  }

  return null;
}

function isPlainVersionRequest(args: string[]): boolean {
  return args.length === 1 && (args[0] === '--version' || args[0] === '-V');
}

function hasFlag(args: string[], ...flags: string[]): boolean {
  return args.some((arg) =>
    flags.some((flag) => arg === flag || arg.startsWith(`${flag}=`))
  );
}

export async function main() {
  if (isPlainVersionRequest(rawArgs)) {
    const { getVersion } = await import('./utils/packageInfo.js');
    console.log(getVersion());
    return;
  }

  // 初始化工作区根目录（必须在所有依赖 cwd 的代码之前）
  // originalCwd 保持为 process.cwd()（已在 bootstrap/state.ts initState 中设置），
  // 用于解析 CLI 参数中的相对路径（如 --mcp-config ./mcp.json）
  const detectedRoot = findProjectRoot(process.cwd());
  setCwd(detectedRoot);
  setProjectRoot(getCwd());

  // 防止使用 sudo 运行（避免创建 root 拥有的文件）
  // 但允许在容器/沙箱/CI 等天然 root 环境中运行
  if (process.getuid && process.getuid() === 0) {
    const isSudo = !!process.env.SUDO_USER;
    const isAllowRoot = !!process.env.BLADE_ALLOW_ROOT;

    // 只有通过 sudo 提权运行时才阻止，天然 root 环境放行
    if (isSudo && !isAllowRoot) {
      console.error('');
      console.error('Error: 请不要使用 sudo 运行 blade');
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

  // 初始化优雅退出处理器（捕获 uncaughtException/unhandledRejection/SIGTERM）
  initializeGracefulShutdown();

  // 首先检查是否是 headless 模式
  if (hasFlag(rawArgs, '--headless')) {
    const { handleHeadlessMode } = await import('./commands/headless.js');
    if (await handleHeadlessMode()) {
      return;
    }
  }

  // 首先检查是否是 print 模式
  if (hasFlag(rawArgs, '--print', '-p')) {
    const { handlePrintMode } = await import('./commands/print.js');
    if (await handlePrintMode()) {
      return;
    }
  }

  // 检查是否是 ACP 模式
  if (rawArgs.includes('--acp')) {
    const { runAcpIntegration } = await import('./acp/index.js');
    await runAcpIntegration();
    return;
  }

  const [
    { default: yargs },
    { hideBin },
    { cliConfig, globalOptions },
    { loadConfiguration, validateOutput, validatePermissions },
    { doctorCommands },
    { installCommands },
    { mcpCommands },
    { serveCommand },
    { updateCommands },
    { webCommand },
  ] = await Promise.all([
    import('yargs'),
    import('yargs/helpers'),
    import('./cli/config.js'),
    import('./cli/middleware.js'),
    import('./commands/doctor.js'),
    import('./commands/install.js'),
    import('./commands/mcp.js'),
    import('./commands/serve.js'),
    import('./commands/update.js'),
    import('./commands/web.js'),
  ]);

  const cli = yargs(hideBin(process.argv))
    .scriptName(cliConfig.scriptName)
    .usage(cliConfig.usage)
    .version(cliConfig.version)
    .locale(cliConfig.locale)
    .showHelpOnFail(cliConfig.showHelpOnFail)
    .demandCommand(0, '')
    .recommendCommands()
    .strict(cliConfig.strict)
    .parserConfiguration({ 'populate--': true })

    // 应用全局选项
    .options(globalOptions)

    // 应用中间件
    .middleware([validatePermissions, loadConfiguration, validateOutput])

    // 注册命令
    .command(mcpCommands)
    .command(doctorCommands)
    .command(updateCommands)
    .command(installCommands)
    .command(webCommand)
    .command(serveCommand)

    // 自动生成补全（隐藏，避免干扰普通用户）
    .completion('completion', false)

    // 帮助和版本
    .help('help', 'Show help')
    .alias('help', 'h')
    .alias('version', 'V')

    // 错误处理
    .fail((msg, err, yargs) => {
      if (err) {
        // CLI 错误输出直接使用 console.error（总是可见，不依赖 debug 模式）
        console.error('An error occurred:');
        console.error(err.message);
        if (isDebugCli && err.stack) {
          console.error('\nStack trace:');
          console.error(err.stack);
        } else {
          console.error('\nRun with --debug to show the stack trace.');
        }
        process.exit(1);
      }

      if (msg) {
        console.error('Error: Invalid arguments:');
        console.error(msg);
        console.error('\nHint: Did you mean:');
        yargs.showHelp();
        process.exit(1);
      }
    })

    // 处理默认行为（无命令时启动UI）
    .command(
      '$0',
      false, // 隐藏此命令，不在 help 中显示
      () => {
        // 不定义 positional，避免在 --help 中显示 Positionals 部分
      },
      async (argv) => {
        // 启动 UI 模式
        // 从 argv._ 中获取额外的参数作为 initialMessage
        const nonOptionArgs = (argv._ as string[]).slice(1); // 跳过命令名
        const initialMessage =
          nonOptionArgs.length > 0 ? nonOptionArgs.join(' ') : undefined;

        // TUI 依赖较重，仅在进入默认交互界面时加载，避免拖慢 --help/--version
        // 和非交互命令。版本检查只影响 TUI 更新提示，与 UI 模块加载并行启动。
        const versionCheckPromise = import('./services/VersionChecker.js').then(
          ({ checkVersionOnStartup }) => checkVersionOnStartup()
        );
        const [{ render }, { createElement }, { AppWrapper: BladeApp }] =
          await Promise.all([import('ink'), import('react'), import('./ui/App.js')]);

        // 启动 React UI - 传递所有选项
        const appProps = {
          ...argv,
          initialMessage,
          // 确保某些字段是正确的类型
          debug: argv.debug,
          print: Boolean(argv.print),
          // 传递版本检查 Promise（与 UI 模块加载并行启动）
          versionCheckPromise,
        } as unknown as AppProps & Record<string, unknown>;

        // 移除内部字段
        delete appProps._;
        delete appProps.$0;
        delete appProps.message;

        render(createElement(BladeApp, appProps), {
          patchConsole: true,
          exitOnCtrlC: false, // 由 useCtrlCHandler 处理（支持智能双击退出）
          // 不使用 alternateBuffer，以支持终端原生滚动
          alternateBuffer: false,
        });
      }
    );

  // 解析参数并执行
  try {
    await cli.parse();
  } catch (error) {
    console.error('Error: Parse error:', error);
    process.exit(1);
  }
}

// 如果直接运行此文件，则启动 CLI
if (import.meta.main) {
  main().catch(console.error);
}
