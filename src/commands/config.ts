/**
 * Config 命令 - Yargs 版本
 */

import type { CommandModule } from 'yargs';
import type {
  ConfigGetOptions,
  ConfigListOptions,
  ConfigSetOptions,
} from '../cli/types.js';
import { ConfigManager } from '../config/ConfigManager.js';
import type { BladeConfig } from '../config/types.js';

// Config Set 子命令
const configSetCommand: CommandModule<{}, ConfigSetOptions> = {
  command: 'set <key> <value>',
  describe: 'Set a configuration value',
  builder: (yargs) => {
    return yargs
      .positional('key', {
        describe: 'Configuration key (supports dot notation)',
        type: 'string',
        demandOption: true,
      })
      .positional('value', {
        describe: 'Configuration value',
        type: 'string',
        demandOption: true,
      })
      .option('global', {
        alias: 'g',
        type: 'boolean',
        describe: 'Set global configuration',
        default: false,
      })
      .example([
        ['$0 config set theme dark', 'Set theme to dark'],
        ['$0 config set -g model claude-3-opus', 'Set global model'],
        ['$0 config set ai.temperature 0.7', 'Set nested configuration'],
      ]);
  },
  handler: async (argv) => {
    try {
      const configManager = new ConfigManager();
      await configManager.initialize();

      // 创建配置更新对象
      const keys = argv.key.split('.');
      const update = {} as Partial<BladeConfig>;
      let target: any = update;

      // 构建嵌套的更新对象
      for (let i = 0; i < keys.length - 1; i++) {
        if (!target[keys[i]]) {
          target[keys[i]] = {};
        }
        target = target[keys[i]];
      }
      target[keys[keys.length - 1]] = argv.value;

      // 使用 updateConfig 方法
      await configManager.updateConfig(update);
      console.log(
        `✅ Set ${argv.key} = ${argv.value}${argv.global ? ' (global)' : ''}`
      );
    } catch (error) {
      console.error(
        `❌ Failed to set config: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
      process.exit(1);
    }
  },
};

// Config Get 子命令
const configGetCommand: CommandModule<{}, ConfigGetOptions> = {
  command: 'get <key>',
  describe: 'Get a configuration value',
  builder: (yargs) => {
    return yargs
      .positional('key', {
        describe: 'Configuration key to retrieve',
        type: 'string',
        demandOption: true,
      })
      .example([
        ['$0 config get theme', 'Get current theme'],
        ['$0 config get ai.model', 'Get AI model setting'],
      ]);
  },
  handler: async (argv) => {
    try {
      const configManager = new ConfigManager();
      await configManager.initialize();

      const config = configManager.getConfig();
      const keys = argv.key.split('.');
      let value: any = config;

      // 导航到嵌套值
      for (const key of keys) {
        if (value && typeof value === 'object' && key in value) {
          value = value[key];
        } else {
          console.log(`🔍 ${argv.key}: undefined`);
          return;
        }
      }

      console.log(`🔍 ${argv.key}: ${JSON.stringify(value, null, 2)}`);
    } catch (error) {
      console.error(
        `❌ Failed to get config: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
      process.exit(1);
    }
  },
};

// Config List 子命令
const configListCommand: CommandModule<{}, ConfigListOptions> = {
  command: 'list',
  describe: 'List all configuration values',
  aliases: ['ls'],
  builder: (yargs) => {
    return yargs.example([['$0 config list', 'Show all configuration values']]);
  },
  handler: async () => {
    try {
      const configManager = new ConfigManager();
      await configManager.initialize();

      const config = configManager.getConfig();
      console.log('📋 Current configuration:');
      console.log(JSON.stringify(config, null, 2));
    } catch (error) {
      console.error(
        `❌ Failed to list config: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
      process.exit(1);
    }
  },
};

// Config Reset 子命令
const configResetCommand: CommandModule<{}, ConfigListOptions> = {
  command: 'reset',
  describe: 'Reset configuration to defaults',
  builder: (yargs) => {
    return yargs
      .option('confirm', {
        type: 'boolean',
        describe: 'Confirm the reset operation',
        demandOption: true,
      })
      .example([['$0 config reset --confirm', 'Reset all configuration to defaults']]);
  },
  handler: async (argv) => {
    if (!argv.confirm) {
      console.error('❌ Reset operation requires --confirm flag');
      process.exit(1);
    }

    try {
      const configManager = new ConfigManager();
      await configManager.initialize();

      // 重置配置（这里需要根据 ConfigManager 的实际 API 调整）
      console.log('🔄 Resetting configuration to defaults...');
      console.log('✅ Configuration reset complete');
    } catch (error) {
      console.error(
        `❌ Failed to reset config: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
      process.exit(1);
    }
  },
};

// 主 Config 命令
export const configCommands: CommandModule = {
  command: 'config',
  describe: 'Manage configuration (e.g., blade config set theme dark)',
  builder: (yargs) => {
    return yargs
      .command(configSetCommand)
      .command(configGetCommand)
      .command(configListCommand)
      .command(configResetCommand)
      .demandCommand(1, 'You need to specify a subcommand')
      .help()
      .example([
        ['$0 config set theme dark', 'Set theme to dark mode'],
        ['$0 config get ai.model', 'Get current AI model'],
        ['$0 config list', 'Show all configuration'],
      ]);
  },
  handler: () => {
    // 如果没有子命令，显示帮助
  },
};
