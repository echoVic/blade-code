import type { ToolResult } from './ToolTypes.js';
import { ToolErrorType } from './ToolTypes.js';

/**
 * 执行上下文
 */
export interface ExecutionContext {
  userId?: string;
  sessionId?: string;
  workspaceRoot?: string;
  signal: AbortSignal;
  onProgress?: (message: string) => void;
  updateOutput?: (output: string) => void; // 别名，与 onProgress 功能相同
}

/**
 * 工具执行状态
 */
export class ToolExecution {
  private aborted = false;
  private result?: ToolResult;

  constructor(
    public readonly toolName: string,
    public readonly params: any,
    public readonly context: ExecutionContext
  ) {}

  shouldAbort(): boolean {
    return this.aborted || this.context.signal.aborted;
  }

  abort(reason?: string): void {
    this.aborted = true;
    this.result = {
      success: false,
      llmContent: `Tool execution aborted: ${reason || 'Unknown reason'}`,
      displayContent: `执行已中止: ${reason || '未知原因'}`,
      error: {
        type: ToolErrorType.EXECUTION_ERROR,
        message: reason || 'Execution aborted',
      },
    };
  }

  setResult(result: ToolResult): void {
    this.result = result;
  }

  getResult(): ToolResult {
    if (!this.result) {
      throw new Error('Tool execution result not set');
    }
    return this.result;
  }
}

/**
 * 管道阶段接口
 */
export interface PipelineStage {
  readonly name: string;
  process(execution: ToolExecution): Promise<void>;
}

/**
 * 执行历史记录
 */
export interface ExecutionHistoryEntry {
  executionId: string;
  toolName: string;
  params: any;
  result: ToolResult;
  startTime: number;
  endTime: number;
  context: ExecutionContext;
}

/**
 * 并发管理配置
 */
export interface ConcurrencyConfig {
  maxConcurrent: number;
  timeoutMs: number;
  retryAttempts: number;
  retryDelayMs: number;
}
