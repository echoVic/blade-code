import { ConfigManager } from '../../config/ConfigManager.js';
import { PatternAbstractor } from '../../config/PatternAbstractor.js';
import {
  PermissionChecker,
  PermissionResult,
  type PermissionCheckResult,
  type ToolInvocationDescriptor,
} from '../../config/PermissionChecker.js';
import type { PermissionConfig } from '../../config/types.js';
import { PermissionMode } from '../../config/types.js';
import type { ToolRegistry } from '../registry/ToolRegistry.js';
import type { PipelineStage, ToolExecution } from '../types/index.js';
import { ToolKind } from '../types/index.js';

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
      execution.abort(`工具 "${execution.toolName}" 未找到`);
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
  private readonly permissionMode: PermissionMode;

  constructor(
    permissionConfig: PermissionConfig,
    sessionApprovals: Set<string>,
    permissionMode: PermissionMode
  ) {
    this.permissionChecker = new PermissionChecker(permissionConfig);
    this.sessionApprovals = sessionApprovals;
    this.permissionMode = permissionMode;
  }

  async process(execution: ToolExecution): Promise<void> {
    const tool = execution._internal.tool;
    if (!tool) {
      execution.abort('工具发现阶段失败，无法进行权限检查');
      return;
    }

    try {
      // 创建工具调用实例
      const invocation = tool.build(execution.params);

      // 检查受影响的路径
      const affectedPaths = invocation.getAffectedPaths();

      // 构建工具调用描述符
      const descriptor: ToolInvocationDescriptor = {
        toolName: tool.name,
        params: execution.params,
        affectedPaths,
      };
      const signature = PermissionChecker.buildSignature(descriptor);
      execution._internal.permissionSignature = signature;

      // 使用 PermissionChecker 进行权限检查
      let checkResult = this.permissionChecker.check(descriptor);
      checkResult = this.applyModeOverrides(tool.kind, checkResult);

      // 根据检查结果采取行动
      switch (checkResult.result) {
        case PermissionResult.DENY:
          execution.abort(
            checkResult.reason ||
              `工具调用 "${tool.name}" 被权限规则拒绝: ${checkResult.matchedRule}`
          );
          return;

        case PermissionResult.ASK:
          if (this.sessionApprovals.has(signature)) {
            checkResult = {
              result: PermissionResult.ALLOW,
              matchedRule: 'remembered:session',
              reason: '用户已在本项目会话中允许此操作',
            };
          } else {
            // 标记需要用户确认
            execution._internal.needsConfirmation = true;
            execution._internal.confirmationReason =
              checkResult.reason || '需要用户确认';
          }
          break;

        case PermissionResult.ALLOW:
          // 允许执行，继续
          break;
      }

      // 额外的安全检查: 检查是否有危险路径
      if (affectedPaths.length > 0) {
        const dangerousPaths = affectedPaths.filter(
          (path: string) =>
            path.includes('..') ||
            path.startsWith('/') ||
            path.includes('system32') ||
            path.includes('/etc/')
        );

        if (dangerousPaths.length > 0) {
          execution.abort(`访问危险路径被拒绝: ${dangerousPaths.join(', ')}`);
          return;
        }
      }

      // 将调用实例附加到执行上下文
      execution._internal.invocation = invocation;
      execution._internal.permissionCheckResult = checkResult;
    } catch (error) {
      execution.abort(`权限检查出错: ${(error as Error).message}`);
    }
  }

  /**
   * 应用权限模式覆盖规则
   *
   * 权限模式行为：
   * - DEFAULT: Read/Search 自动批准，其他需要确认
   * - AUTO_EDIT: Read/Search/Edit 自动批准，其他需要确认
   * - YOLO: 所有工具自动批准
   *
   * 优先级：DENY 规则 > ALLOW 规则 > 模式规则 > ASK
   */
  private applyModeOverrides(
    toolKind: ToolKind,
    checkResult: PermissionCheckResult
  ): PermissionCheckResult {
    // 1. 如果已被 deny 规则拒绝，不覆盖（最高优先级）
    if (checkResult.result === PermissionResult.DENY) {
      return checkResult;
    }

    // 2. 如果已被 allow 规则批准，不覆盖
    if (checkResult.result === PermissionResult.ALLOW) {
      return checkResult;
    }

    // 3. YOLO 模式：批准所有工具（在检查规则之后）
    if (this.permissionMode === PermissionMode.YOLO) {
      return {
        result: PermissionResult.ALLOW,
        matchedRule: 'mode:yolo',
        reason: 'YOLO 模式: 自动批准所有工具调用',
      };
    }

    // 4. Read/Search 工具：所有模式下都自动批准（只读操作，安全）
    if (toolKind === ToolKind.Read || toolKind === ToolKind.Search) {
      return {
        result: PermissionResult.ALLOW,
        matchedRule: `mode:${this.permissionMode}:readonly`,
        reason: '只读工具无需确认',
      };
    }

    // 5. AUTO_EDIT 模式：额外批准 Edit 工具
    if (this.permissionMode === PermissionMode.AUTO_EDIT && toolKind === ToolKind.Edit) {
      return {
        result: PermissionResult.ALLOW,
        matchedRule: 'mode:autoEdit:edit',
        reason: 'AUTO_EDIT 模式: 自动批准编辑类工具',
      };
    }

    // 6. 其他情况：保持原检查结果（通常是 ASK）
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
  constructor(private readonly sessionApprovals: Set<string>) {}

  async process(execution: ToolExecution): Promise<void> {
    const {
      tool,
      invocation,
      needsConfirmation,
      confirmationReason,
      permissionCheckResult,
    } = execution._internal;

    if (!tool || !invocation) {
      execution.abort('前置阶段失败，无法进行用户确认');
      return;
    }

    // 如果权限系统不要求确认，直接通过
    if (!needsConfirmation) {
      return;
    }

    try {
      // 从权限检查结果构建确认详情
      const confirmationDetails = {
        title: `权限确认: ${tool.name}`,
        message: confirmationReason || '此操作需要用户确认',
        risks: this.extractRisksFromPermissionCheck(
          tool,
          execution.params,
          permissionCheckResult
        ),
        affectedFiles: invocation.getAffectedPaths() || [],
      };

      console.warn(`工具 "${tool.name}" 需要用户确认: ${confirmationDetails.title}`);
      console.warn(`详情: ${confirmationDetails.message}`);

      if (confirmationDetails.risks && confirmationDetails.risks.length > 0) {
        console.warn(`风险: ${confirmationDetails.risks.join(', ')}`);
      }

      // 如果提供了 confirmationHandler,使用它来请求用户确认
      const confirmationHandler = execution.context.confirmationHandler;
      if (confirmationHandler) {
        const response =
          await confirmationHandler.requestConfirmation(confirmationDetails);

        if (!response.approved) {
          execution.abort(`用户拒绝执行: ${response.reason || '无原因'}`);
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
          };

          await this.persistSessionApproval(signature, descriptor);
        }
      } else {
        // 如果没有提供 confirmationHandler,则自动通过确认（用于非交互式环境）
        console.warn(
          '⚠️ 无 ConfirmationHandler,自动批准工具执行（仅用于非交互式环境）'
        );
      }
    } catch (error) {
      execution.abort(`用户确认出错: ${(error as Error).message}`);
    }
  }

  private async persistSessionApproval(
    signature: string,
    descriptor: ToolInvocationDescriptor
  ): Promise<void> {
    try {
      const configManager = ConfigManager.getInstance();

      // 使用 PatternAbstractor 生成模式规则（而非精确签名）
      const pattern = PatternAbstractor.abstract(descriptor);

      await configManager.appendLocalPermissionAllowRule(pattern);
    } catch (error) {
      console.warn(
        `[ConfirmationStage] 无法保存权限规则 "${signature}": ${
          error instanceof Error ? error.message : '未知错误'
        }`
      );
    }
  }

  /**
   * 从权限检查结果提取风险信息
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

    // 根据工具类型添加特定风险
    if (tool.name === 'Bash') {
      const command = (params.command as string) || '';
      if (command.includes('rm')) {
        risks.push('此命令可能删除文件');
      }
      if (command.includes('sudo')) {
        risks.push('此命令需要管理员权限');
      }
      if (command.includes('git push')) {
        risks.push('此命令将推送代码到远程仓库');
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
      execution.abort('前置阶段失败，无法执行工具');
      return;
    }

    try {
      // 执行工具
      const result = await invocation.execute(
        execution.context.signal,
        execution.context.onProgress
      );

      execution.setResult(result);
    } catch (error) {
      execution.abort(`工具执行失败: ${(error as Error).message}`);
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
        result.llmContent = result.displayContent || '执行完成';
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
      execution.abort(`结果格式化出错: ${(error as Error).message}`);
    }
  }
}
