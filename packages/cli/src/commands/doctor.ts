/**
 * Doctor 命令 - Yargs 版本
 */

import type { CommandModule } from 'yargs';
import type { DoctorOptions } from '../cli/types.js';
import { ConfigManager } from '../config/index.js';

export const doctorCommands: CommandModule<{}, DoctorOptions> = {
  command: 'doctor',
  describe: 'Check the health of your Blade installation',
  handler: async () => {
    console.log('🔍 Running Blade health check...\n');

    let issues = 0;

    // 检查配置
    try {
      const configManager = ConfigManager.getInstance();
      await configManager.initialize();
      console.log('✅ Configuration: OK');
    } catch (error) {
      console.log('❌ Configuration: FAILED');
      console.log(`   Error: ${error instanceof Error ? error.message : '未知错误'}`);
      issues++;
    }

    // 检查 Node.js 版本
    const nodeVersion = process.version;
    const majorVersion = parseInt(nodeVersion.slice(1).split('.')[0]);
    if (majorVersion >= 18) {
      console.log(`✅ Node.js version: ${nodeVersion}`);
    } else {
      console.log(`⚠️  Node.js version: ${nodeVersion} (recommended: v18+)`);
      issues++;
    }

    // 检查权限
    try {
      const fs = await import('fs/promises');
      const testPath = process.cwd();
      await fs.access(
        testPath,
        (await import('fs')).constants.R_OK | (await import('fs')).constants.W_OK
      );
      console.log('✅ File system permissions: OK');
    } catch (_error) {
      console.log('❌ File system permissions: FAILED');
      console.log('   Error: Cannot read/write in current directory');
      issues++;
    }

    // 检查依赖
    try {
      await import('ink');
      console.log('✅ Dependencies: OK');
    } catch (_error) {
      console.log('❌ Dependencies: FAILED');
      console.log('   Error: Missing required dependencies');
      issues++;
    }

    // 总结
    console.log('\n📊 Health Check Summary:');
    if (issues === 0) {
      console.log('🎉 All checks passed! Blade is ready to use.');
    } else {
      console.log(
        `⚠️  Found ${issues} issue(s). Please resolve them for optimal performance.`
      );
      process.exit(1);
    }
  },
};
