import { z } from 'zod';
import type {
  ExecutionContext,
  Tool,
  ToolConfig,
  ToolInvocation,
  ToolResult,
} from '../types/index.js';
import { isReadOnlyKind } from '../types/ToolTypes.js';
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

    // isReadOnly 字段
    // 优先使用 config 中的显式设置，否则根据 kind 推断
    isReadOnly: config.isReadOnly ?? isReadOnlyKind(config.kind),

    // isConcurrencySafe 字段
    // 优先使用 config 中的显式设置，否则默认 false
    // 仅控制 ToolExecutor 中的文件锁语义，与流式预启动 allowlist 无关
    isConcurrencySafe: config.isConcurrencySafe ?? false,

    // strict 字段（OpenAI Structured Outputs）
    // 优先使用 config 中的显式设置，否则默认 false
    strict: config.strict ?? false,

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
        fullDescription += `\n\nUsage Notes:\n${config.description.usageNotes.map((note) => `- ${note}`).join('\n')}`;
      }

      if (config.description.important && config.description.important.length > 0) {
        fullDescription += `\n\nImportant:\n${config.description.important.map((note) => `[WARN] ${note}`).join('\n')}`;
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
    async execute(
      params: TParams,
      signal?: AbortSignal,
      context?: Partial<ExecutionContext>
    ): Promise<ToolResult> {
      const invocation = this.build(params);
      return invocation.execute(
        signal || new AbortController().signal,
        undefined,
        context
      );
    },

    /**
     * [OK] 签名内容提取器（从 config 传递或提供默认实现）
     */
    extractSignatureContent: config.extractSignatureContent
      ? (params: TParams) => config.extractSignatureContent!(params)
      : undefined,

    /**
     * [OK] 权限规则抽象器（从 config 传递或提供默认实现）
     */
    abstractPermissionRule: config.abstractPermissionRule
      ? (params: TParams) => config.abstractPermissionRule!(params)
      : undefined,
  };
}
