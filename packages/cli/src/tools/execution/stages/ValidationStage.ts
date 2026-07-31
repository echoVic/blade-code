import type { PipelineStage, ToolExecution } from '../../types/index.js';

/**
 * 验证阶段
 *
 * 职责:
 * 1. 工具黑白名单检查 (--disallowed-tools / --allowed-tools)
 * 2. Zod 参数验证 (通过 tool.build() 完成,含默认值处理)
 *
 * 不做权限决策。工具发现 (DiscoveryStage) 已把 tool 放入 _internal。
 */
export class ValidationStage implements PipelineStage {
  readonly name = 'validation';

  private readonly toolWhitelist: ReadonlySet<string> | null;
  private readonly toolBlacklist: ReadonlySet<string> | null;

  constructor(toolWhitelist?: readonly string[], toolBlacklist?: readonly string[]) {
    this.toolWhitelist = toolWhitelist?.length ? new Set(toolWhitelist) : null;
    this.toolBlacklist = toolBlacklist?.length ? new Set(toolBlacklist) : null;
  }

  async process(execution: ToolExecution): Promise<void> {
    const tool = execution._internal.tool;
    if (!tool) {
      execution.abort('Discovery stage failed; cannot perform validation');
      return;
    }

    if (this.toolBlacklist?.has(tool.name)) {
      execution.abort(`Tool "${tool.name}" is blocked by --disallowed-tools`);
      return;
    }
    if (this.toolWhitelist && !this.toolWhitelist.has(tool.name)) {
      execution.abort(`Tool "${tool.name}" is not in --allowed-tools whitelist`);
      return;
    }

    try {
      // Zod 验证 (含默认值处理); 保存 invocation 供后续阶段使用
      const invocation = tool.build(execution.params);
      execution._internal.invocation = invocation;
    } catch (error) {
      execution.abort(`Parameter validation failed: ${(error as Error).message}`);
    }
  }
}
