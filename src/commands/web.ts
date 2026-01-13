/**
 * Blade Web 命令
 *
 * 启动 Web 服务器，提供浏览器界面进行 AI 编码交互
 *
 * 用法：
 *   blade web                    # 启动 Web 服务器（默认端口 8000）
 *   blade web --port 3000        # 指定端口
 *   blade web --no-open          # 不自动打开浏览器
 */

import open from 'open';
import type { CommandModule } from 'yargs';
import { createWebServer } from '../acp/web/WebServer.js';
import { createLogger, LogCategory } from '../logging/Logger.js';

const logger = createLogger(LogCategory.SERVICE);

interface WebCommandArgs {
  port: number;
  host: string;
  open: boolean;
}

export const webCommands: CommandModule<{}, WebCommandArgs> = {
  command: 'web',
  describe: 'Start Blade Web server for browser-based AI coding',
  builder: {
    port: {
      alias: 'p',
      type: 'number',
      default: 8000,
      describe: 'Port to listen on',
    },
    host: {
      alias: 'H',
      type: 'string',
      default: 'localhost',
      describe: 'Host to bind to',
    },
    open: {
      alias: 'o',
      type: 'boolean',
      default: true,
      describe: 'Open browser automatically',
    },
  },
  handler: async (argv) => {
    const { port, host, open: shouldOpen } = argv;

    console.log('');
    console.log('⚔️  Blade Web');
    console.log('');

    try {
      // 启动 Web 服务器
      const server = await createWebServer({
        port,
        host,
        cwd: process.cwd(),
      });

      console.log(`✅ 服务器启动成功: ${server.url}`);
      console.log(`📁 工作目录: ${process.cwd()}`);
      console.log('');
      console.log('📖 API 端点:');
      console.log(`   ACP 协议:`);
      console.log(`   - GET  ${server.url}/ping          健康检查`);
      console.log(`   - GET  ${server.url}/agents        Agent 发现`);
      console.log(`   - POST ${server.url}/runs          创建运行`);
      console.log(`   - GET  ${server.url}/runs/:id      运行状态`);
      console.log('');
      console.log(`   管理 API:`);
      console.log(`   - GET  ${server.url}/api/sessions  会话列表`);
      console.log(`   - GET  ${server.url}/api/config    配置信息`);
      console.log('');
      console.log('按 Ctrl+C 停止服务器');
      console.log('');

      // 自动打开浏览器
      if (shouldOpen) {
        try {
          await open(server.url);
          console.log(`🌐 浏览器已打开: ${server.url}`);
        } catch (error) {
          logger.warn('[web] 无法自动打开浏览器:', error);
          console.log(`💡 请手动打开浏览器访问: ${server.url}`);
        }
      }

      // 等待进程终止
      await new Promise<void>((resolve) => {
        process.on('SIGINT', () => {
          console.log('\n👋 正在关闭服务器...');
          server.close();
          resolve();
        });

        process.on('SIGTERM', () => {
          server.close();
          resolve();
        });
      });
    } catch (error) {
      console.error('❌ 启动 Web 服务器失败:', error);
      process.exit(1);
    }
  },
};
