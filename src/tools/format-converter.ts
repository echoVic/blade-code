import type { ToolDefinition } from './types.js';

/**
 * OpenAI Tools 格式
 */
export interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: any;
  };
}

/**
 * OpenAI Functions 格式（旧版）
 */
export interface OpenAIFunction {
  name: string;
  description: string;
  parameters: any;
}

/**
 * 工具格式转换器
 * 用于在不同的 function call 格式之间转换
 */
export class ToolFormatConverter {
  /**
   * 将项目内部的 ToolDefinition 转换为 OpenAI Tools 格式
   */
  static toOpenAITools(toolDefinitions: ToolDefinition[]): OpenAITool[] {
    return toolDefinitions.map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: {
          type: 'object',
          properties: tool.parameters,
          required: tool.required || [],
        },
      },
    }));
  }

  /**
   * 将项目内部的 ToolDefinition 转换为 OpenAI Functions 格式（旧版）
   */
  static toOpenAIFunctions(toolDefinitions: ToolDefinition[]): OpenAIFunction[] {
    return toolDefinitions.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: {
        type: 'object',
        properties: tool.parameters,
        required: tool.required || [],
      },
    }));
  }

  /**
   * 将 OpenAI Tools 格式转换为 Functions 格式
   */
  static toolsToFunctions(tools: OpenAITool[]): OpenAIFunction[] {
    return tools.map((tool) => ({
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters,
    }));
  }

  /**
   * 将 OpenAI Functions 格式转换为 Tools 格式
   */
  static functionsToTools(functions: OpenAIFunction[]): OpenAITool[] {
    return functions.map((func) => ({
      type: 'function' as const,
      function: {
        name: func.name,
        description: func.description,
        parameters: func.parameters,
      },
    }));
  }

  /**
   * 自动检测格式并转换为 OpenAI Tools 格式
   */
  static autoConvertToTools(input: any[]): OpenAITool[] {
    if (!input.length) return [];

    const first = input[0];

    // 如果已经是 OpenAI Tools 格式
    if (first.type === 'function' && first.function) {
      return input as OpenAITool[];
    }

    // 如果是 OpenAI Functions 格式
    if (first.name && first.description && first.parameters && !first.type) {
      return this.functionsToTools(input as OpenAIFunction[]);
    }

    // 如果是项目内部的 ToolDefinition 格式
    if (first.name && first.description && first.parameters && first.execute) {
      return this.toOpenAITools(input as ToolDefinition[]);
    }

    // 默认尝试当作 Functions 格式处理
    return this.functionsToTools(input as OpenAIFunction[]);
  }

  /**
   * 自动检测格式并转换为 OpenAI Functions 格式
   */
  static autoConvertToFunctions(input: any[]): OpenAIFunction[] {
    if (!input.length) return [];

    const first = input[0];

    // 如果是 OpenAI Tools 格式
    if (first.type === 'function' && first.function) {
      return this.toolsToFunctions(input as OpenAITool[]);
    }

    // 如果已经是 OpenAI Functions 格式
    if (first.name && first.description && first.parameters && !first.type) {
      return input as OpenAIFunction[];
    }

    // 如果是项目内部的 ToolDefinition 格式
    if (first.name && first.description && first.parameters && first.execute) {
      return this.toOpenAIFunctions(input as ToolDefinition[]);
    }

    // 默认返回原始输入
    return input as OpenAIFunction[];
  }

  /**
   * 验证 Tools 格式是否有效
   */
  static validateToolsFormat(tools: any[]): boolean {
    return tools.every(
      (tool) =>
        tool.type === 'function' &&
        tool.function &&
        typeof tool.function.name === 'string' &&
        typeof tool.function.description === 'string' &&
        tool.function.parameters
    );
  }

  /**
   * 验证 Functions 格式是否有效
   */
  static validateFunctionsFormat(functions: any[]): boolean {
    return functions.every(
      (func) =>
        typeof func.name === 'string' &&
        typeof func.description === 'string' &&
        func.parameters
    );
  }

  /**
   * 为 Qwen 模型优化工具描述
   * Qwen 模型对中文描述更友好
   */
  static optimizeForQwen(tools: OpenAITool[]): OpenAITool[] {
    return tools.map((tool) => ({
      ...tool,
      function: {
        ...tool.function,
        description: this.enhanceDescriptionForQwen(tool.function.description),
      },
    }));
  }

  /**
   * 增强工具描述，使其更适合 Qwen 模型理解
   */
  private static enhanceDescriptionForQwen(description: string): string {
    // 如果描述太短，添加更多上下文
    if (description.length < 20) {
      return `${description}。这是一个实用工具，可以帮助完成相关任务。`;
    }

    // 如果描述是英文，可以考虑添加中文说明
    const hasEnglish = /[a-zA-Z]/.test(description);
    const hasChinese = /[\u4e00-\u9fa5]/.test(description);

    if (hasEnglish && !hasChinese) {
      // 纯英文描述，添加提示
      return `${description} (实用工具)`;
    }

    return description;
  }

  /**
   * 生成工具调用示例
   */
  static generateExample(tool: OpenAITool): string {
    const params = tool.function.parameters;
    const properties = params?.properties || {};
    const required = params?.required || [];

    const exampleParams: any = {};

    // 为必需参数生成示例值
    for (const paramName of required) {
      const paramSchema = properties[paramName];
      if (paramSchema) {
        exampleParams[paramName] = this.generateExampleValue(paramSchema);
      }
    }

    return JSON.stringify(
      {
        name: tool.function.name,
        arguments: exampleParams,
      },
      null,
      2
    );
  }

  /**
   * 根据参数模式生成示例值
   */
  private static generateExampleValue(schema: any): any {
    if (schema.enum && schema.enum.length > 0) {
      return schema.enum[0];
    }

    if (schema.default !== undefined) {
      return schema.default;
    }

    switch (schema.type) {
      case 'string':
        return schema.description ? `示例${schema.description}` : '示例文本';
      case 'number':
      case 'integer':
        return 42;
      case 'boolean':
        return true;
      case 'array':
        return [];
      case 'object':
        return {};
      default:
        return null;
    }
  }
}
