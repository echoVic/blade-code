import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { LRUCache } from 'lru-cache';
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
import { Bus } from '../bus.js';
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

export interface RunState {
  id: string;
  sessionId: string;
  status: 'running' | 'waiting_permission' | 'completed' | 'failed' | 'cancelled';
  abortController: AbortController;
  pendingPermission?: {
    permissionId: string;
    resolve: (response: ConfirmationResponse) => void;
    details: ConfirmationDetails;
  };
  createdAt: Date;
}

interface SessionInfo {
  id: string;
  projectPath: string;
  title: string;
  createdAt: Date;
  messages: Message[];
  currentRunId?: string;
}

const sessions = new Map<string, SessionInfo>();

const activeRuns = new LRUCache<string, RunState>({
  max: 100,
  ttl: 30 * 60 * 1000,
  dispose: (run: RunState, runId: string) => {
    if (run.status === 'running' || run.status === 'waiting_permission') {
      run.abortController.abort();
      logger.debug(`[SessionRoutes] Run ${runId} disposed due to cache eviction`);
    }
  },
});

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

export const SessionRoutes = () => {
  const app = new Hono<{ Variables: Variables }>();

  app.get('/', async (c) => {
    try {
      const persistedSessions = await SessionService.listSessions();
      
      const activeSessionsList = Array.from(sessions.values()).map((s) => ({
        sessionId: s.id,
        projectPath: s.projectPath,
        title: s.title,
        messageCount: s.messages.length,
        firstMessageTime: s.createdAt.toISOString(),
        lastMessageTime: new Date().toISOString(),
        hasErrors: false,
        isActive: true,
      }));

      const allSessions = [
        ...activeSessionsList,
        ...persistedSessions.filter((s) => !sessions.has(s.sessionId)),
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

      const session: SessionInfo = {
        id: sessionId,
        projectPath: directory,
        title: title || `Session ${sessionId.slice(0, 6)}`,
        createdAt: new Date(),
        messages: [],
      };

      sessions.set(sessionId, session);

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

    const session = sessions.get(sessionId);
    if (session) {
      return c.json({
        sessionId: session.id,
        projectPath: session.projectPath,
        title: session.title,
        messageCount: session.messages.length,
        firstMessageTime: session.createdAt.toISOString(),
        lastMessageTime: new Date().toISOString(),
        hasErrors: false,
        isActive: true,
      });
    }

    try {
      const persistedSessions = await SessionService.listSessions();
      const persistedSession = persistedSessions.find((s) => s.sessionId === sessionId);
      
      if (!persistedSession) {
        throw new NotFoundError('Session', sessionId);
      }

      return c.json(persistedSession);
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
      const session = sessions.get(sessionId);

      if (session && title) {
        session.title = title;
      }

      return c.json({ success: true, title });
    } catch (error) {
      logger.error('[SessionRoutes] Failed to update session:', error);
      throw error;
    }
  });

  app.delete('/:sessionId', async (c) => {
    const sessionId = c.req.param('sessionId');

    const session = sessions.get(sessionId);
    if (session?.currentRunId) {
      const run = activeRuns.get(session.currentRunId);
      if (run) {
        run.abortController.abort();
        Bus.publish(sessionId, 'run.cancelled', { runId: run.id });
        activeRuns.delete(session.currentRunId);
      }
    }
    sessions.delete(sessionId);

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

  app.get('/:sessionId/events', async (c) => {
    const sessionId = c.req.param('sessionId');

    let session = sessions.get(sessionId);
    if (!session) {
      const directory = c.get('directory') || process.cwd();
      session = {
        id: sessionId,
        projectPath: directory,
        title: `Session ${sessionId.slice(0, 6)}`,
        createdAt: new Date(),
        messages: [],
      };
      sessions.set(sessionId, session);
    }

    return streamSSE(c, async (stream) => {
      const HEARTBEAT_INTERVAL = 15000;

      await stream.writeSSE({ 
        data: JSON.stringify({ type: 'connected', properties: { sessionId, timestamp: Date.now() } }) 
      });

      const unsubscribe = Bus.subscribe((event) => {
        if (event.sessionId !== sessionId) return;
        stream.writeSSE({ 
          data: JSON.stringify({ type: event.type, properties: { sessionId: event.sessionId, ...event.properties } }) 
        }).catch(() => { /* ignore write errors on closed streams */ });
      });

      const heartbeatInterval = setInterval(() => {
        if (!stream.aborted) {
          stream.writeSSE({ 
            data: JSON.stringify({ type: 'heartbeat', properties: { timestamp: Date.now() } }) 
          }).catch(() => { /* ignore write errors on closed streams */ });
        }
      }, HEARTBEAT_INTERVAL);

      stream.onAbort(() => {
        clearInterval(heartbeatInterval);
        unsubscribe();
      });

      while (true) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        if (stream.aborted) break;
      }
    });
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

    let session = sessions.get(sessionId);
    if (!session) {
      session = {
        id: sessionId,
        projectPath: directory,
        title: `Session ${sessionId.slice(0, 6)}`,
        createdAt: new Date(),
        messages: [],
      };
      sessions.set(sessionId, session);
    }

    const runId = nanoid(12);
    const abortController = new AbortController();

    const run: RunState = {
      id: runId,
      sessionId,
      status: 'running',
      abortController,
      createdAt: new Date(),
    };

    activeRuns.set(runId, run);
    session.currentRunId = runId;

    executeRunAsync(run, session, content, permissionMode).catch((error) => {
      logger.error(`[SessionRoutes] Run ${runId} failed:`, error);
    });

    return c.json({ runId, status: 'running' }, 202);
  });

  app.post('/:sessionId/abort', async (c) => {
    const sessionId = c.req.param('sessionId');

    const session = sessions.get(sessionId);
    if (session?.currentRunId) {
      const run = activeRuns.get(session.currentRunId);
      if (run) {
        run.abortController.abort();
        run.status = 'cancelled';
        Bus.publish(sessionId, 'run.cancelled', { runId: run.id });
      }
    }

    return c.json({ success: true });
  });

  app.get('/:sessionId/status', async (c) => {
    const sessionId = c.req.param('sessionId');

    const session = sessions.get(sessionId);
    if (!session?.currentRunId) {
      return c.json({ sessionId, status: 'idle' });
    }

    const run = activeRuns.get(session.currentRunId);
    return c.json({
      sessionId,
      runId: session.currentRunId,
      status: run?.status || 'idle',
    });
  });

  return app;
};

async function executeRunAsync(
  run: RunState,
  session: SessionInfo,
  content: string,
  permissionMode: PermissionMode
): Promise<void> {
  const { abortController, sessionId, id: runId } = run;
  const userMessageId = nanoid(12);
  const assistantMessageId = nanoid(12);

  const emit = (type: string, properties: Record<string, unknown>) => {
    Bus.publish(sessionId, type, properties);
  };

  try {
    emit('message.created', { messageId: userMessageId, role: 'user', content });
    emit('session.status', { status: 'running' });
    emit('message.created', { messageId: assistantMessageId, role: 'assistant', content: '' });

    const agent = await Agent.create({});

    const requestConfirmation = async (details: ConfirmationDetails): Promise<ConfirmationResponse> => {
      const permissionId = nanoid(12);
      const PERMISSION_TIMEOUT = 5 * 60 * 1000;
      
      run.status = 'waiting_permission';
      
      const resultPromise = new Promise<ConfirmationResponse>((resolve) => {
        const timeout = setTimeout(() => {
          logger.warn(`[SessionRoutes] Permission ${permissionId} timed out after ${PERMISSION_TIMEOUT}ms`);
          emit('permission.timeout', { requestId: permissionId });
          resolve({ approved: false, reason: 'timeout' });
        }, PERMISSION_TIMEOUT);

        run.pendingPermission = { 
          permissionId, 
          resolve: (response) => {
            clearTimeout(timeout);
            resolve(response);
          }, 
          details 
        };
      });

      emit('permission.asked', {
        requestId: permissionId,
        toolName: details.toolName,
        description: details.message,
        args: details.args,
        details,
      });

      logger.info(`[SessionRoutes] Permission request created: ${permissionId}, runId: ${runId}`);
      
      const response = await resultPromise;
      logger.info(`[SessionRoutes] Permission response received: ${permissionId}, approved: ${response.approved}`);
      run.status = 'running';
      run.pendingPermission = undefined;
      
      return response;
    };

    const chatContext: ChatContext = {
      messages: session.messages,
      userId: 'web-user',
      sessionId,
      workspaceRoot: session.projectPath,
      signal: abortController.signal,
      permissionMode,
      confirmationHandler: { requestConfirmation },
    };

    const loopOptions: LoopOptions = {
      stream: true,
      onContentDelta: async (delta: string) => {
        emit('message.delta', { messageId: assistantMessageId, delta });
      },
      onThinkingDelta: async (delta: string) => {
        emit('thinking.delta', { delta });
      },
      onStreamEnd: async () => {
        emit('message.complete', { messageId: assistantMessageId });
        emit('thinking.completed', {});
      },
      onToolStart: async (toolCall, toolKind) => {
        if (toolCall.type !== 'function') return;
        emit('tool.start', {
          toolName: toolCall.function.name,
          toolCallId: toolCall.id,
          arguments: toolCall.function.arguments,
          toolKind,
        });
      },
      onToolResult: async (toolCall, result) => {
        if (toolCall.type !== 'function') return;
        emit('tool.result', {
          toolName: toolCall.function.name,
          toolCallId: toolCall.id,
          success: !result.error,
          summary: result.metadata?.summary,
          output: result.displayContent,
          metadata: sanitizeToolMetadata(result.metadata),
        });
      },
      onTokenUsage: async (usage) => {
        emit('token.usage', usage);
      },
      onTodoUpdate: async (todos) => {
        emit('todo.updated', { todos });
      },
    };

    const response = await agent.chat(content, chatContext, loopOptions);

    session.messages.push(
      { role: 'user', content },
      { role: 'assistant', content: response }
    );

    run.status = 'completed';
    emit('session.completed', { runId });
    emit('session.status', { status: 'idle' });

  } catch (error) {
    logger.error('[SessionRoutes] Agent execution error:', error);
    run.status = 'failed';
    emit('session.error', { error: error instanceof Error ? error.message : 'Unknown error' });
    emit('session.status', { status: 'error' });
  }
}

export function respondToPermission(
  sessionId: string,
  permissionId: string,
  response: ConfirmationResponse
): boolean {
  logger.info(`[SessionRoutes] Looking for permission ${permissionId} in session ${sessionId}`);
  logger.info(`[SessionRoutes] Active runs: ${activeRuns.size}`);
  
  for (const [runId, run] of activeRuns.entries()) {
    logger.info(`[SessionRoutes] Checking run ${runId}: sessionId=${run.sessionId}, pendingPermission=${run.pendingPermission?.permissionId}`);
    if (run.sessionId === sessionId && run.pendingPermission?.permissionId === permissionId) {
      run.pendingPermission.resolve(response);
      logger.info(`[SessionRoutes] Permission ${permissionId} responded, runId: ${run.id}`);
      return true;
    }
  }

  logger.error(`[SessionRoutes] Permission not found: ${permissionId}`);
  return false;
}

export function cancelPendingPermissions(sessionId: string): void {
  for (const run of activeRuns.values()) {
    if (run.sessionId === sessionId && run.pendingPermission) {
      run.pendingPermission.resolve({ approved: false });
      run.pendingPermission = undefined;
    }
  }
}
