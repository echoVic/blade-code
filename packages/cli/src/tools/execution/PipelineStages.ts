import {
  PermissionChecker,
  type ToolInvocationDescriptor,
} from '../../config/PermissionChecker.js';
import { PermissionMode } from '../../config/types.js';
import { HookManager } from '../../hooks/HookManager.js';
import { createLogger, LogCategory } from '../../logging/Logger.js';
import { configActions, getConfig } from '../../store/vanilla.js';
import { getCwd } from '../../utils/cwd.js';
import type { ToolRegistry } from '../registry/ToolRegistry.js';
import type { PipelineStage, ToolExecution } from '../types/index.js';
import { ToolErrorType } from '../types/index.js';
import type { SessionApprovalStore } from './SessionApprovalStore.js';

const logger = createLogger(LogCategory.EXECUTION);

/**
 * 工具发现阶段
 * 负责从注册表中查找工具
 */
export class DiscoveryStage implements PipelineStage {
  readonly name = 'discovery';

  constructor(private registry: ToolRegistry) {}

  async process(execution: ToolExecution): Promise<void> {
    const tool = this.registry.get(execution.toolName);

    if (!tool) {
      execution.abort(`Tool "${execution.toolName}" not found`);
      return;
    }

    // 将工具实例附加到执行上下文中
    execution._internal.tool = tool;
  }
}

/**
 * 用户确认阶段
 * 负责请求用户确认（如果需要）
 *
 * 确认触发条件:
 * - effectiveDecision.behavior === 'ask' (由 ResolveDecisionStage 仲裁得出)
 */
export class ConfirmationStage implements PipelineStage {
  readonly name = 'confirmation';
  private permissionChecker: PermissionChecker;

  constructor(
    private readonly sessionApprovals: SessionApprovalStore,
    permissionChecker: PermissionChecker
  ) {
    this.permissionChecker = permissionChecker;
  }

