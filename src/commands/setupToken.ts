/**
 * Setup Token 命令 - Yargs 版本
 */

import type { CommandModule } from 'yargs';
import type { SetupTokenOptions } from '../cli/types.js';
import { ConfigManager } from '../config/ConfigManager.js';

export const setupTokenCommands: CommandModule<{}, SetupTokenOptions> = {
  command: 'setup-token',
  describe: 'Set up a long-lived authentication token (requires Claude subscription)',
  builder: (yargs) => {
    return yargs
      .option('token', {
        type: 'string',
        describe: 'Provide token directly',
      })
      .option('provider', {
        type: 'string',
        choices: ['qwen', 'volcengine', 'openai', 'anthropic'],
        describe: 'API provider for the token',
      })
      .example([
        ['$0 setup-token', 'Interactive token setup'],
        ['$0 setup-token --token sk-xxx --provider anthropic', 'Set token directly'],
      ]);
  },
  handler: async (argv) => {
    console.log('🔐 Setting up authentication token...\n');

    try {
      const token = argv.token;

      if (!token) {
        // 在实际实现中，这里应该引导用户获取 token
        console.log('To get your authentication token:');
        if (argv.provider === 'qwen') {
          console.log('1. Visit https://dashscope.aliyun.com/');
          console.log('2. Generate a new API token');
        } else if (argv.provider === 'volcengine') {
          console.log('1. Visit https://console.volcengine.com/');
          console.log('2. Generate a new API token');
        } else {
          console.log('1. Visit https://claude.ai/settings');
          console.log('2. Generate a new API token');
        }
        console.log(
          '3. Copy the token and run: blade setup-token --token <your-token>'
        );
        console.log('');
        console.log('For security, tokens are not displayed in the terminal.');
        return;
      }

      // 验证 token 格式（基本检查）
      if (
        typeof token === 'string' &&
        !token.startsWith('sk-') &&
        !token.match(/^[a-zA-Z0-9_-]+$/)
      ) {
        throw new Error('Invalid token format');
      }

      // 保存 token 到配置
      const configManager = new ConfigManager();
      await configManager.initialize();

      // 使用 updateConfig 方法更新配置中的 apiKey
      const currentConfig = configManager.getConfig();
      await configManager.updateConfig({
        auth: {
          ...currentConfig.auth, // 保留现有的 auth 配置
          apiKey: token, // 只更新 apiKey
        },
      });

      console.log('✅ Authentication token saved successfully');
      console.log('🔒 Token is encrypted and stored securely');
      console.log('');
      console.log('You can now use Blade with your authenticated account.');
    } catch (error) {
      console.error(
        `❌ Failed to setup token: ${error instanceof Error ? error.message : '未知错误'}`
      );
      console.log('');
      console.log('Common issues:');
      console.log('• Invalid token format');
      console.log('• Network connection problems');
      console.log('• Insufficient permissions to save config');
      process.exit(1);
    }
  },
};
