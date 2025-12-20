import {
  PermissionChecker,
  type PermissionCheckResult,
  PermissionResult,
  type ToolInvocationDescriptor,
} from '../../config/PermissionChecker.js';
import type { PermissionConfig } from '../../config/types.js';
import { PermissionMode } from '../../config/types.js';
import { createLogger, LogCategory } from '../../logging/Logger.js';
import { configActions, getConfig } from '../../store/vanilla.js';
import type { ToolRegistry } from '../registry/ToolRegistry.js';
import type { PipelineStage, ToolExecution } from '../types/index.js';
import { isReadOnlyKind, ToolKind } from '../types/index.js';
import {
  SensitiveFileDetector,
  SensitivityLevel,
} from '../validation/SensitiveFileDetector.js';

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
 * 权限检查阶段
 * 负责检查工具执行权限并进行 Zod 参数验证
 *
 * 注意：参数验证(包括默认值处理)由 tool.build() 中的 Zod schema 完成
 */
export class PermissionStage implements PipelineStage {
  readonly name = 'permission';
  private permissionChecker: PermissionChecker;
  private readonly sessionApprovals: Set<string>;
  // 🔧 重命名为 defaultPermissionMode，作为回退值
  // 实际权限检查时优先使用 execution.context.permissionMode（动态值）
  private readonly defaultPermissionMode: PermissionMode;

  constructor(
    permissionConfig: PermissionConfig,
    sessionApprovals: Set<string>,
    permissionMode: PermissionMode
  ) {
    this.permissionChecker = new PermissionChecker(permissionConfig);
    this.sessionApprovals = sessionApprovals;
    this.defaultPermissionMode = permissionMode;
  }

  /**
   * 获取 PermissionChecker 实例（供 ConfirmationStage 使用）
   */
  getPermissionChecker(): PermissionChecker {
    return this.permissionChecker;
  }

  async process(execution: ToolExecution): Promise<void> {
    const tool = execution._internal.tool;
    if (!tool) {
      execution.abort('Discovery stage failed; cannot perform permission check');
      return;
    }

    try {
      // 创建工具调用实例
      const invocation = tool.build(execution.params);

      // 检查受影响的路径
      const affectedPaths = invocation.getAffectedPaths();

      // 构建工具调用描述符（包含工具实例用于权限系统）
      const descriptor: ToolInvocationDescriptor = {
        toolName: tool.name,
        params: execution.params,
        affectedPaths,
        tool, // 传递工具实例，用于 extractSignatureContent 和 abstractPermissionRule
      };
      const signature = PermissionChecker.buildSignature(descriptor);
      execution._internal.permissionSignature = signature;

      // 使用 PermissionChecker 进行权限检查
      let checkResult = this.permissionChecker.check(descriptor);
      // 从 execution.context 动态读取 permissionMode（现在是强类型 PermissionMode）
      // 这样 Shift+Tab 切换模式或 approve 后切换模式都能正确生效
      const currentPermissionMode =
        execution.context.permissionMode || this.defaultPermissionMode;
      checkResult = this.applyModeOverrides(tool.kind, checkResult, currentPermissionMode);

      // 根据检查结果采取行动
      switch (checkResult.result) {
        case PermissionResult.DENY:
          execution.abort(
            checkResult.reason ||
              `Tool invocation "${tool.name}" was denied by permission rules: ${checkResult.matchedRule}`
          );
          return;

        case PermissionResult.ASK:
          if (this.sessionApprovals.has(signature)) {
            checkResult = {
              result: PermissionResult.ALLOW,
              matchedRule: 'remembered:session',
              reason: 'User already allowed this operation in this session',
            };
          } else {
            // 标记需要用户确认
            execution._internal.needsConfirmation = true;
            execution._internal.confirmationReason =
              checkResult.reason || 'User confirmation required';
          }
          break;

        case PermissionResult.ALLOW:
          // 允许执行，继续
          break;
      }

      // 额外的安全检查: 检查危险路径和敏感文件
      if (affectedPaths.length > 0) {
        // 1. 检查危险系统路径
        const dangerousSystemPaths = [
          '/etc/',
          '/sys/',
          '/proc/',
          '/dev/',
          '/boot/',
          '/root/',
          'C:\\Windows\\System32',
          'C:\\Program Files',
          'C:\\ProgramData',
        ];

        const dangerousPaths = affectedPaths.filter((filePath: string) => {
          // 路径遍历攻击
          if (filePath.includes('..')) {
            return true;
          }

          // 危险系统目录（不再拒绝所有 / 开头的路径）
          return dangerousSystemPaths.some((dangerous) => filePath.includes(dangerous));
        });

        if (dangerousPaths.length > 0) {
          execution.abort(`Access to dangerous system paths denied: ${dangerousPaths.join(', ')}`);
          return;
        }

        // 2. 检查敏感文件
        const sensitiveFiles = SensitiveFileDetector.filterSensitive(
          affectedPaths,
          SensitivityLevel.MEDIUM // 默认检测中度及以上敏感文件
        );

        if (sensitiveFiles.length > 0) {
          // 构建敏感文件警告信息
          const warnings = sensitiveFiles.map(
            ({ path: filePath, result }) =>
              `${filePath} (${result.level}: ${result.reason})`
          );

          // 高度敏感文件直接拒绝（除非有明确的 allow 规则）
          const highSensitiveFiles = sensitiveFiles.filter(
            ({ result }) => result.level === SensitivityLevel.HIGH
          );

          if (
            highSensitiveFiles.length > 0 &&
            checkResult.result !== PermissionResult.ALLOW
          ) {
            execution.abort(
              `Access to highly sensitive files denied:\n${warnings.join('\n')}\n\nIf access is required, add an explicit allow rule in permissions.`
            );
            return;
          }

          // 中度敏感文件：需要用户确认（通过修改 checkResult）
          if (
            checkResult.result === PermissionResult.ALLOW &&
            sensitiveFiles.length > 0
          ) {
            // 即使被 allow 规则允许，也需要特别提示
            execution._internal.confirmationReason = `Sensitive file access detected:\n${warnings.join('\n')}\n\nConfirm to proceed?`;
            execution._internal.needsConfirmation = true;
          }
        }
      }

      // 将调用实例附加到执行上下文
      execution._internal.invocation = invocation;
      execution._internal.permissionCheckResult = checkResult;
    } catch (error) {
      execution.abort(`Permission check failed: ${(error as Error).message}`);
    }
  }