  async process(execution: ToolExecution): Promise<void> {
    const { tool, invocation, effectiveDecision } = execution._internal;

    if (!tool || !invocation) {
      execution.abort('Pre-confirmation stage failed; cannot request user approval');
      return;
    }

    // 只有 effectiveDecision.behavior === 'ask' 才需要用户确认
    // (allow: 直接放行; deny: 已在 ResolveDecisionStage 中 abort)
    if (effectiveDecision?.behavior !== 'ask') {
      return;
    }

    const confirmationReason = effectiveDecision.reason;

    try {
      // 使用工具的 extractSignatureContent 生成具体的签名（如果有）
      const signature = tool.extractSignatureContent
        ? tool.extractSignatureContent(execution.params)
        : tool.name;

      // ========== PermissionRequest Hook ==========
      // 在显示用户确认之前，允许 hook 自动批准或拒绝
      const hookManager = HookManager.getInstance();
      if (hookManager.isEnabled()) {
        const hookResult = await hookManager.executePermissionRequestHooks(
          tool.name,
          execution.context.sessionId || 'unknown',
          execution.params,
          {
            projectDir: getCwd(),
            sessionId: execution.context.sessionId || 'unknown',
            permissionMode: execution.context.permissionMode || PermissionMode.DEFAULT,
          }
        );

        // 根据 hook 决策处理
        switch (hookResult.decision) {
          case 'approve':
            // Hook 自动批准，跳过用户确认
            logger.debug(`PermissionRequest hook 自动批准: ${tool.name}`);
            return;

          case 'deny':
            // Hook 拒绝执行
            execution.abort(
              hookResult.reason || `PermissionRequest hook denied: ${tool.name}`,
              { shouldExitLoop: true }
            );
            return;

          case 'ask':
          default:
            // 继续显示用户确认
            break;
        }
      }

      // 从权限检查结果构建确认详情
      const confirmationDetails = {
        title: signature,
        message: confirmationReason || '此操作需要用户确认',
        kind: tool.kind, // 工具类型，用于 ACP 权限模式判断
        details: this.generatePreviewForTool(tool.name, execution.params),
        risks: this.extractRisksFromPermissionCheck(tool, execution.params),
        affectedFiles: invocation.getAffectedPaths() || [],
      };

      logger.warn(`工具 "${tool.name}" 需要用户确认: ${confirmationDetails.title}`);
      logger.warn(`详情: ${confirmationDetails.message}`);

      if (confirmationDetails.risks && confirmationDetails.risks.length > 0) {
        logger.warn(`风险: ${confirmationDetails.risks.join(', ')}`);
      }

      // 如果提供了 confirmationHandler,使用它来请求用户确认
      const confirmationHandler = execution.context.confirmationHandler;
      if (confirmationHandler) {
        logger.info(`[ConfirmationStage] Requesting confirmation for ${tool.name}`);
        const response =
          await confirmationHandler.requestConfirmation(confirmationDetails);
        logger.info(
          `[ConfirmationStage] Confirmation response: approved=${response.approved}`
        );

        // abort 优先于 denial：如果 signal 已 aborted，说明是 Esc/interrupt 取消任务，
        // 设置 abort result 后 return，让外层 pipeline shouldAbort() 检测并 break。
        // 必须调用 execution.abort() 设置 result，否则 getResult() 会抛异常。
        if (execution.context.signal?.aborted) {
          logger.info(`[ConfirmationStage] Signal aborted, setting abort result`);
          execution.abort('任务已被用户中止', {
            shouldExitLoop: true,
            llmContent: '任务已被用户中止',
            summary: '任务已被用户中止',
            abortedBeforeLaunch: true,
          });
          return;
        }

        if (!response.approved) {
          execution.abort(response.reason || '用户拒绝授权', {
            shouldExitLoop: true,
            llmContent: '已取消工具执行',
            summary: '已取消工具执行',
            errorType: ToolErrorType.PERMISSION_DENIED,
          });
          return;
        }
        logger.info(`[ConfirmationStage] User approved, continuing to execution stage`);

        const scope = response.scope || 'once';
        if (scope === 'session' && execution._internal.permissionSignature) {
          const signature = execution._internal.permissionSignature;
          this.sessionApprovals.add(signature);

          // 构造 descriptor 用于模式抽象
          const descriptor: ToolInvocationDescriptor = {
            toolName: tool.name,
            params: execution.params,
            affectedPaths: invocation.getAffectedPaths() || [],
            tool, // 传递工具实例，用于 abstractPermissionRule
          };

          await this.persistSessionApproval(signature, descriptor);
        }
      } else {
        // 非交互式环境：没有 confirmationHandler，无法向用户确认
        const ctxPermMode = execution.context.permissionMode || PermissionMode.DEFAULT;

        if (ctxPermMode === PermissionMode.YOLO) {
          // YOLO 模式下自动放行
          logger.warn(
            '[WARN] No ConfirmationHandler; auto-approving in YOLO mode (non-interactive environment)'
          );
        } else {
          // 非 YOLO 模式下，拒绝需要确认的操作以保护用户信任边界
          logger.warn(
            `[WARN] No ConfirmationHandler in "${ctxPermMode}" mode; denying tool "${tool.name}" (non-interactive environment). Use --permission-mode yolo to auto-approve.`
          );
          execution.abort(
            `Non-interactive mode with "${ctxPermMode}" permission: tool "${tool.name}" requires user confirmation but no interactive handler is available. Use --permission-mode yolo to allow all operations.`,
            {
              shouldExitLoop: false,
              llmContent: `工具 "${tool.name}" 需要用户确认，但当前为非交互模式且权限模式为 "${ctxPermMode}"。请使用 --permission-mode yolo 来允许所有操作。`,
              summary: '非交互模式下拒绝需要确认的操作',
              errorType: ToolErrorType.PERMISSION_DENIED,
            }
          );
          return;
        }
      }
    } catch (error) {
      execution.abort(`User confirmation failed: ${(error as Error).message}`);
    }
  }

  private async persistSessionApproval(
    signature: string,
    descriptor: ToolInvocationDescriptor
  ): Promise<void> {
    try {
      // 使用 PermissionChecker.abstractPattern 生成模式规则（而非精确签名）
      const pattern = PermissionChecker.abstractPattern(descriptor);

      logger.debug(`保存权限规则: "${pattern}"`);
      // 使用 configActions 自动同步内存 + 持久化
      await configActions().appendLocalPermissionAllowRule(pattern, {
        immediate: true,
      });

      // 重要：从 store 读取最新配置，使新规则立即生效（避免重复确认）
      const currentConfig = getConfig();
      if (currentConfig?.permissions) {
        logger.debug(`同步权限配置到 PermissionChecker:`, currentConfig.permissions);
        this.permissionChecker.replaceConfig(currentConfig.permissions);
      }
    } catch (error) {
      logger.warn(
        `Failed to persist permission rule "${signature}": ${
          error instanceof Error ? error.message : 'Unknown error'
        }`
      );
    }
  }

