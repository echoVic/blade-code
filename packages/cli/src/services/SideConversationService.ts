import { ConversationState } from '../agent/loop/ConversationState.js';
import { MAX_SIDE_QUESTION_CHARS } from '../api/sideConversation.js';
import type {
  ChatToolDefinition,
  IChatService,
  Message,
  UsageInfo,
} from './ChatServiceInterface.js';

export const MAX_SIDE_CONVERSATION_RESPONSE_CHARS = 128 * 1024;

export interface SideConversationResult {
  response: string;
  usage?: UsageInfo;
  durationMs: number;
}

export interface SideConversationRequest {
  question: string;
  sessionId: string;
  workspaceRoot: string;
  systemPrompt: string;
  messages: readonly Message[];
  tools: readonly ChatToolDefinition[];
  chatService: IChatService;
  signal?: AbortSignal;
  providerRecoveryBudgetMs?: number;
}

function sideQuestionPrompt(question: string): string {
  return `<system-reminder>
This is a side question from the user. Answer it directly in one response.

You are a separate lightweight conversation that shares the main conversation's
context. The main agent continues independently. Do not claim that it was
interrupted and do not change, continue, or summarize its task.

You cannot use tools or take actions. Use only information already present in the
conversation context. Do not promise to inspect files, run commands, search, or
perform follow-up work. If the context does not contain the answer, say so.
</system-reminder>

${question}`;
}

export async function runSideConversation(
  request: SideConversationRequest
): Promise<SideConversationResult> {
  const question = request.question.trim();
  if (!question) throw new Error('Side question cannot be empty');
  if (question.includes('\0')) {
    throw new Error('Side question contains an invalid null character');
  }
  if (question.length > MAX_SIDE_QUESTION_CHARS) {
    throw new Error(
      `Side question exceeds the ${MAX_SIDE_QUESTION_CHARS} character limit`
    );
  }

  const startedAt = Date.now();
  const context = {
    messages: structuredClone([...request.messages]),
    userId: 'side-conversation',
    sessionId: request.sessionId,
    workspaceRoot: request.workspaceRoot,
  };
  const state = new ConversationState(context, request.systemPrompt);
  state.appendUser({ role: 'user', content: sideQuestionPrompt(question) });

  const response = await request.chatService.chat(
    state.toLLMMessages(),
    [...request.tools],
    request.signal,
    {
      providerSessionId: `${request.sessionId}:side`,
      ...(request.providerRecoveryBudgetMs && request.providerRecoveryBudgetMs > 0
        ? {
            providerRecovery: {
              mode: 'bounded_foreground' as const,
              budgetMs: request.providerRecoveryBudgetMs,
            },
          }
        : {}),
      providerAdmission: {
        sessionId: request.sessionId,
        ownerId: request.sessionId,
        requestClass: 'foreground',
      },
    }
  );

  if ((response.toolCalls?.length ?? 0) > 0) {
    throw new Error('Side conversation attempted to use a tool');
  }
  const content = response.content.trim();
  if (!content) throw new Error('Side conversation returned no response');
  if (content.length > MAX_SIDE_CONVERSATION_RESPONSE_CHARS) {
    throw new Error('Side conversation response exceeded the display limit');
  }

  return {
    response: content,
    usage: response.usage,
    durationMs: Math.max(0, Date.now() - startedAt),
  };
}
