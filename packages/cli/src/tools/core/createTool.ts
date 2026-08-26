import type { Static, TSchema } from '../../schema/index.js';
import type {
  ExecutionContext,
  Tool,
  ToolConfig,
  ToolInvocation,
  ToolResult,
} from '../types/index.js';
import { parseToolSchema } from '../validation/schemaErrorFormatter.js';
import { schemaToFunctionSchema } from '../validation/schemaToJson.js';
import { UnifiedToolInvocation } from './ToolInvocation.js';

/**
 * 创建工具的工厂函数
 */
export function createTool<T extends TSchema>(
  config: ToolConfig<T, Static<T>>
): Tool<Static<T>> {
  type TParams = Static<T>;

  return {
    name: config.name,
    displayName: config.displayName,
    kind: config.kind,

    // isConcurrencySafe 字段
    // 优先使用 config 中的显式设置，否则默认 false
    // 控制同路径文件锁和流式预启动；批内 gate 由 parallelism 独立控制
    isConcurrencySafe: config.isConcurrencySafe ?? false,

    // 只有显式声明的幂等调用才能在未知完成状态下重放
    isRetrySafe: config.isRetrySafe ?? false,

    parallelism:
      config.parallelism ?? (config.isConcurrencySafe ? 'shared' : 'exclusive'),

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
      const jsonSchema = schemaToFunctionSchema(config.schema);

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
        isRetrySafe: config.isRetrySafe ?? false,
        parallelism:
          config.parallelism ?? (config.isConcurrencySafe ? 'shared' : 'exclusive'),
        description: config.description,
        schema: schemaToFunctionSchema(config.schema),
      };
    },

    /**
     * 构建工具调用
     */
    build(params: TParams): ToolInvocation<TParams> {
      const validatedParams = parseToolSchema(config.schema, params);

      return new UnifiedToolInvocation<TParams>(
        config.name,
        validatedParams,
        config.execute,
        undefined,
        config.affectedPaths,
        config.isRetrySafe ?? false
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
