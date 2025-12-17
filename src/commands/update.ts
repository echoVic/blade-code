/**
 * Update 命令 - Yargs 版本
 */

import { execSync } from 'child_process';
import type { CommandModule } from 'yargs';
import type { UpdateOptions } from '../cli/types.js';
import { checkVersion } from '../services/VersionChecker.js';

export const updateCommands: CommandModule<{}, UpdateOptions> = {
  command: 'update',
  describe: 'Check for updates and install if available',
  handler: async () => {
    console.log('🔍 Checking for updates...');

    try {
      const result = await checkVersion(true); // 强制检查，忽略缓存

      console.log(`📦 Current version: ${result.currentVersion}`);

      if (result.error) {
        console.log(`⚠️  ${result.error}`);
        return;
      }

      if (result.latestVersion) {
        console.log(`📦 Latest version:  ${result.latestVersion}`);
      }

      if (result.hasUpdate && result.latestVersion) {
        console.log('');
        console.log(
          `\x1b[33m⚠️  Update available: ${result.currentVersion} → ${result.latestVersion}\x1b[0m`
        );
        console.log('');
        console.log('🚀 Updating...');
        try {
          execSync('npm install -g blade-code@latest --registry https://registry.npmjs.org', { stdio: 'inherit' });
          console.log('');
          console.log('✅ Update complete!');
        } catch (_errrr) {
          console.error('❌ Update failed. Please run manually:');
          console.error('   npm install -g blade-code@latest');
          process.exit(1);
        }
      } else {
        console.log('✅ You are running the latest version of Blade');
      }
    } catch (error) {
      console.error(
        `❌ Failed to check for updates: ${error instanceof Error ? error.message : '未知错误'}`
      );
      process.exit(1);
    }
  },
};
