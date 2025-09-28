import type { 
  ToolKind, 
  ToolInvocation, 
  ToolResult, 
  JSONSchema7, 
  FunctionDeclaration 
} from '../types/index.js';

/**
 * 工具基础抽象类
 */
export abstract class BaseTool<TParams = any, TResult = ToolResult> {
  constructor(
    public readonly name: string,
    public readonly displayName: string,
    public readonly description: string,
    public readonly kind: ToolKind,
    public readonly parameterSchema: JSONSchema7,
    public readonly requiresConfirmation: boolean = false,
    public readonly version: string = '1.0.0',
    public readonly category?: string,
    public readonly tags: string[] = []
  ) {
    this.validateSchema();
  }

  /**
   * 工具模式定义（用于LLM函数调用）
   */
  get functionDeclaration(): FunctionDeclaration {
    return {
      name: this.name,
      description: this.description,
      parameters: this.parameterSchema
    };
  }

  /**
   * 验证参数模式
   */
  private validateSchema(): void {
    if (!this.parameterSchema.type) {
      this.parameterSchema.type = 'object';
    }
    
    if (!this.parameterSchema.properties) {
      this.parameterSchema.properties = {};
    }
  }

  /**
   * 验证参数
   */
  protected validateParameters(params: TParams): void {
    // 基础验证逻辑
    if (this.parameterSchema.required) {
      for (const field of this.parameterSchema.required) {
        if (!(field in (params as any))) {
          throw new Error(`缺少必需参数: ${field}`);
        }
      }
    }
  }

  /**
   * 构建工具调用
   */
  abstract build(params: TParams): ToolInvocation<TParams, TResult>;

  /**
   * 一键执行（内部调用build+execute）
   */
  async execute(params: TParams, signal?: AbortSignal): Promise<TResult> {
    const invocation = this.build(params);
    return invocation.execute(signal || new AbortController().signal);
  }

  /**
   * 获取工具元信息
   */
  getMetadata(): Record<string, any> {
    return {
      name: this.name,
      displayName: this.displayName,
      description: this.description,
      kind: this.kind,
      version: this.version,
      category: this.category,
      tags: this.tags,
      requiresConfirmation: this.requiresConfirmation,
      parameterSchema: this.parameterSchema
    };
  }

  /**
   * 获取使用示例
   */
  getExamples(): Array<{ description: string; params: TParams }> {
    return [];
  }
}