  /**
   * 为工具生成预览内容
   * 用于在确认提示中显示操作详情
   */
  private generatePreviewForTool(
    toolName: string,
    params: Record<string, unknown>
  ): string | undefined {
    switch (toolName) {
      case 'Edit': {
        const oldString = params.old_string as string;
        const newString = params.new_string as string;

        if (!oldString && !newString) {
          return undefined;
        }

        // 限制预览长度
        const maxLines = 20;
        const truncate = (text: string): string => {
          const lines = text.split('\n');
          if (lines.length <= maxLines) {
            return text;
          }
          return `${lines.slice(0, maxLines).join('\n')}\n... (还有 ${lines.length - maxLines} 行)`;
        };

        return `**变更前:**\n\`\`\`\n${truncate(oldString || '(空)')}\n\`\`\`\n\n**变更后:**\n\`\`\`\n${truncate(newString || '(删除)')}\n\`\`\``;
      }

      case 'Write': {
        const content = params.content as string;
        const encoding = (params.encoding as string) || 'utf8';

        if (encoding !== 'utf8' || !content) {
          return `将写入 ${encoding === 'base64' ? 'Base64 编码' : encoding === 'binary' ? '二进制' : ''} 内容`;
        }

        // 限制预览长度
        const maxLines = 30;
        const lines = content.split('\n');

        if (lines.length <= maxLines) {
          return `**文件内容预览:**\n\`\`\`\n${content}\n\`\`\``;
        }

        const preview = lines.slice(0, maxLines).join('\n');
        return `**文件内容预览 (前 ${maxLines} 行):**\n\`\`\`\n${preview}\n\`\`\`\n\n... (还有 ${lines.length - maxLines} 行)`;
      }

      case 'Bash':
      case 'Shell':
        // Bash 命令已在标题中显示（通过 extractSignatureContent）
        // 不需要在"操作详情"中重复显示
        return undefined;

      default:
        return undefined;
    }
  }

  /**
   * 从权限检查结果提取风险信息和改进建议
   */
  private extractRisksFromPermissionCheck(
    tool: { name: string },
    params: Record<string, unknown>
  ): string[] {
    const risks: string[] = [];

    // 根据工具类型添加特定风险和改进建议
    if (tool.name === 'Bash') {
      const command = (params.command as string) || '';

      // 真正危险的 Bash 命令警告
      if (command.includes('rm')) {
        risks.push('[WARN] 此命令可能删除文件');
      }
      if (command.includes('sudo')) {
        risks.push('[WARN] 此命令需要管理员权限');
      }
      if (command.includes('git push')) {
        risks.push('[WARN] 此命令将推送代码到远程仓库');
      }
    } else if (tool.name === 'Write' || tool.name === 'Edit') {
      risks.push('此操作将修改文件内容');
    } else if (tool.name === 'Delete') {
      risks.push('此操作将永久删除文件');
    }

    return risks;
  }
}

/**
 * 实际执行阶段
 * 负责执行工具
 */
export class ExecutionStage implements PipelineStage {
  readonly name = 'execution';

  private static readonly TRANSIENT_ERRORS = ['EBUSY', 'EAGAIN', 'EMFILE', 'ENFILE'];
  private static readonly MAX_TRANSIENT_RETRIES = 2;
  private static readonly RETRY_DELAY_MS = 200;

  async process(execution: ToolExecution): Promise<void> {
    const invocation = execution._internal.invocation;

    if (!invocation) {
      execution.abort('Pre-execution stage failed; cannot run tool');
      return;
    }

    const startTime = Date.now();
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= ExecutionStage.MAX_TRANSIENT_RETRIES; attempt++) {
      try {
        const result = await invocation.execute(
          execution.context.signal ?? new AbortController().signal,
          execution.context.onProgress,
          execution.context
        );

        if (!result.metadata) result.metadata = {};
        result.metadata.duration = Date.now() - startTime;
        if (attempt > 0) result.metadata.retriedAttempts = attempt;

        execution.setResult(result);
        return;
      } catch (error) {
        lastError = error as Error;
        if (
          attempt < ExecutionStage.MAX_TRANSIENT_RETRIES &&
          this.isTransientError(lastError)
        ) {
          logger.debug(
            `[ExecutionStage] Transient error (${lastError.message}), retry ${attempt + 1}/${ExecutionStage.MAX_TRANSIENT_RETRIES}`
          );
          await new Promise((r) =>
            setTimeout(r, ExecutionStage.RETRY_DELAY_MS * (attempt + 1))
          );
          continue;
        }
        break;
      }
    }

    execution.abort(`Tool execution failed: ${lastError!.message}`);
  }

  private isTransientError(error: Error): boolean {
    const msg = error.message;
    return ExecutionStage.TRANSIENT_ERRORS.some((code) => msg.includes(code));
  }
}

/**
 * 结果格式化阶段
 * 负责格式化执行结果
 */
export class FormattingStage implements PipelineStage {
  readonly name = 'formatting';

  async process(execution: ToolExecution): Promise<void> {
    try {
      const result = execution.getResult();

      // 确保结果格式正确
      if (!result.llmContent) {
        result.llmContent = 'Execution completed';
      }

      // 添加执行元数据
      if (!result.metadata) {
        result.metadata = {};
      }

      result.metadata.executionId = execution.context.sessionId;
      result.metadata.toolName = execution.toolName;
      result.metadata.timestamp = Date.now();

      execution.setResult(result);
    } catch (error) {
      execution.abort(`Result formatting failed: ${(error as Error).message}`);
    }
  }
}
