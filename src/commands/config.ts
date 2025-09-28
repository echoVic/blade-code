/**
 * 配置管理命令
 */

import { Command } from 'commander';
import { ConfigManager } from '../config/config-manager.js';
import { UIDisplay, UIInput } from '../ui/index.js';

/**
 * 注册配置相关命令
 */
export function configCommand(program: Command) {
  const configCmd = program.command('config').description('⚙️ 配置管理');
  const configManager = ConfigManager.getInstance();

  // 显示当前配置
  configCmd
    .command('show')
    .alias('s')
    .description('📋 显示当前配置')
    .action(async () => {
      try {
        await configManager.initialize(); //确保配置已加载
        const config = configManager.getConfig();
        UIDisplay.text(JSON.stringify(config, null, 2));
      } catch (error) {
        UIDisplay.error(`获取配置失败: ${error instanceof Error ? error.message : '未知错误'}`);
      }
    });

  // 重置配置
  configCmd
    .command('reset')
    .description('🔄 重置配置为默认值')
    .action(async () => {
      const confirm = await UIInput.confirm('确定要重置所有配置吗？这将删除您的用户配置。', { default: false });

      if (confirm) {
        try {
          await configManager.resetConfig();
          UIDisplay.success('配置已成功重置为默认值。');
        } catch (error) {
          UIDisplay.error(`重置配置失败: ${error instanceof Error ? error.message : '未知错误'}`);
        }
      } else {
        UIDisplay.muted('取消重置');
      }
    });
}
