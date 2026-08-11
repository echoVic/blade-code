import type { Message } from '../../services/ChatServiceInterface.js';
import { type SessionMetadata, SessionService } from '../../services/SessionService.js';
import { getCwd } from '../../utils/cwd.js';

export interface NonInteractiveSessionOptions {
  sessionId?: string;
  continue?: boolean;
  resume?: string | boolean;
  forkSession?: boolean;
  fallbackSessionPrefix: string;
}

export interface ResolvedSessionContext {
  sessionId: string;
  messages: Message[];
  metadata?: SessionMetadata;
}

function isMissingSessionError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return (
    error.message.includes('未找到会话') ||
    error.message.includes('ENOENT') ||
    error.message.includes('no such file')
  );
}

async function tryLoadSession(sessionId: string): Promise<Message[] | null> {
  try {
    return await SessionService.loadSessionModelContext(sessionId, getCwd());
  } catch (error) {
    if (isMissingSessionError(error)) {
      return null;
    }
    throw error;
  }
}

export async function resolveNonInteractiveSession(
  options: NonInteractiveSessionOptions
): Promise<ResolvedSessionContext> {
  if (options.resume === true || options.resume === 'true') {
    throw new Error(
      '--resume without a session ID is only supported in interactive UI mode'
    );
  }

  if (typeof options.resume === 'string' && options.resume.length > 0) {
    if (options.forkSession) {
      const workspace = getCwd();
      const forked = await SessionService.forkSession(options.resume, {
        newSessionId: options.sessionId,
        sourceProjectPath: workspace,
        targetProjectPath: workspace,
      });
      return {
        ...forked,
        messages: await SessionService.loadSessionModelContext(
          forked.sessionId,
          workspace
        ),
      };
    }
    const [messages, metadata] = await Promise.all([
      SessionService.loadSessionModelContext(options.resume),
      SessionService.findSessionMetadata(options.resume),
    ]);
    return {
      sessionId: options.resume,
      messages,
      metadata,
    };
  }

  if (options.continue) {
    const sessions = options.forkSession
      ? await SessionService.listSessions({ cwd: getCwd() })
      : await SessionService.listSessions();
    if (sessions.length > 0) {
      const sessionId = sessions[0].sessionId;
      if (options.forkSession) {
        const workspace = getCwd();
        const forked = await SessionService.forkSession(sessionId, {
          newSessionId: options.sessionId,
          sourceProjectPath: workspace,
          targetProjectPath: workspace,
        });
        return {
          ...forked,
          messages: await SessionService.loadSessionModelContext(
            forked.sessionId,
            workspace
          ),
        };
      }
      return {
        sessionId,
        messages: await SessionService.loadSessionModelContext(sessionId),
        metadata: sessions[0],
      };
    }
    if (options.forkSession) {
      throw new Error('Cannot fork: no sessions are available to continue');
    }
  }

  if (options.sessionId) {
    const messages = await tryLoadSession(options.sessionId);
    return {
      sessionId: options.sessionId,
      messages: messages ?? [],
      ...(messages
        ? {
            metadata: await SessionService.findSessionMetadata(
              options.sessionId,
              getCwd()
            ),
          }
        : {}),
    };
  }

  return {
    sessionId: `${options.fallbackSessionPrefix}-${Date.now()}`,
    messages: [],
  };
}
