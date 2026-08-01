import type { ExecutionContext, ToolInvocation, ToolResult } from '../types/index.js';

const TRANSIENT_ERRORS = ['EBUSY', 'EAGAIN', 'EMFILE', 'ENFILE'];
const MAX_TRANSIENT_RETRIES = 2;
const RETRY_DELAY_MS = 200;

export async function executeToolInvocation(
  invocation: ToolInvocation<unknown>,
  context: ExecutionContext
): Promise<ToolResult> {
  const startTime = Date.now();
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= MAX_TRANSIENT_RETRIES; attempt++) {
    try {
      const result = await invocation.execute(
        context.signal ?? new AbortController().signal,
        context.onProgress,
        context
      );
      result.metadata ??= {};
      result.metadata.duration = Date.now() - startTime;
      if (attempt > 0) {
        result.metadata.retriedAttempts = attempt;
      }
      return result;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (
        attempt >= MAX_TRANSIENT_RETRIES ||
        !TRANSIENT_ERRORS.some((code) => lastError?.message.includes(code))
      ) {
        break;
      }
      await delay(RETRY_DELAY_MS * (attempt + 1));
    }
  }

  throw lastError ?? new Error('Tool execution failed');
}

export function formatToolResult(
  result: ToolResult,
  executionId: string,
  toolName: string
): ToolResult {
  if (!result.llmContent) {
    result.llmContent = 'Execution completed';
  }
  result.metadata ??= {};
  result.metadata.executionId = executionId;
  result.metadata.toolName = toolName;
  result.metadata.timestamp = Date.now();
  return result;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
