/**
 * 优雅退出管理器
 *
 * 负责：
 * 1. 全局崩溃捕获 (uncaughtException/unhandledRejection)
 * 2. 信号处理 (SIGINT/SIGTERM)
 * 3. 资源清理和会话保存
 * 4. 恢复终端状态（光标等）
 * 5. 执行 SessionEnd hooks
 */

import { PermissionMode } from '../config/types.js';
import { HookManager } from '../hooks/HookManager.js';
import type { SessionEndInput } from '../hooks/types/HookTypes.js';
import { createLogger, LogCategory, shutdownLogger } from '../logging/Logger.js';
import { getState } from '../store/vanilla.js';

/**
 * 恢复终端状态
 * 确保退出时光标可见、终端模式正常
 */
function restoreTerminal(): void {
  // 显示光标（ANSI 转义序列 ESC[?25h）
  process.stdout.write('\x1B[?25h');
  // 重置终端属性
  process.stdout.write('\x1B[0m');
}

const logger = createLogger(LogCategory.SERVICE);

/** 清理函数类型 */
type CleanupHandler = () => void | Promise<void>;

/** 退出原因 */
type ExitReason =
  | 'uncaughtException'
  | 'unhandledRejection'
  | 'SIGINT'
  | 'SIGTERM'
  | 'esc'
  | 'normal';

/**
 * 将 ExitReason 映射到 SessionEnd hook 的 reason
 */
function mapExitReasonToHookReason(reason: ExitReason): SessionEndInput['reason'] {
  switch (reason) {
    case 'SIGINT':
      return 'ctrl_c';
    case 'esc':
      return 'esc';
    case 'uncaughtException':
    case 'unhandledRejection':
      return 'error';
    case 'SIGTERM':
    case 'normal':
    default:
      return 'user_exit';
  }
}

/**
 * 优雅退出管理器
 * 单例模式，确保全局只有一个实例处理退出逻辑
 */
class GracefulShutdownManager {
  private static instance: GracefulShutdownManager | null = null;

  private cleanupHandlers: CleanupHandler[] = [];
  private isShuttingDown = false;
  private initialized = false;

  private constructor() {}

  static getInstance(): GracefulShutdownManager {
    if (!GracefulShutdownManager.instance) {
      GracefulShutdownManager.instance = new GracefulShutdownManager();
    }
    return GracefulShutdownManager.instance;
  }

  /**
   * 初始化全局错误处理器
   * 应该在应用启动时调用一次
   */
  initialize(): void {
    if (this.initialized) {
      logger.debug('[GracefulShutdown] 已初始化，跳过重复初始化');
      return;
    }

    // 捕获未处理的异常
    process.on('uncaughtException', (error: Error) => {
      this.handleFatalError('uncaughtException', error);
    });

    // 捕获未处理的 Promise 拒绝
    process.on('unhandledRejection', (reason: unknown) => {
      const error = reason instanceof Error ? reason : new Error(String(reason));
      this.handleFatalError('unhandledRejection', error);
    });

    // 处理 SIGTERM（通常由进程管理器发送，如 Docker、PM2）
    process.on('SIGTERM', () => {
      logger.info('[GracefulShutdown] 收到 SIGTERM 信号');
      this.shutdown('SIGTERM', 0);
    });

    // 注意：SIGINT 由 useCtrlCHandler 处理，这里不重复处理
    // 但如果是非 UI 模式（如 print 模式），需要处理 SIGINT
    if (process.env.BLADE_NON_INTERACTIVE === 'true') {
      process.on('SIGINT', () => {
        logger.info('[GracefulShutdown] 收到 SIGINT 信号（非交互模式）');
        this.shutdown('SIGINT', 0);
      });
    }

    this.initialized = true;
    logger.debug('[GracefulShutdown] 全局错误处理器已初始化');
  }

  /**
   * 注册清理函数
   * 在退出时按注册的逆序执行（后注册的先执行）
   */
  registerCleanup(handler: CleanupHandler): () => void {
    this.cleanupHandlers.push(handler);
    logger.debug(
      `[GracefulShutdown] 注册清理函数，当前共 ${this.cleanupHandlers.length} 个`
    );

    // 返回取消注册的函数
    return () => {
      const index = this.cleanupHandlers.indexOf(handler);
      if (index !== -1) {
        this.cleanupHandlers.splice(index, 1);
        logger.debug(
          `[GracefulShutdown] 取消注册清理函数，剩余 ${this.cleanupHandlers.length} 个`
        );
      }
    };
  }

