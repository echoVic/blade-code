/**
 * Hook Executor
 *
 * 负责执行单个或多个 Hooks
 */

import { OutputParser } from './OutputParser.js';
import { SecureProcessExecutor } from './SecureProcessExecutor.js';
import {
  type CommandHook,
  type CompactionHookResult,
  type Hook,
  type HookExecutionContext,
  type HookExecutionResult,
  type HookInput,
  HookType,
  type NotificationHookResult,
  type PermissionRequestHookResult,
  type PostToolHookResult,
  type PostToolUseFailureHookResult,
  type PreToolHookResult,
  type SessionEndHookResult,
  type SessionStartHookResult,
  type StopHookResult,
  type SubagentStopHookResult,
  type UserPromptSubmitHookResult,
} from './types/HookTypes.js';

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
      'tool_input' in input ? (input.tool_input as Record<string, unknown>) : {};

    const warnings: string[] = [];

    // 串行执行
    for (const hook of hooks) {
      try {
        const hookInput = {
          ...input,
          ...(cumulativeInput && { tool_input: cumulativeInput }),
        };

        const result = await this.executeHook(hook, hookInput as HookInput, context);

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

          // 累积 updatedInput (仅 PreToolUseOutput 有此字段)
          if ('updatedInput' in specific && specific.updatedInput) {
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

        // updatedOutput 仅 PostToolUseOutput 有此字段
        if ('updatedOutput' in specific && specific.updatedOutput !== undefined) {
          modifiedOutput = specific.updatedOutput;
        }
      }
    }

    return {
      additionalContext:
        additionalContexts.length > 0 ? additionalContexts.join('\n\n') : undefined,
      modifiedOutput,
      warning: warnings.length > 0 ? warnings.join('\n') : undefined,
    };
  }

  /**
   * 执行 Stop Hooks (串行)
   *
   * 任何一个 hook 返回 continue: false 就阻止停止
   */
  async executeStopHooks(
    hooks: Hook[],
    input: HookInput,
    context: HookExecutionContext
  ): Promise<StopHookResult> {
    if (hooks.length === 0) {
      return { shouldStop: true };
    }

    const warnings: string[] = [];

    // 串行执行
    for (const hook of hooks) {
      try {
        const result = await this.executeHook(hook, input, context);

        if (!result.success) {
          if (result.warning) {
            warnings.push(result.warning);
          }
          continue;
        }

        // 检查 hookSpecificOutput
        const specific = result.output?.hookSpecificOutput;
        if (specific && 'continue' in specific && specific.continue === false) {
          // Hook 返回 continue: false，阻止停止
          return {
            shouldStop: false,
            continueReason: specific.continueReason,
            warning: warnings.length > 0 ? warnings.join('\n') : undefined,
          };
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        warnings.push(`Hook failed: ${errorMsg}`);
      }
    }

    return {
      shouldStop: true,
      warning: warnings.length > 0 ? warnings.join('\n') : undefined,
    };
  }

  /**
   * 执行 SubagentStop Hooks (串行)
   */
  async executeSubagentStopHooks(
    hooks: Hook[],
    input: HookInput,
    context: HookExecutionContext
  ): Promise<SubagentStopHookResult> {
    if (hooks.length === 0) {
      return { shouldStop: true };
    }

    const warnings: string[] = [];
    const additionalContexts: string[] = [];

    for (const hook of hooks) {
      try {
        const result = await this.executeHook(hook, input, context);

        if (!result.success) {
          if (result.warning) {
            warnings.push(result.warning);
          }
          continue;
        }

        const specific = result.output?.hookSpecificOutput;
        if (specific && 'continue' in specific) {
          if (specific.continue === false) {
            return {
              shouldStop: false,
              continueReason: specific.continueReason,
              warning: warnings.length > 0 ? warnings.join('\n') : undefined,
            };
          }
          if ('additionalContext' in specific && specific.additionalContext) {
            additionalContexts.push(specific.additionalContext);
          }
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        warnings.push(`Hook failed: ${errorMsg}`);
      }
    }

    return {
      shouldStop: true,
      additionalContext:
        additionalContexts.length > 0 ? additionalContexts.join('\n\n') : undefined,
      warning: warnings.length > 0 ? warnings.join('\n') : undefined,
    };
  }

  /**
   * 执行 PermissionRequest Hooks (串行)
   *
   * 第一个 approve 或 deny 决策立即返回
   */
  async executePermissionRequestHooks(
    hooks: Hook[],
    input: HookInput,
    context: HookExecutionContext
  ): Promise<PermissionRequestHookResult> {
    if (hooks.length === 0) {
      return { decision: 'ask' };
    }

    const warnings: string[] = [];

    for (const hook of hooks) {
      try {
        const result = await this.executeHook(hook, input, context);

        if (!result.success) {
          if (result.warning) {
            warnings.push(result.warning);
          }
          continue;
        }

        const specific = result.output?.hookSpecificOutput;
        if (specific && 'permissionDecision' in specific) {
          const decision = specific.permissionDecision;
          if (decision === 'approve' || decision === 'deny') {
            return {
              decision,
              reason: specific.permissionDecisionReason,
              warning: warnings.length > 0 ? warnings.join('\n') : undefined,
            };
          }
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        warnings.push(`Hook failed: ${errorMsg}`);
      }
    }

    return {
      decision: 'ask',
      warning: warnings.length > 0 ? warnings.join('\n') : undefined,
    };
  }

  /**
   * 执行 UserPromptSubmit Hooks (串行)
   *
   * 收集 contextInjection (stdout) 和 updatedPrompt
   */
  async executeUserPromptSubmitHooks(
    hooks: Hook[],
    input: HookInput,
    context: HookExecutionContext
  ): Promise<UserPromptSubmitHookResult> {
    if (hooks.length === 0) {
      return { proceed: true };
    }

    const warnings: string[] = [];
    const contextInjections: string[] = [];
    let updatedPrompt: string | undefined;

    for (const hook of hooks) {
      try {
        const result = await this.executeHook(hook, input, context);

        if (!result.success) {
          if (result.blocking) {
            // 阻塞错误，停止处理
            return {
              proceed: false,
              warning: result.error,
            };
          }
          if (result.warning) {
            warnings.push(result.warning);
          }
          continue;
        }

        // 收集 stdout 作为 contextInjection
        if (result.stdout && result.stdout.trim()) {
          contextInjections.push(result.stdout.trim());
        }

        const specific = result.output?.hookSpecificOutput;
        if (specific && 'updatedPrompt' in specific) {
          if (specific.updatedPrompt) {
            updatedPrompt = specific.updatedPrompt;
          }
          if (specific.contextInjection) {
            contextInjections.push(specific.contextInjection);
          }
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        warnings.push(`Hook failed: ${errorMsg}`);
      }
    }

    return {
      proceed: true,
      updatedPrompt,
      contextInjection:
        contextInjections.length > 0 ? contextInjections.join('\n\n') : undefined,
      warning: warnings.length > 0 ? warnings.join('\n') : undefined,
    };
  }

  /**
   * 执行 SessionStart Hooks (串行)
   *
   * 收集环境变量
   */
  async executeSessionStartHooks(
    hooks: Hook[],
    input: HookInput,
    context: HookExecutionContext
  ): Promise<SessionStartHookResult> {
    if (hooks.length === 0) {
      return { proceed: true };
    }

    const warnings: string[] = [];
    const env: Record<string, string> = {};

    for (const hook of hooks) {
      try {
        const result = await this.executeHook(hook, input, context);

        if (!result.success) {
          if (result.blocking) {
            return {
              proceed: false,
              warning: result.error,
            };
          }
          if (result.warning) {
            warnings.push(result.warning);
          }
          continue;
        }

        const specific = result.output?.hookSpecificOutput;
        if (specific && 'env' in specific && specific.env) {
          Object.assign(env, specific.env);
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        warnings.push(`Hook failed: ${errorMsg}`);
      }
    }

    return {
      proceed: true,
      env: Object.keys(env).length > 0 ? env : undefined,
      warning: warnings.length > 0 ? warnings.join('\n') : undefined,
    };
  }

  /**
   * 执行 SessionEnd Hooks (并行，不阻塞)
   */
  async executeSessionEndHooks(
    hooks: Hook[],
    input: HookInput,
    context: HookExecutionContext
  ): Promise<SessionEndHookResult> {
    if (hooks.length === 0) {
      return {};
    }

    const warnings: string[] = [];

    // 并行执行，不阻塞
    const maxConcurrent = context.config.maxConcurrentHooks || 5;
    const results = await this.executeHooksConcurrently(
      hooks,
      input,
      context,
      maxConcurrent
    );

    for (const result of results) {
      if (!result.success && result.warning) {
        warnings.push(result.warning);
      }
    }

    return {
      warning: warnings.length > 0 ? warnings.join('\n') : undefined,
    };
  }

  /**
   * 执行 PostToolUseFailure Hooks (并行)
   */
  async executePostToolUseFailureHooks(
    hooks: Hook[],
    input: HookInput,
    context: HookExecutionContext
  ): Promise<PostToolUseFailureHookResult> {
    if (hooks.length === 0) {
      return {};
    }

    const warnings: string[] = [];
    const additionalContexts: string[] = [];

    const maxConcurrent = context.config.maxConcurrentHooks || 5;
    const results = await this.executeHooksConcurrently(
      hooks,
      input,
      context,
      maxConcurrent
    );

    for (const result of results) {
      if (!result.success && result.warning) {
        warnings.push(result.warning);
        continue;
      }

      // 收集 stdout 作为 additionalContext
      if (result.stdout && result.stdout.trim()) {
        additionalContexts.push(result.stdout.trim());
      }
    }

    return {
      additionalContext:
        additionalContexts.length > 0 ? additionalContexts.join('\n\n') : undefined,
      warning: warnings.length > 0 ? warnings.join('\n') : undefined,
    };
  }

  /**
   * 执行 Notification Hooks (串行)
   */
  async executeNotificationHooks(
    hooks: Hook[],
    input: HookInput,
    context: HookExecutionContext
  ): Promise<NotificationHookResult> {
    const originalMessage = 'message' in input ? (input.message as string) : '';

    if (hooks.length === 0) {
      return { suppress: false, message: originalMessage };
    }

    const warnings: string[] = [];
    let suppress = false;
    let message = originalMessage;

    for (const hook of hooks) {
      try {
        const result = await this.executeHook(hook, input, context);

        if (!result.success) {
          if (result.warning) {
            warnings.push(result.warning);
          }
          continue;
        }

        // 检查是否抑制通知
        if (result.output?.suppressOutput) {
          suppress = true;
          break;
        }

        // 修改消息内容（来自 stdout）
        if (result.stdout && result.stdout.trim()) {
          message = result.stdout.trim();
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        warnings.push(`Hook failed: ${errorMsg}`);
      }
    }

    return {
      suppress,
      message,
      warning: warnings.length > 0 ? warnings.join('\n') : undefined,
    };
  }

  /**
   * 执行 Compaction Hooks (串行)
   */
  async executeCompactionHooks(
    hooks: Hook[],
    input: HookInput,
    context: HookExecutionContext
  ): Promise<CompactionHookResult> {
    if (hooks.length === 0) {
      return { blockCompaction: false };
    }

    const warnings: string[] = [];

    for (const hook of hooks) {
      try {
        const result = await this.executeHook(hook, input, context);

        if (!result.success) {
          if (result.warning) {
            warnings.push(result.warning);
          }
          continue;
        }

        const specific = result.output?.hookSpecificOutput;
        if (specific && 'blockCompaction' in specific && specific.blockCompaction) {
          return {
            blockCompaction: true,
            blockReason: specific.blockReason,
            warning: warnings.length > 0 ? warnings.join('\n') : undefined,
          };
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        warnings.push(`Hook failed: ${errorMsg}`);
      }
    }

    return {
      blockCompaction: false,
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
    const timeoutMs = (hook.timeout ?? context.config.defaultTimeout ?? 60) * 1000;

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
      const tracker = promise
        .then(() => {
          executing.delete(tracker);
        })
        .catch(() => {
          executing.delete(tracker);
        });

      executing.add(tracker);
      results.push(promise);
    }

    // 等待所有剩余的 hooks 完成
    return Promise.all(results);
  }
}
