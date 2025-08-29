/**
 * 配置管理命令
 */

import { Command } from 'commander';
import { resetUserConfig, showCurrentConfig } from '../config/user-config.js';
import { UIDisplay, UIInput } from '../ui/index.js';

/**
 * 注册配置相关命令
 */
export function configCommand(program: Command) {
  const configCmd = program.command('config').description('⚙️ 配置管理');

  // 显示当前配置
  configCmd
    .command('show')
    .alias('s')
    .description('📋 显示当前配置')
    .action(() => {
      showCurrentConfig();
    });

  // 重置配置
  configCmd
    .command('reset')
    .description('🔄 重置配置为默认值')
    .action(async () => {
      const confirm = await UIInput.confirm('确定要重置所有配置吗？', { default: false });

      if (confirm) {
        resetUserConfig();
      } else {
        UIDisplay.muted('取消重置');
      }
    });
}