  /**
   * 应用权限模式覆盖规则
   *
   * 权限模式行为：
   * - DEFAULT: ReadOnly 工具（Read/Glob/Grep/WebFetch/WebSearch/BashOutput/TodoWrite/Plan）自动批准，其他需要确认
   * - AUTO_EDIT: ReadOnly + Write 工具自动批准，其他需要确认
   * - YOLO: 所有工具自动批准
   * - PLAN: 仅 ReadOnly 工具允许，其他全部拒绝
   *
   * ReadOnly 工具（包括 TodoWrite）在所有模式下都自动批准，因为它们：
   * - 无副作用（仅读取或操作内存状态）
   * - 不直接修改文件系统
   * - 用户可见且安全
   *
   * 优先级：YOLO 模式 > PLAN 模式 > DENY 规则 > ALLOW 规则 > 模式规则 > ASK
   *
   * @param permissionMode - 当前权限模式（从 execution.context 动态读取）
   */
  private applyModeOverrides(
    toolKind: ToolKind,
    checkResult: PermissionCheckResult,
    permissionMode: PermissionMode
  ): PermissionCheckResult {
    // 1. YOLO 模式：完全放开，批准所有工具（最高优先级）
    if (permissionMode === PermissionMode.YOLO) {
      return {
        result: PermissionResult.ALLOW,
        matchedRule: 'mode:yolo',
        reason: 'YOLO mode: automatically approve all tool invocations',
      };
    }

    // 2. PLAN 模式：严格拒绝非只读工具
    if (permissionMode === PermissionMode.PLAN) {
      if (!isReadOnlyKind(toolKind)) {
        return {
          result: PermissionResult.DENY,
          matchedRule: 'mode:plan',
          reason: 'Plan mode: modification tools are blocked; only read-only tools are allowed (Read/Glob/Grep/WebFetch/WebSearch/Task)',
        };
      }
    }

    // 3. 如果已被 deny 规则拒绝，不覆盖
    if (checkResult.result === PermissionResult.DENY) {
      return checkResult;
    }

    // 4. 如果已被 allow 规则批准，不覆盖
    if (checkResult.result === PermissionResult.ALLOW) {
      return checkResult;
    }

    // 5. 只读工具：所有模式下都自动批准
    if (isReadOnlyKind(toolKind)) {
      return {
        result: PermissionResult.ALLOW,
        matchedRule: `mode:${permissionMode}:readonly`,
        reason: 'Read-only tools do not require confirmation',
      };
    }

    // 6. AUTO_EDIT 模式：额外批准 Write 工具
    if (
      permissionMode === PermissionMode.AUTO_EDIT &&
      toolKind === ToolKind.Write
    ) {
      return {
        result: PermissionResult.ALLOW,
        matchedRule: 'mode:autoEdit:write',
        reason: 'AUTO_EDIT mode: automatically approve write tools',
      };
    }

    // 7. 其他情况：保持原检查结果（通常是 ASK）
    return checkResult;
  }
}

