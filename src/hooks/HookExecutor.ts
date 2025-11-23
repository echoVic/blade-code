/**
 * Hook Executor
 *
 * 负责执行单个或多个 Hooks
 */

import {
  HookType,
  type Hook,
  type HookInput,
  type HookExecutionContext,
  type HookExecutionResult,
  type PreToolHookResult,
  type PostToolHookResult,
  type CommandHook,
} from './types/HookTypes.js';
import { SecureProcessExecutor } from './SecureProcessExecutor.js';
import { OutputParser } from './OutputParser.js';

/**
 * Hook 执行器
 */
export class HookExecutor {
  private processExecutor = new SecureProcessExecutor();
  private outputParser = new OutputParser();

  /**
   * 执行 PreToolUse Hooks (串行)
   *
   * 串行执行的原因:
   * 1. 第一个 deny 需要立即中断
   * 2. updatedInput 需要累积应用
   */
  async executePreToolHooks(
    hooks: Hook[],
    input: HookInput,
    context: HookExecutionContext
  ): Promise<PreToolHookResult> {
    if (hooks.length === 0) {
      return { decision: 'allow' };
    }

    let cumulativeInput =
      'tool_input' in input
        ? (input.tool_input as Record<string, unknown>)
        : {};

    const warnings: string[] = [];

    // 串行执行
    for (const hook of hooks) {
      try {
        const hookInput = {
          ...input,
          ...(cumulativeInput && { tool_input: cumulativeInput }),
        };

        const result = await this.executeHook(
          hook,
          hookInput as HookInput,
          context
        );

        // 处理结果
        if (!result.success) {
          if (result.blocking) {
            // 阻塞错误 - 立即返回 deny
            return {
              decision: 'deny',
              reason: result.error,
            };
          }

          if (result.needsConfirmation) {
            // 需要确认 - 返回 ask
            return {
              decision: 'ask',
              reason: result.warning || result.error,
            };
          }

          // 非阻塞错误 - 记录警告,继续
          if (result.warning) {
            warnings.push(result.warning);
          }
          continue;
        }

        // 检查 hookSpecificOutput
        const specific = result.output?.hookSpecificOutput;
        if (specific && 'permissionDecision' in specific) {
          switch (specific.permissionDecision) {
            case 'deny':
              return {
                decision: 'deny',
                reason: specific.permissionDecisionReason,
              };

            case 'ask':
              return {
                decision: 'ask',
                reason: specific.permissionDecisionReason,
              };

            case 'allow':
              // 继续执行
              break;
          }

          // 累积 updatedInput
          if (specific.updatedInput) {
            cumulativeInput = {
              ...cumulativeInput,
              ...specific.updatedInput,
            };
          }
        }
      } catch (err) {
        // Hook 执行异常,根据 failureBehavior 处理
        const errorMsg = err instanceof Error ? err.message : String(err);
        warnings.push(`Hook failed: ${errorMsg}`);

        if (context.config.failureBehavior === 'deny') {
          return {
            decision: 'deny',
            reason: errorMsg,
          };
        } else if (context.config.failureBehavior === 'ask') {
          return {
            decision: 'ask',
            reason: `Hook failed: ${errorMsg}. Continue?`,
          };
        }
        // ignore - 继续执行
      }
    }

    return {
      decision: 'allow',
      modifiedInput: cumulativeInput,
      warning: warnings.length > 0 ? warnings.join('\n') : undefined,
    };
  }

  /**
   * 执行 PostToolUse Hooks (并行)
   *
   * 并行执行的原因:
   * 1. 提高性能
   * 2. 结果互不影响,可以合并
   */
  async executePostToolHooks(
    hooks: Hook[],
    input: HookInput,
    context: HookExecutionContext
  ): Promise<PostToolHookResult> {
    if (hooks.length === 0) {
      return {};
    }

    // 限制并发数
    const maxConcurrent = context.config.maxConcurrentHooks || 5;
    const results = await this.executeHooksConcurrently(
      hooks,
      input,
      context,
      maxConcurrent
    );

    // 合并结果
    const additionalContexts: string[] = [];
    let modifiedOutput: unknown = undefined;
    const warnings: string[] = [];

    for (const result of results) {
      if (!result.success && result.warning) {
        warnings.push(result.warning);
        continue;
      }

      const specific = result.output?.hookSpecificOutput;
      if (specific && 'additionalContext' in specific) {
        if (specific.additionalContext) {
          additionalContexts.push(specific.additionalContext);
        }

        if (specific.updatedOutput !== undefined) {
          modifiedOutput = specific.updatedOutput;
        }
      }
    }

    return {
      additionalContext:
        additionalContexts.length > 0
          ? additionalContexts.join('\n\n')
          : undefined,
      modifiedOutput,
      warning: warnings.length > 0 ? warnings.join('\n') : undefined,
    };
  }

  /**
   * 执行单个 Hook
   */
  private async executeHook(
    hook: Hook,
    input: HookInput,
    context: HookExecutionContext
  ): Promise<HookExecutionResult> {
    if (hook.type === HookType.Command) {
      return this.executeCommandHook(hook, input, context);
    }

    // Prompt hooks 未来实现
    throw new Error(`Hook type ${hook.type} not yet implemented`);
  }

  /**
   * 执行命令 Hook
   */
  private async executeCommandHook(
    hook: CommandHook,
    input: HookInput,
    context: HookExecutionContext
  ): Promise<HookExecutionResult> {
    const timeoutMs =
      (hook.timeout ?? context.config.defaultTimeout ?? 60) * 1000;

    try {
      const result = await this.processExecutor.execute(
        hook.command,
        input,
        context,
        timeoutMs
      );

      return this.outputParser.parse(result, hook, {
        timeoutBehavior: context.config.timeoutBehavior,
        failureBehavior: context.config.failureBehavior,
      });
    } catch (err) {
      return {
        success: false,
        blocking: false,
        error: err instanceof Error ? err.message : String(err),
        hook,
      };
    }
  }

  /**
   * 并发执行多个 Hooks (带并发限制)
   */
  private async executeHooksConcurrently(
    hooks: Hook[],
    input: HookInput,
    context: HookExecutionContext,
    maxConcurrent: number
  ): Promise<HookExecutionResult[]> {
    const results: Promise<HookExecutionResult>[] = [];
    const executing = new Set<Promise<void>>();

    for (const hook of hooks) {
      // 如果达到并发限制,等待一个完成
      if (executing.size >= maxConcurrent) {
        // 等待任意一个 Promise 完成
        await Promise.race(executing);
      }

      // 创建新的 hook 执行 Promise
      const promise = this.executeHook(hook, input, context).catch((err) => ({
        success: false,
        blocking: false,
        error: err instanceof Error ? err.message : String(err),
        hook,
      }));

      // 创建一个 void Promise 用于跟踪完成状态
      const tracker = promise.then(() => {
        executing.delete(tracker);
      }).catch(() => {
        executing.delete(tracker);
      });

      executing.add(tracker);
      results.push(promise);
    }

    // 等待所有剩余的 hooks 完成
    return Promise.all(results);
  }
}
