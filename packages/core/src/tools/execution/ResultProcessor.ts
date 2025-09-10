import type { ToolError, ToolErrorType, ToolResult } from '../types/index.js';

/**
 * 结果处理器
 * 负责处理和格式化工具执行结果
 */
export class ResultProcessor {
  /**
   * 格式化成功结果
   */
  static formatSuccess(
    data: unknown,
    displayMessage?: string,
    metadata?: Record<string, unknown>
  ): ToolResult {
    return {
      success: true,
      llmContent: this.formatLlmContent(data),
      displayContent: displayMessage || this.formatDisplayContent(data),
      metadata: {
        timestamp: Date.now(),
        ...metadata,
      },
    };
  }

  /**
   * 格式化错误结果
   */
  static formatError(
    error: Error | string | ToolError,
    errorType?: ToolErrorType,
    metadata?: Record<string, unknown>
  ): ToolResult {
    let toolError: ToolError;

    if (typeof error === 'string') {
      toolError = {
        type: errorType || 'EXECUTION_ERROR',
        message: error,
      };
    } else if (error instanceof Error) {
      toolError = {
        type: errorType || 'EXECUTION_ERROR',
        message: error.message,
        details: {
          stack: error.stack,
          name: error.name,
        },
      };
    } else {
      toolError = error;
    }

    return {
      success: false,
      llmContent: `执行失败: ${toolError.message}`,
      displayContent: `错误: ${toolError.message}`,
      error: toolError,
      metadata: {
        timestamp: Date.now(),
        ...metadata,
      },
    };
  }

  /**
   * 格式化部分成功结果
   */
  static formatPartialSuccess(
    successData: unknown,
    errors: ToolError[],
    metadata?: Record<string, unknown>
  ): ToolResult {
    const errorMessages = errors.map(e => e.message).join('; ');

    return {
      success: true, // 部分成功仍标记为成功
      llmContent: {
        data: this.formatLlmContent(successData),
        warnings: errors,
      },
      displayContent: `部分成功: ${this.formatDisplayContent(successData)}。警告: ${errorMessages}`,
      metadata: {
        timestamp: Date.now(),
        partialSuccess: true,
        errorCount: errors.length,
        ...metadata,
      },
    };
  }

  /**
   * 合并多个结果
   */
  static mergeResults(results: ToolResult[]): ToolResult {
    if (results.length === 0) {
      return this.formatError('没有可合并的结果');
    }

    if (results.length === 1) {
      return results[0];
    }

    const allSuccessful = results.every(r => r.success);
    const successfulResults = results.filter(r => r.success);
    const failedResults = results.filter(r => !r.success);

    const llmContents = results.map(r => r.llmContent);
    const displayContents = results.map(r => r.displayContent);
    const allErrors = failedResults.map(r => r.error).filter(Boolean) as ToolError[];

    const mergedMetadata = results.reduce((acc, result) => {
      return { ...acc, ...result.metadata };
    }, {});

    if (allSuccessful) {
      return {
        success: true,
        llmContent: llmContents.length === 1 ? llmContents[0] : llmContents,
        displayContent: displayContents.join('\n\n'),
        metadata: {
          ...mergedMetadata,
          merged: true,
          totalResults: results.length,
          timestamp: Date.now(),
        },
      };
    }

    if (successfulResults.length > 0) {
      // 部分成功
      return {
        success: true,
        llmContent: {
          successful: successfulResults.map(r => r.llmContent),
          failed: failedResults.map(r => ({
            error: r.error,
            content: r.llmContent,
          })),
        },
        displayContent: [
          `成功: ${successfulResults.length}`,
          `失败: ${failedResults.length}`,
          '',
          '成功结果:',
          ...successfulResults.map(r => r.displayContent),
          '',
          '失败结果:',
          ...failedResults.map(r => r.displayContent),
        ].join('\n'),
        metadata: {
          ...mergedMetadata,
          merged: true,
          totalResults: results.length,
          successfulResults: successfulResults.length,
          failedResults: failedResults.length,
          partialSuccess: true,
          timestamp: Date.now(),
        },
      };
    }

    // 全部失败
    return {
      success: false,
      llmContent: `所有操作失败: ${allErrors.map(e => e.message).join('; ')}`,
      displayContent: `全部失败 (${results.length} 个操作):\n${displayContents.join('\n')}`,
      error: {
        type: 'EXECUTION_ERROR',
        message: `批量操作失败: ${allErrors.length} 个错误`,
        details: allErrors,
      },
      metadata: {
        ...mergedMetadata,
        merged: true,
        totalResults: results.length,
        allFailed: true,
        timestamp: Date.now(),
      },
    };
  }

  /**
   * 添加执行元数据
   */
  static addExecutionMetadata(
    result: ToolResult,
    executionInfo: {
      toolName: string;
      executionId?: string;
      duration?: number;
      retryCount?: number;
    }
  ): ToolResult {
    return {
      ...result,
      metadata: {
        ...result.metadata,
        toolName: executionInfo.toolName,
        executionId: executionInfo.executionId,
        duration: executionInfo.duration,
        retryCount: executionInfo.retryCount,
        timestamp: result.metadata?.timestamp || Date.now(),
      },
    };
  }

  /**
   * 验证结果格式
   */
  static validateResult(result: ToolResult): boolean {
    return (
      typeof result === 'object' &&
      result !== null &&
      typeof result.success === 'boolean' &&
      (typeof result.llmContent === 'string' || typeof result.llmContent === 'object') &&
      typeof result.displayContent === 'string'
    );
  }

  /**
   * 标准化结果
   */
  static normalizeResult(result: ToolResult): ToolResult {
    const normalized: ToolResult = {
      success: Boolean(result.success),
      llmContent: result.llmContent || '',
      displayContent: result.displayContent || '',
      metadata: result.metadata || {},
    };

    if (result.error) {
      normalized.error = result.error;
    }

    if (!normalized.metadata.timestamp) {
      normalized.metadata.timestamp = Date.now();
    }

    return normalized;
  }

  /**
   * 格式化LLM内容
   */
  private static formatLlmContent(data: unknown): string | object {
    if (typeof data === 'string') {
      return data;
    }

    if (typeof data === 'object' && data !== null) {
      return data;
    }

    if (data === null || data === undefined) {
      return '';
    }

    return String(data);
  }

  /**
   * 格式化显示内容
   */
  private static formatDisplayContent(data: unknown): string {
    if (typeof data === 'string') {
      return data;
    }

    if (typeof data === 'object' && data !== null) {
      try {
        return JSON.stringify(data, null, 2);
      } catch {
        return String(data);
      }
    }

    if (data === null || data === undefined) {
      return '无内容';
    }

    return String(data);
  }
}
