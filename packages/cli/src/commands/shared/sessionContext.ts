import type { Message } from '../../services/ChatServiceInterface.js';
import { SessionService } from '../../services/SessionService.js';
import { getCwd } from '../../utils/cwd.js';

export interface NonInteractiveSessionOptions {
  sessionId?: string;
  continue?: boolean;
  resume?: string | boolean;
  fallbackSessionPrefix: string;
}

export interface ResolvedSessionContext {
  sessionId: string;
  messages: Message[];
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
    return await SessionService.loadSession(sessionId, getCwd());
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
    return {
      sessionId: options.resume,
      messages: await SessionService.loadSession(options.resume),
    };
  }

  if (options.continue) {
    const sessions = await SessionService.listSessions();
    if (sessions.length > 0) {
      const sessionId = sessions[0].sessionId;
      return {
        sessionId,
        messages: await SessionService.loadSession(sessionId),
      };
    }
  }

  if (options.sessionId) {
    return {
      sessionId: options.sessionId,
      messages: (await tryLoadSession(options.sessionId)) ?? [],
    };
  }

  return {
    sessionId: `${options.fallbackSessionPrefix}-${Date.now()}`,
    messages: [],
  };
}
