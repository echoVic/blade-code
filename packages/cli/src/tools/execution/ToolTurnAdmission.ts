import { ToolErrorType, type ToolResult } from '../types/index.js';

export const TOOL_TURN_MAX_CALLS = 64;

export function createToolBatchFullResult(): ToolResult {
  return {
    success: false,
    llmContent:
      'This response contains too many tool calls. Retry the remaining work in a later turn.',
    error: {
      type: ToolErrorType.RESOURCE_EXHAUSTED,
      code: 'tool_batch_full',
      message: `Tool-call batch exceeds the per-turn limit of ${TOOL_TURN_MAX_CALLS}`,
    },
    metadata: {
      summary: 'Tool-call batch limit reached',
      tool_admission: {
        code: 'tool_batch_full',
        reason: 'turn_limit',
        scope: 'session',
        retryable: true,
        limit: TOOL_TURN_MAX_CALLS,
      },
    },
  };
}

export class ToolTurnAdmission {
  private admitted = 0;

  admit(): ToolResult | undefined {
    if (this.admitted >= TOOL_TURN_MAX_CALLS) {
      return createToolBatchFullResult();
    }
    this.admitted++;
    return undefined;
  }

  reset(): void {
    this.admitted = 0;
  }

  get count(): number {
    return this.admitted;
  }
}
