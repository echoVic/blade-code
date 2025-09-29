import { Command } from 'commander';
import { ConfigManager } from '../config/config-manager.js';
import type { BladeConfig } from '../config/types.js';

export function configCommand(program: Command) {
  const config = program
    .command('config')
    .description('Manage configuration (eg. blade config set -g theme dark)');

  config
    .command('set')
    .option('-g, --global', 'Set global config')
    .argument('<key>', 'Config key')
    .argument('<value>', 'Config value')
    .action(async (key: string, value: string, options: { global?: boolean }) => {
      try {
        const configManager = new ConfigManager();
        await configManager.initialize();

        // 创建配置更新对象 - 使用 Partial<BladeConfig> 类型
        const keys = key.split('.');
        const update = {} as Partial<BladeConfig>;
        let target: any = update;

        // 构建嵌套的更新对象
        for (let i = 0; i < keys.length - 1; i++) {
          if (!target[keys[i]]) {
            target[keys[i]] = {};
          }
          target = target[keys[i]];
        }
        target[keys[keys.length - 1]] = value;

        // 使用 updateConfig 方法
        await configManager.updateConfig(update);
        console.log(`✅ Set ${key} = ${value}${options.global ? ' (global)' : ''}`);
      } catch (error) {
        console.error(
          `❌ Failed to set config: ${error instanceof Error ? error.message : '未知错误'}`
        );
        process.exit(1);
      }
    });

  config
    .command('get')
    .argument('<key>', 'Config key')
    .action(async (key: string) => {
      try {
        const configManager = new ConfigManager();
        await configManager.initialize();
        const config = configManager.getConfig();

        // 支持嵌套键访问
        const keys = key.split('.');
        let value: any = config;
        for (const k of keys) {
          value = value?.[k];
          if (value === undefined) break;
        }

        if (value !== undefined) {
          console.log(
            typeof value === 'object' ? JSON.stringify(value, null, 2) : value
          );
        } else {
          console.log(`Config key "${key}" not found`);
        }
      } catch (error) {
        console.error(
          `❌ Failed to get config: ${error instanceof Error ? error.message : '未知错误'}`
        );
        process.exit(1);
      }
    });

  config
    .command('list')
    .description('List all configuration')
    .action(async () => {
      try {
        const configManager = new ConfigManager();
        await configManager.initialize();
        const config = configManager.getConfig();
        console.log(JSON.stringify(config, null, 2));
      } catch (error) {
        console.error(
          `❌ Failed to list config: ${error instanceof Error ? error.message : '未知错误'}`
        );
        process.exit(1);
      }
    });
}
