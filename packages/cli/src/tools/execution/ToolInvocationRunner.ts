import { abortableSleep } from '../../utils/abort.js';
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
  const maxRetries = invocation.isRetrySafe ? MAX_TRANSIENT_RETRIES : 0;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await invocation.execute(
        context.signal ?? new AbortController().signal,
        context.onProgress,
        context
      );
      if (!result.success && attempt < maxRetries && isTransientFailure(result.error)) {
        await abortableSleep(RETRY_DELAY_MS * (attempt + 1), context.signal, {
          throwOnAbort: true,
        });
        continue;
      }
      result.metadata ??= {};
      result.metadata.duration = Date.now() - startTime;
      if (attempt > 0) {
        result.metadata.retriedAttempts = attempt;
      }
      return result;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt >= maxRetries || !isTransientFailure(lastError)) {
        break;
      }
      await abortableSleep(RETRY_DELAY_MS * (attempt + 1), context.signal, {
        throwOnAbort: true,
      });
    }
  }

  throw lastError ?? new Error('Tool execution failed');
}

function isTransientFailure(error: unknown): boolean {
  const pending: Array<{ candidate: unknown; depth: number }> = [
    { candidate: error, depth: 0 },
  ];
  const visited = new Set<object>();

  while (pending.length > 0) {
    const { candidate, depth } = pending.shift()!;
    if (!candidate || typeof candidate !== 'object' || visited.has(candidate)) {
      continue;
    }
    visited.add(candidate);

    const failure = candidate as {
      cause?: unknown;
      code?: unknown;
      details?: unknown;
      message?: unknown;
    };
    const code = typeof failure.code === 'string' ? failure.code : undefined;
    const message = typeof failure.message === 'string' ? failure.message : undefined;
    if (
      (code !== undefined && TRANSIENT_ERRORS.includes(code)) ||
      (message !== undefined &&
        TRANSIENT_ERRORS.some((transientCode) => message.includes(transientCode)))
    ) {
      return true;
    }

    if (depth < 4) {
      pending.push(
        { candidate: failure.details, depth: depth + 1 },
        { candidate: failure.cause, depth: depth + 1 }
      );
    }
  }

  return false;
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