  /**
   * 处理致命错误
   */
  private handleFatalError(type: ExitReason, error: Error): void {
    // 防止递归错误
    if (this.isShuttingDown) {
      console.error(`[GracefulShutdown] 退出过程中发生额外错误 (${type}):`, error);
      return;
    }

    console.error('');
    console.error('═'.repeat(60));
    console.error(`💥 发生未捕获的错误 (${type})`);
    console.error('═'.repeat(60));
    console.error('');
    console.error('错误信息:', error.message);
    console.error('');
    if (error.stack) {
      console.error('堆栈跟踪:');
      console.error(error.stack);
    }
    console.error('');
    console.error('═'.repeat(60));
    console.error('');

    // 执行清理并退出
    this.shutdown(type, 1);
  }

  /**
   * 执行优雅退出
   */
  async shutdown(reason: ExitReason, exitCode: number = 0): Promise<void> {
    if (this.isShuttingDown) {
      logger.debug('[GracefulShutdown] 已在退出过程中，跳过重复退出');
      return;
    }

    this.isShuttingDown = true;

    logger.info(`[GracefulShutdown] 开始优雅退出 (原因: ${reason})`);

    // 先关闭日志系统的 Worker 线程，避免后续清理过程中的日志写入导致 "worker has exited" 错误
    try {
      await shutdownLogger();
    } catch (_error) {
      // 忽略日志关闭错误
    }

    // 执行 SessionEnd hooks
    try {
      const hookManager = HookManager.getInstance();
      if (hookManager.isEnabled()) {
        const state = getState();
        const sessionId = state.session?.sessionId || 'unknown';
        const permissionMode =
          state.config?.config?.permissionMode || PermissionMode.DEFAULT;

        await hookManager.executeSessionEndHooks(mapExitReasonToHookReason(reason), {
          projectDir: process.cwd(),
          sessionId,
          permissionMode,
        });
      }
    } catch (error) {
      // SessionEnd hooks 失败不应阻止退出
      console.error('[GracefulShutdown] SessionEnd hooks 执行失败:', error);
    }

    // 设置超时保护，防止清理函数卡住
    const timeoutMs = 5000;
    const timeoutPromise = new Promise<void>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`清理超时 (${timeoutMs}ms)`));
      }, timeoutMs);
    });

    try {
      // 按逆序执行清理函数（后注册的先执行）
      const cleanupPromise = this.runCleanupHandlers();

      await Promise.race([cleanupPromise, timeoutPromise]);
    } catch (error) {
      console.error('[GracefulShutdown] 清理过程中发生错误:', error);
    } finally {
      // 恢复终端状态（确保光标可见）
      restoreTerminal();

      // 给 Ink 一点时间完成终端清理
      setTimeout(() => {
        process.exit(exitCode);
      }, 100);
    }
  }

  /**
   * 执行所有清理函数
   */
  private async runCleanupHandlers(): Promise<void> {
    // 逆序执行
    const handlers = [...this.cleanupHandlers].reverse();

    for (const handler of handlers) {
      try {
        const result = handler();
        if (result instanceof Promise) {
          await result;
        }
      } catch (error) {
        console.error('[GracefulShutdown] 清理函数执行失败:', error);
        // 继续执行其他清理函数
      }
    }
  }

  /**
   * 检查是否正在退出
   */
  isExiting(): boolean {
    return this.isShuttingDown;
  }

  /**
   * 重置状态（仅用于测试）
   */
  reset(): void {
    this.isShuttingDown = false;
    this.cleanupHandlers = [];
    this.initialized = false;
  }
}

// 导出单例获取函数
export const getGracefulShutdown = (): GracefulShutdownManager => {
  return GracefulShutdownManager.getInstance();
};

// 导出便捷函数
export const registerCleanup = (handler: CleanupHandler): (() => void) => {
  return getGracefulShutdown().registerCleanup(handler);
};

export const initializeGracefulShutdown = (): void => {
  getGracefulShutdown().initialize();
};

/**
 * 安全退出应用
 * 恢复终端状态后退出，确保光标可见
 *
 * @param exitCode - 退出码（默认 0）
 */
export const safeExit = (exitCode: number = 0): void => {
  restoreTerminal();
  process.exit(exitCode);
};