/**
 * 用户确认阶段
 * 负责请求用户确认（如果需要）
 *
 * 确认触发条件:
 * - PermissionStage 标记 needsConfirmation = true (权限规则要求)
 */
export class ConfirmationStage implements PipelineStage {
  readonly name = 'confirmation';
  private permissionChecker: PermissionChecker;

  constructor(
    private readonly sessionApprovals: Set<string>,
    permissionChecker: PermissionChecker
  ) {
    this.permissionChecker = permissionChecker;
  }

  async process(execution: ToolExecution): Promise<void> {
    const {
      tool,
      invocation,
      needsConfirmation,
      confirmationReason,
      permissionCheckResult,
    } = execution._internal;

    if (!tool || !invocation) {
      execution.abort('Pre-confirmation stage failed; cannot request user approval');
      return;
    }

    // 如果权限系统不要求确认，直接通过
    if (!needsConfirmation) {
      return;
    }

    try {
      // 使用工具的 extractSignatureContent 生成具体的签名（如果有）
      const signature = tool.extractSignatureContent
        ? tool.extractSignatureContent(execution.params)
        : tool.name;

      // 从权限检查结果构建确认详情
      const confirmationDetails = {
        title: `权限确认: ${signature}`,
        message: confirmationReason || '此操作需要用户确认',
        details: this.generatePreviewForTool(tool.name, execution.params),
        risks: this.extractRisksFromPermissionCheck(
          tool,
          execution.params,
          permissionCheckResult
        ),
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
        const response =
          await confirmationHandler.requestConfirmation(confirmationDetails);

        if (!response.approved) {
          execution.abort(
            `User rejected execution: ${response.reason || 'No reason provided'}`,
            { shouldExitLoop: true }
          );
          return;
        }

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
        // 如果没有提供 confirmationHandler,则自动通过确认（用于非交互式环境）
        logger.warn('⚠️ No ConfirmationHandler; auto-approving tool execution (non-interactive environment only)');
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
    params: Record<string, unknown>,
    permissionCheckResult?: { reason?: string }
  ): string[] {
    const risks: string[] = [];

    // 添加权限检查的原因作为风险
    if (permissionCheckResult?.reason) {
      risks.push(permissionCheckResult.reason);
    }

    // 根据工具类型添加特定风险和改进建议
    if (tool.name === 'Bash') {
      const command = (params.command as string) || '';
      const mainCommand = command.trim().split(/\s+/)[0];

      // ⚠️ 检测使用了专用工具应该替代的命令
      if (mainCommand === 'cat' || mainCommand === 'head' || mainCommand === 'tail') {
        risks.push(
          `💡 建议使用 Read 工具代替 ${mainCommand} 命令（性能更好，支持大文件分页）`
        );
      } else if (mainCommand === 'grep' || mainCommand === 'rg') {
        risks.push(
          '💡 建议使用 Grep 工具代替 grep/rg 命令（支持更强大的过滤和上下文）'
        );
      } else if (mainCommand === 'find') {
        risks.push('💡 建议使用 Glob 工具代替 find 命令（更快，支持 glob 模式）');
      } else if (mainCommand === 'sed' || mainCommand === 'awk') {
        risks.push(
          `💡 建议使用 Edit 工具代替 ${mainCommand} 命令（更安全，支持预览和回滚）`
        );
      }

      // ⚠️ 危险命令警告
      if (command.includes('rm')) {
        risks.push('⚠️ 此命令可能删除文件');
      }
      if (command.includes('sudo')) {
        risks.push('⚠️ 此命令需要管理员权限');
      }
      if (command.includes('git push')) {
        risks.push('⚠️ 此命令将推送代码到远程仓库');
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

  async process(execution: ToolExecution): Promise<void> {
    const invocation = execution._internal.invocation;

    if (!invocation) {
      execution.abort('Pre-execution stage failed; cannot run tool');
      return;
    }

    try {
      // 执行工具，传递完整的执行上下文
      const result = await invocation.execute(
        execution.context.signal,
        execution.context.onProgress,
        execution.context // 传递完整 context（包含 confirmationHandler、permissionMode 等）
      );

      execution.setResult(result);
    } catch (error) {
      execution.abort(`Tool execution failed: ${(error as Error).message}`);
    }
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

      if (!result.displayContent) {
        result.displayContent = result.success ? '执行成功' : '执行失败';
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
