import { Hono } from 'hono';
import { type SSEStreamingApi, streamSSE } from 'hono/streaming';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { Agent } from '../../agent/Agent.js';
import type { ChatContext, LoopOptions } from '../../agent/types.js';
import { PermissionMode } from '../../config/types.js';
import { createLogger, LogCategory } from '../../logging/Logger.js';
import type { Message } from '../../services/ChatServiceInterface.js';
import { SessionService } from '../../services/SessionService.js';
import type { ConfirmationDetails, ConfirmationResponse } from '../../tools/types/ExecutionTypes.js';
import type { ToolResultMetadata } from '../../tools/types/ToolTypes.js';
import { BadRequestError, NotFoundError } from '../error.js';

const logger = createLogger(LogCategory.SERVICE);

const CreateSessionSchema = z.object({
  title: z.string().optional(),
  projectPath: z.string().optional(),
});

const SendMessageSchema = z.object({
  content: z.string(),
  attachments: z.array(z.object({
    type: z.enum(['file', 'image', 'url']),
    path: z.string().optional(),
    url: z.string().optional(),
    content: z.string().optional(),
  })).optional(),
  permissionMode: z.enum(['default', 'autoEdit', 'plan', 'spec', 'yolo']).optional(),
});

const UpdateSessionSchema = z.object({
  title: z.string().optional(),
});

interface ActiveSession {
  id: string;
  projectPath: string;
  title: string;
  createdAt: Date;
  abortController?: AbortController;
  messages: Message[];
}

const activeSessions = new Map<string, ActiveSession>();

const globalPendingPermissions = new Map<string, {
  sessionId: string;
  resolve: (response: ConfirmationResponse) => void;
  details: ConfirmationDetails;
}>();

type Variables = {
  directory: string;
};

const sanitizeToolMetadata = (metadata: ToolResultMetadata | undefined) => {
  if (!metadata || typeof metadata !== 'object') return metadata;
  const sanitized = { ...(metadata as Record<string, unknown>) };
  const MAX_INLINE_CONTENT = 200000;
  if (typeof sanitized.oldContent === 'string' && sanitized.oldContent.length > MAX_INLINE_CONTENT) {
    delete sanitized.oldContent;
  }
  if (typeof sanitized.newContent === 'string' && sanitized.newContent.length > MAX_INLINE_CONTENT) {
    delete sanitized.newContent;
  }
  return sanitized as ToolResultMetadata;
};

const writeEvent = async (stream: SSEStreamingApi, type: string, properties: Record<string, unknown>) => {
  await stream.writeSSE({
    data: JSON.stringify({ type, properties }),
  });
};

