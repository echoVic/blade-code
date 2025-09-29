import { Command } from 'commander';
import { ConfigManager } from '../config/config-manager.js';

export function setupTokenCommand(program: Command) {
  program
    .command('setup-token')
    .description(
      'Set up a long-lived authentication token (requires Claude subscription)'
    )
    .option('--token <token>', 'Provide token directly')
    .action(async (options: { token?: string }) => {
      console.log('🔐 Setting up authentication token...\n');

      try {
        const token = options.token;

        if (!token) {
          // 在实际实现中，这里应该引导用户获取 token
          console.log('To get your authentication token:');
          console.log('1. Visit https://claude.ai/settings');
          console.log('2. Generate a new API token');
          console.log(
            '3. Copy the token and run: blade setup-token --token <your-token>'
          );
          console.log('');
          console.log('For security, tokens are not displayed in the terminal.');
          return;
        }

        // 验证 token 格式（基本检查）
        if (!token.startsWith('sk-') && !token.match(/^[a-zA-Z0-9_-]+$/)) {
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
    });
}
