import { z } from 'zod';
import type {
  Tool,
  ToolConfig,
  ToolInvocation,
  ToolResult,
} from '../types/index.js';
import { parseWithZod } from '../validation/errorFormatter.js';
import { zodToFunctionSchema } from '../validation/zodToJson.js';
import { UnifiedToolInvocation } from './ToolInvocation.js';

/**
 * 创建工具的工厂函数
 */
export function createTool<TSchema extends z.ZodSchema>(
  config: ToolConfig<TSchema, z.infer<TSchema>>
): Tool<z.infer<TSchema>> {
  type TParams = z.infer<TSchema>;

  return {
    name: config.name,
    displayName: config.displayName,
    kind: config.kind,
    description: config.description,
    version: config.version || '1.0.0',
    category: config.category,
    tags: config.tags || [],

    /**
     * 获取函数声明 (用于 LLM function calling)
     */
    getFunctionDeclaration() {
      const jsonSchema = zodToFunctionSchema(config.schema);

      // 构建完整的描述
      let fullDescription = config.description.short;

      if (config.description.long) {
        fullDescription += `\n\n${config.description.long}`;
      }

      if (config.description.usageNotes && config.description.usageNotes.length > 0) {
        fullDescription += `\n\n使用说明:\n${config.description.usageNotes.map((note) => `- ${note}`).join('\n')}`;
      }

      if (config.description.important && config.description.important.length > 0) {
        fullDescription += `\n\n重要提示:\n${config.description.important.map((note) => `⚠️ ${note}`).join('\n')}`;
      }

      return {
        name: config.name,
        description: fullDescription,
        parameters: jsonSchema,
      };
    },

    /**
     * 获取工具元信息
     */
    getMetadata() {
      return {
        name: config.name,
        displayName: config.displayName,
        kind: config.kind,
        version: config.version || '1.0.0',
        category: config.category,
        tags: config.tags || [],
        description: config.description,
        schema: zodToFunctionSchema(config.schema),
      };
    },

    /**
     * 构建工具调用
     */
    build(params: TParams): ToolInvocation<TParams> {
      // 使用 Zod 验证参数
      const validatedParams = parseWithZod(config.schema, params);

      return new UnifiedToolInvocation<TParams>(
        config.name,
        validatedParams,
        config.execute
      );
    },

    /**
     * 一键执行
     */
    async execute(params: TParams, signal?: AbortSignal): Promise<ToolResult> {
      const invocation = this.build(params);
      return invocation.execute(signal || new AbortController().signal);
    },
  };
}