export const SessionRoutes = () => {
  const app = new Hono<{ Variables: Variables }>();

  app.get('/', async (c) => {
    try {
      const sessions = await SessionService.listSessions();
      
      const activeSessionsList = Array.from(activeSessions.values()).map((s) => ({
        sessionId: s.id,
        projectPath: s.projectPath,
        title: s.title,
        messageCount: 0,
        firstMessageTime: s.createdAt.toISOString(),
        lastMessageTime: new Date().toISOString(),
        hasErrors: false,
        isActive: true,
      }));

      const allSessions = [
        ...activeSessionsList,
        ...sessions.filter((s) => !activeSessions.has(s.sessionId)),
      ];

      return c.json(allSessions);
    } catch (error) {
      logger.error('[SessionRoutes] Failed to list sessions:', error);
      return c.json([]);
    }
  });

  app.post('/', async (c) => {
    try {
      const body = await c.req.json();
      const parsed = CreateSessionSchema.safeParse(body);
      
      if (!parsed.success) {
        throw new BadRequestError('Invalid request body');
      }

      const { title, projectPath } = parsed.data;
      const sessionId = nanoid(12);
      const directory = projectPath || c.get('directory') || process.cwd();

      const session: ActiveSession = {
        id: sessionId,
        projectPath: directory,
        title: title || `Session ${sessionId.slice(0, 6)}`,
        createdAt: new Date(),
        messages: [],
      };

      activeSessions.set(sessionId, session);

      return c.json({
        sessionId,
        projectPath: directory,
        title: session.title,
        messageCount: 0,
        firstMessageTime: session.createdAt.toISOString(),
        lastMessageTime: session.createdAt.toISOString(),
        hasErrors: false,
      });
    } catch (error) {
      logger.error('[SessionRoutes] Failed to create session:', error);
      throw error;
    }
  });

  app.get('/:sessionId', async (c) => {
    const sessionId = c.req.param('sessionId');

    const activeSession = activeSessions.get(sessionId);
    if (activeSession) {
      return c.json({
        sessionId: activeSession.id,
        projectPath: activeSession.projectPath,
        title: activeSession.title,
        messageCount: 0,
        firstMessageTime: activeSession.createdAt.toISOString(),
        lastMessageTime: new Date().toISOString(),
        hasErrors: false,
        isActive: true,
      });
    }

    try {
      const sessions = await SessionService.listSessions();
      const session = sessions.find((s) => s.sessionId === sessionId);
      
      if (!session) {
        throw new NotFoundError('Session', sessionId);
      }

      return c.json(session);
    } catch (error) {
      if (error instanceof NotFoundError) throw error;
      logger.error('[SessionRoutes] Failed to get session:', error);
      throw error;
    }
  });

  app.patch('/:sessionId', async (c) => {
    const sessionId = c.req.param('sessionId');

    try {
      const body = await c.req.json();
      const parsed = UpdateSessionSchema.safeParse(body);

      if (!parsed.success) {
        throw new BadRequestError('Invalid request body');
      }

      const { title } = parsed.data;
      const activeSession = activeSessions.get(sessionId);

      if (activeSession && title) {
        activeSession.title = title;
      }

      return c.json({ success: true, title });
    } catch (error) {
      logger.error('[SessionRoutes] Failed to update session:', error);
      throw error;
    }
  });

  app.delete('/:sessionId', async (c) => {
    const sessionId = c.req.param('sessionId');

    const activeSession = activeSessions.get(sessionId);
    if (activeSession) {
      if (activeSession.abortController) {
        activeSession.abortController.abort();
      }
      activeSessions.delete(sessionId);
    }
    
    for (const [permId, pending] of globalPendingPermissions) {
      if (pending.sessionId === sessionId) {
        pending.resolve({ approved: false });
        globalPendingPermissions.delete(permId);
      }
    }

    return c.json({ success: true });
  });

  app.get('/:sessionId/message', async (c) => {
    const sessionId = c.req.param('sessionId');

    try {
      const messages = await SessionService.loadSession(sessionId);
      return c.json(messages);
    } catch (error) {
      logger.error('[SessionRoutes] Failed to get messages:', error);
      return c.json([]);
    }
  });

  app.post('/:sessionId/message', async (c) => {
    const sessionId = c.req.param('sessionId');

    const body = await c.req.json();
    const parsed = SendMessageSchema.safeParse(body);
    
    if (!parsed.success) {
      throw new BadRequestError('Invalid message format');
    }

    const { content, permissionMode: requestedMode } = parsed.data;
    const permissionMode = (requestedMode as PermissionMode) || PermissionMode.DEFAULT;
    const directory = c.get('directory') || process.cwd();

    let session = activeSessions.get(sessionId);
    if (!session) {
      session = {
        id: sessionId,
        projectPath: directory,
        title: `Session ${sessionId.slice(0, 6)}`,
        createdAt: new Date(),
        messages: [],
      };
      activeSessions.set(sessionId, session);
    }

    const currentSession = session;
    const abortController = new AbortController();
    currentSession.abortController = abortController;

    return streamSSE(c, async (stream) => {
      const userMessageId = nanoid(12);
      const assistantMessageId = nanoid(12);

      try {
        await writeEvent(stream, 'message.created', {
          sessionId,
          messageId: userMessageId,
          role: 'user',
          content,
        });

        await writeEvent(stream, 'session.status', {
          sessionId,
          status: 'running',
        });

        await writeEvent(stream, 'message.created', {
          sessionId,
          messageId: assistantMessageId,
          role: 'assistant',
          content: '',
        });

        const agent = await Agent.create({});

        const requestConfirmation = async (details: ConfirmationDetails): Promise<ConfirmationResponse> => {
          const requestId = nanoid(12);
          
          const resultPromise = new Promise<ConfirmationResponse>((resolve) => {
            globalPendingPermissions.set(requestId, { sessionId, resolve, details });
          });

          await writeEvent(stream, 'permission.asked', {
            requestId,
            sessionId,
            toolName: details.toolName,
            description: details.message,
            args: details.args,
            details,
          });

          logger.info(`[SessionRoutes] Permission request created: ${requestId}, sessionId: ${sessionId}`);
          return resultPromise;
        };

        const chatContext: ChatContext = {
          messages: currentSession.messages,
          userId: 'web-user',
          sessionId: sessionId,
          workspaceRoot: currentSession.projectPath,
          signal: abortController.signal,
          permissionMode,
          confirmationHandler: { requestConfirmation },
        };

        const loopOptions: LoopOptions = {
          stream: true,
          onContentDelta: async (delta: string) => {
            await writeEvent(stream, 'message.delta', {
              sessionId,
              messageId: assistantMessageId,
              delta,
            });
          },
          onThinkingDelta: async (delta: string) => {
            await writeEvent(stream, 'thinking.delta', {
              sessionId,
              delta,
            });
          },
          onStreamEnd: async () => {
            await writeEvent(stream, 'message.complete', {
              sessionId,
              messageId: assistantMessageId,
            });
            await writeEvent(stream, 'thinking.completed', {
              sessionId,
            });
          },
          onToolStart: async (toolCall, toolKind) => {
            if (toolCall.type !== 'function') return;
            await writeEvent(stream, 'tool.start', {
              sessionId,
              toolName: toolCall.function.name,
              toolCallId: toolCall.id,
              arguments: toolCall.function.arguments,
              toolKind,
            });
          },
          onToolResult: async (toolCall, result) => {
            if (toolCall.type !== 'function') return;
            await writeEvent(stream, 'tool.result', {
              sessionId,
              toolName: toolCall.function.name,
              toolCallId: toolCall.id,
              success: !result.error,
              summary: result.metadata?.summary,
              output: result.displayContent,
              metadata: sanitizeToolMetadata(result.metadata),
            });
          },
          onTokenUsage: async (usage) => {
            await writeEvent(stream, 'token.usage', {
              sessionId,
              ...usage,
            });
          },
          onTodoUpdate: async (todos) => {
            await writeEvent(stream, 'todo.updated', {
              sessionId,
              todos,
            });
          },
        };

        const response = await agent.chat(content, chatContext, loopOptions);

        currentSession.messages.push(
          { role: 'user', content },
          { role: 'assistant', content: response }
        );

        await writeEvent(stream, 'session.status', {
          sessionId,
          status: 'idle',
        });

      } catch (error) {
        logger.error('[SessionRoutes] Agent execution error:', error);
        await writeEvent(stream, 'session.error', {
          sessionId,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
        await writeEvent(stream, 'session.status', {
          sessionId,
          status: 'error',
        });
      } finally {
        currentSession.abortController = undefined;
      }
    });
  });

  app.post('/:sessionId/abort', async (c) => {
    const sessionId = c.req.param('sessionId');

    const session = activeSessions.get(sessionId);
    if (session?.abortController) {
      session.abortController.abort();
      session.abortController = undefined;
    }

    return c.json({ success: true });
  });

  app.get('/:sessionId/status', async (c) => {
    const sessionId = c.req.param('sessionId');

    const session = activeSessions.get(sessionId);
    const isRunning = session?.abortController !== undefined;

    return c.json({
      sessionId,
      status: isRunning ? 'running' : 'idle',
    });
  });

  return app;
};

export function respondToPermission(
  sessionId: string,
  permissionId: string,
  response: ConfirmationResponse
): boolean {
  const pending = globalPendingPermissions.get(permissionId);
  if (!pending) {
    logger.error(`[SessionRoutes] Permission not found: ${permissionId}, pending permissions: ${Array.from(globalPendingPermissions.keys()).join(', ')}`);
    return false;
  }

  if (pending.sessionId !== sessionId) {
    logger.error(`[SessionRoutes] Session mismatch: expected ${pending.sessionId}, got ${sessionId}`);
    return false;
  }

  pending.resolve(response);
  globalPendingPermissions.delete(permissionId);
  return true;
}

export function cancelPendingPermissions(sessionId: string): void {
  for (const [permId, pending] of globalPendingPermissions) {
    if (pending.sessionId === sessionId) {
      pending.resolve({ approved: false });
      globalPendingPermissions.delete(permId);
    }
  }
}
