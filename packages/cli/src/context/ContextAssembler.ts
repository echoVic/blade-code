/**
 * ContextAssembler - 从 JSONL 事件流重建 ContextData
 *
 * 职责：将 PersistentStore 的 SessionEvent[] 转换为结构化的上下文数据。
 * 集中了之前散落在 PersistentStore.loadSession/loadConversation 和
 * ContextManager.loadSession 里的重建逻辑。
 */

import type { JsonObject, JsonValue, MessageRole } from '../store/types.js';
import type {
  ContextData,
  ContextMessage,
  ConversationContext,
  SessionContext,
  SessionEvent,
  SystemContext,
  ToolCall,
  WorkspaceContext,
} from './types.js';

export interface AssembledSession {
  session: SessionContext;
  conversation: ConversationContext;
  toolCalls: ToolCall[];
}

export class ContextAssembler {
  /**
   * 从 JSONL 事件流重建完整的会话数据
   */
  assemble(events: SessionEvent[]): AssembledSession | null {
    if (events.length === 0) return null;

    const session = this.assembleSession(events);
    const conversation = this.assembleConversation(events);
    const toolCalls = this.assembleToolCalls(events);

    return { session, conversation, toolCalls };
  }

  /**
   * 从事件流重建完整的 ContextData
   */
  assembleContextData(
    events: SessionEvent[],
    system: SystemContext,
    workspace: WorkspaceContext
  ): ContextData | null {
    const assembled = this.assemble(events);
    if (!assembled) return null;

    return {
      layers: {
        system,
        session: assembled.session,
        conversation: assembled.conversation,
        tool: {
          recentCalls: assembled.toolCalls,
          toolStates: {},
          dependencies: {},
        },
        workspace,
      },
      metadata: {
        totalTokens: 0,
        priority: 1,
        lastUpdated: Date.now(),
      },
    };
  }

  /**
   * 重建 SessionContext
   */
  private assembleSession(events: SessionEvent[]): SessionContext {
    const sessionCreated = events.find((e) => e.type === 'session_created');
    const sessionId = sessionCreated?.sessionId ?? events[0].sessionId;
    const startTime = new Date(
      sessionCreated?.timestamp ?? events[0].timestamp
    ).getTime();

    // 从 session_updated 事件中提取最新的配置
    const updates = events.filter((e) => e.type === 'session_updated');
    const latestUpdate = updates.length > 0 ? updates[updates.length - 1] : null;

    return {
      sessionId,
      userId: undefined,
      preferences: {},
      configuration: (latestUpdate?.data as JsonObject) ?? {},
      startTime,
    };
  }

  /**
   * 重建 ConversationContext（包含 messages + summary）
   */
  private assembleConversation(events: SessionEvent[]): ConversationContext {
    const messageMap = new Map<
      string,
      { id: string; role: MessageRole; content: string; timestamp: number; metadata?: JsonObject }
    >();

    let latestSummary: string | undefined;

    for (const event of events) {
      if (event.type === 'message_created') {
        messageMap.set(event.data.messageId, {
          id: event.data.messageId,
          role: event.data.role,
          content: '',
          timestamp: new Date(event.timestamp).getTime(),
          metadata: event.data.model
            ? { model: event.data.model }
            : undefined,
        });
      }

      if (event.type === 'part_created') {
        const { partType, messageId, payload } = event.data;
        const message = messageMap.get(messageId);

        if (partType === 'text' && message) {
          const p = payload as { text?: string };
          message.content = p.text ?? '';
        }

        // 提取 compaction summary
        if (partType === 'summary') {
          const p = payload as { text?: string };
          if (p.text) latestSummary = p.text;
        }
      }

      // part_updated 覆盖已有内容
      if (event.type === 'part_updated') {
        const { partType, messageId, payload } = event.data;
        const message = messageMap.get(messageId);

        if (partType === 'text' && message) {
          const p = payload as { text?: string };
          message.content = p.text ?? '';
        }
      }
    }

    const messages: ContextMessage[] = Array.from(messageMap.values());
    const lastEvent = events[events.length - 1];
    const lastActivity = new Date(lastEvent.timestamp).getTime();

    return {
      messages,
      summary: latestSummary,
      topics: [],
      lastActivity,
    };
  }

  /**
   * 重建 ToolCall 列表
   */
  private assembleToolCalls(events: SessionEvent[]): ToolCall[] {
    const toolCalls = new Map<string, ToolCall>();

    for (const event of events) {
      if (event.type !== 'part_created') continue;

      const { partType, partId, payload } = event.data;

      if (partType === 'tool_call') {
        const p = payload as { toolCallId?: string; toolName?: string; input?: JsonValue };
        const id = p.toolCallId ?? partId;
        toolCalls.set(id, {
          id,
          name: p.toolName ?? 'unknown',
          input: (p.input ?? null) as JsonValue,
          timestamp: new Date(event.timestamp).getTime(),
          status: 'pending',
        });
      }

      if (partType === 'tool_result') {
        const p = payload as {
          toolCallId?: string;
          toolName?: string;
          output?: JsonValue;
          error?: string | null;
        };
        const id = p.toolCallId ?? partId;
        const existing = toolCalls.get(id);
        if (existing) {
          existing.output = (p.output ?? undefined) as JsonValue | undefined;
          existing.status = p.error ? 'error' : 'success';
          existing.error = p.error ?? undefined;
        } else {
          toolCalls.set(id, {
            id,
            name: p.toolName ?? 'unknown',
            input: null as unknown as JsonValue,
            output: (p.output ?? undefined) as JsonValue | undefined,
            timestamp: new Date(event.timestamp).getTime(),
            status: p.error ? 'error' : 'success',
            error: p.error ?? undefined,
          });
        }
      }
    }

    return Array.from(toolCalls.values());
  }
}
