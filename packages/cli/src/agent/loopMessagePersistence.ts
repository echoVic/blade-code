import { createLogger, LogCategory } from '../logging/Logger.js';
import type { LoopMessageExecutionEngine } from './loopRuntimeTypes.js';
import type { ChatContext } from './types.js';

const logger = createLogger(LogCategory.AGENT);

export async function persistLoopMessage({
  context,
  role,
  content,
  previousId,
  executionEngine,
  emptyLogMessage,
  failureLogMessage,
}: {
  context: ChatContext;
  role: 'user' | 'assistant';
  content?: string;
  previousId: string | null;
  executionEngine?: LoopMessageExecutionEngine;
  emptyLogMessage: string;
  failureLogMessage: string;
}): Promise<string | null> {
  let nextMessageUuid = previousId;

  try {
    const contextManager = executionEngine?.getContextManager();
    if (contextManager && context.sessionId && content) {
      if (content.trim() !== '') {
        nextMessageUuid = await contextManager.saveMessage(
          context.sessionId,
          role,
          content,
          previousId,
          undefined,
          context.subagentInfo
        );
      } else {
        logger.debug(emptyLogMessage);
      }
    }
  } catch (error) {
    logger.warn(failureLogMessage, error);
  }

  return nextMessageUuid;
}
