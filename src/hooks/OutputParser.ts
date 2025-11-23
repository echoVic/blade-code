/**
 * Hook Output Parser
 *
 * 解析 Hook 命令的输出
 */

import type {
  ProcessResult,
  HookOutput,
  HookExecutionResult,
  HookExitCode,
  Hook,
  HookConfig,
} from './types/HookTypes.js';
import { safeParseHookOutput } from './schemas/HookSchemas.js';

/**
 * 输出解析器
 */
export class OutputParser {
  /**
   * 解析进程结果
   */
  parse(
    result: ProcessResult,
    hook: Hook,
    config?: Pick<HookConfig, 'timeoutBehavior' | 'failureBehavior'>
  ): HookExecutionResult {
    // 1. 超时 - 根据 timeoutBehavior 配置处理
    if (result.timedOut) {
      const timeoutBehavior = config?.timeoutBehavior || 'ignore';
      const errorMsg = 'Hook timeout';

      if (timeoutBehavior === 'deny') {
        return {
          success: false,
          blocking: true,
          error: errorMsg,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          hook,
        };
      } else if (timeoutBehavior === 'ask') {
        return {
          success: false,
          blocking: false,
          needsConfirmation: true,
          warning: `${errorMsg}. Continue?`,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          hook,
        };
      } else {
        // ignore
        return {
          success: false,
          blocking: false,
          warning: errorMsg,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          hook,
        };
      }
    }

    // 2. 尝试解析 JSON 输出
    const jsonOutput = this.tryParseJSON(result.stdout);

    if (jsonOutput) {
      // 验证 JSON 结构
      const validation = safeParseHookOutput(jsonOutput);

      if (!validation.success) {
        // 验证失败 - 根据 failureBehavior 配置处理
        const errorMsg = 'error' in validation ? validation.error.message : 'Unknown validation error';
        const failureBehavior = config?.failureBehavior || 'ignore';
        const fullMsg = `Invalid hook output JSON: ${errorMsg}`;

        if (failureBehavior === 'deny') {
          return {
            success: false,
            blocking: true,
            error: fullMsg,
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.exitCode,
            hook,
          };
        } else if (failureBehavior === 'ask') {
          return {
            success: false,
            blocking: false,
            needsConfirmation: true,
            warning: `${fullMsg}. Continue?`,
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.exitCode,
            hook,
          };
        } else {
          // ignore
          return {
            success: false,
            blocking: false,
            warning: fullMsg,
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.exitCode,
            hook,
          };
        }
      }

      const output = validation.data as HookOutput;

      // 检查 decision.behavior
      if (output.decision?.behavior === 'block') {
        return {
          success: false,
          blocking: true,
          error: output.systemMessage || 'Hook blocked execution',
          output,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          hook,
        };
      }

      // async behavior - 不阻塞
      if (output.decision?.behavior === 'async') {
        return {
          success: true,
          output,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          hook,
        };
      }

      // approve - 成功
      return {
        success: true,
        output,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        hook,
      };
    }

    // 3. 非 JSON 输出,根据退出码判断
    return this.parseByExitCode(result, hook, config);
  }

  /**
   * 根据退出码解析
   */
  private parseByExitCode(
    result: ProcessResult,
    hook: Hook,
    config?: Pick<HookConfig, 'timeoutBehavior' | 'failureBehavior'>
  ): HookExecutionResult {
    const exitCode = result.exitCode as HookExitCode;

    switch (exitCode) {
      case 0: // SUCCESS
        return {
          success: true,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode,
          hook,
        };

      case 2: // BLOCKING_ERROR
        return {
          success: false,
          blocking: true,
          error: result.stderr || result.stdout || 'Hook returned exit code 2',
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode,
          hook,
        };

      case 124: // TIMEOUT - 根据 timeoutBehavior 配置处理
        {
          const timeoutBehavior = config?.timeoutBehavior || 'ignore';
          const errorMsg = 'Hook timeout';

          if (timeoutBehavior === 'deny') {
            return {
              success: false,
              blocking: true,
              error: errorMsg,
              stdout: result.stdout,
              stderr: result.stderr,
              exitCode,
              hook,
            };
          } else if (timeoutBehavior === 'ask') {
            return {
              success: false,
              blocking: false,
              needsConfirmation: true,
              warning: `${errorMsg}. Continue?`,
              stdout: result.stdout,
              stderr: result.stderr,
              exitCode,
              hook,
            };
          } else {
            // ignore
            return {
              success: false,
              blocking: false,
              warning: errorMsg,
              stdout: result.stdout,
              stderr: result.stderr,
              exitCode,
              hook,
            };
          }
        }

      default: // NON_BLOCKING_ERROR - 根据 failureBehavior 配置处理
        {
          const failureBehavior = config?.failureBehavior || 'ignore';
          const errorMsg =
            result.stderr || result.stdout || `Hook failed with exit code ${exitCode}`;

          if (failureBehavior === 'deny') {
            return {
              success: false,
              blocking: true,
              error: errorMsg,
              stdout: result.stdout,
              stderr: result.stderr,
              exitCode,
              hook,
            };
          } else if (failureBehavior === 'ask') {
            return {
              success: false,
              blocking: false,
              needsConfirmation: true,
              warning: `${errorMsg}. Continue?`,
              stdout: result.stdout,
              stderr: result.stderr,
              exitCode,
              hook,
            };
          } else {
            // ignore
            return {
              success: false,
              blocking: false,
              warning: errorMsg,
              stdout: result.stdout,
              stderr: result.stderr,
              exitCode,
              hook,
            };
          }
        }
    }
  }

  /**
   * 尝试解析 JSON
   */
  private tryParseJSON(text: string): unknown | null {
    try {
      const trimmed = text.trim();
      if (!trimmed) return null;

      // 只解析第一个完整的 JSON 对象
      const match = trimmed.match(/^\s*(\{[\s\S]*\})\s*$/);
      if (!match) return null;

      return JSON.parse(match[1]);
    } catch {
      return null;
    }
  }
}
