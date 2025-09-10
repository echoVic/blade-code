import type { ToolRegistry } from '../registry/ToolRegistry.js';
import { ToolResolver } from '../registry/ToolResolver.js';
import type { PipelineStage, ToolExecution } from '../types/index.js';

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
    (execution as any).tool = tool;
  }
}

/**
 * 参数验证阶段
 * 负责验证工具参数的正确性
 */
export class ValidationStage implements PipelineStage {
  readonly name = 'validation';

  async process(execution: ToolExecution): Promise<void> {
    const tool = (execution as any).tool;
    if (!tool) {
      execution.abort('工具发现阶段失败，无法进行参数验证');
      return;
    }

    try {
      // 使用工具解析器验证参数
      const validationResult = ToolResolver.validateParameters(
        execution.params,
        tool.parameterSchema
      );

      if (!validationResult.valid) {
        const errorMessages = validationResult.errors
          .map(error => `${error.path}: ${error.message}`)
          .join('; ');

        execution.abort(`参数验证失败: ${errorMessages}`);
        return;
      }

      // 规范化参数
      const normalizedParams = ToolResolver.normalizeParameters(
        execution.params,
        tool.parameterSchema
      );

      // 更新执行参数
      (execution as any).normalizedParams = normalizedParams;
    } catch (error) {
      execution.abort(`参数验证出错: ${(error as Error).message}`);
    }
  }
}

/**
 * 权限检查阶段
 * 负责检查工具执行权限
 */
export class PermissionStage implements PipelineStage {
  readonly name = 'permission';

  async process(execution: ToolExecution): Promise<void> {
    const tool = (execution as any).tool;
    if (!tool) {
      execution.abort('工具发现阶段失败，无法进行权限检查');
      return;
    }

    try {
      // 创建工具调用实例
      const invocation = tool.build(execution.params);

      // 检查受影响的路径
      const affectedPaths = invocation.getAffectedPaths();

      // 基础权限检查（这里可以扩展更复杂的权限逻辑）
      if (affectedPaths.length > 0) {
        // 检查是否有危险路径
        const dangerousPaths = affectedPaths.filter(
          path =>
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
      (execution as any).invocation = invocation;
    } catch (error) {
      execution.abort(`权限检查出错: ${(error as Error).message}`);
    }
  }
}

/**
 * 用户确认阶段
 * 负责请求用户确认（如果需要）
 */
export class ConfirmationStage implements PipelineStage {
  readonly name = 'confirmation';

  async process(execution: ToolExecution): Promise<void> {
    const tool = (execution as any).tool;
    const invocation = (execution as any).invocation;

    if (!tool || !invocation) {
      execution.abort('前置阶段失败，无法进行用户确认');
      return;
    }

    try {
      // 检查是否需要确认
      const confirmationDetails = await invocation.shouldConfirm();

      if (confirmationDetails) {
        // 这里可以实现用户确认逻辑
        // 目前假设自动确认（在实际实现中应该请求用户输入）
        console.warn(`工具 "${tool.name}" 需要用户确认: ${confirmationDetails.title}`);
        console.warn(`详情: ${confirmationDetails.message}`);

        if (confirmationDetails.risks && confirmationDetails.risks.length > 0) {
          console.warn(`风险: ${confirmationDetails.risks.join(', ')}`);
        }

        // 在真实实现中，这里应该暂停执行并等待用户确认
        // 当前为了演示目的，自动通过确认
      }
    } catch (error) {
      execution.abort(`用户确认出错: ${(error as Error).message}`);
    }
  }
}

/**
 * 实际执行阶段
 * 负责执行工具
 */
export class ExecutionStage implements PipelineStage {
  readonly name = 'execution';

  async process(execution: ToolExecution): Promise<void> {
    const invocation = (execution as any).invocation;

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
