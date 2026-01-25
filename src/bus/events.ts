import { z } from 'zod';

export const SessionCreatedEvent = z.object({
  type: z.literal('session.created'),
  properties: z.object({
    sessionId: z.string(),
    projectPath: z.string(),
    title: z.string().optional(),
  }),
});

export const SessionUpdatedEvent = z.object({
  type: z.literal('session.updated'),
  properties: z.object({
    sessionId: z.string(),
    title: z.string().optional(),
  }),
});

export const SessionDeletedEvent = z.object({
  type: z.literal('session.deleted'),
  properties: z.object({
    sessionId: z.string(),
  }),
});

export const SessionStatusEvent = z.object({
  type: z.literal('session.status'),
  properties: z.object({
    sessionId: z.string(),
    status: z.enum(['idle', 'running', 'waiting', 'error']),
  }),
});

export const MessageCreatedEvent = z.object({
  type: z.literal('message.created'),
  properties: z.object({
    sessionId: z.string(),
    messageId: z.string(),
    role: z.enum(['user', 'assistant', 'system', 'tool']),
    content: z.string().optional(),
  }),
});

export const MessageUpdatedEvent = z.object({
  type: z.literal('message.updated'),
  properties: z.object({
    sessionId: z.string(),
    messageId: z.string(),
    content: z.string().optional(),
  }),
});

export const MessagePartUpdatedEvent = z.object({
  type: z.literal('message.part.updated'),
  properties: z.object({
    sessionId: z.string(),
    messageId: z.string(),
    partId: z.string(),
    type: z.string(),
    content: z.any().optional(),
  }),
});

export const PermissionAskedEvent = z.object({
  type: z.literal('permission.asked'),
  properties: z.object({
    requestId: z.string(),
    sessionId: z.string(),
    toolName: z.string().optional(),
    description: z.string().optional(),
    args: z.record(z.any()).optional(),
    details: z.record(z.any()).optional(),
  }),
});

export const PermissionRepliedEvent = z.object({
  type: z.literal('permission.replied'),
  properties: z.object({
    requestId: z.string(),
    sessionId: z.string().optional(),
    approved: z.boolean(),
    remember: z.boolean().optional(),
    scope: z.enum(['once', 'session']).optional(),
    targetMode: z.string().optional(),
    feedback: z.string().optional(),
    answers: z.record(z.union([z.string(), z.array(z.string())])).optional(),
  }),
});

export const ServerConnectedEvent = z.object({
  type: z.literal('server.connected'),
  properties: z.object({}),
});

export const ServerHeartbeatEvent = z.object({
  type: z.literal('server.heartbeat'),
  properties: z.object({}),
});

export const ConfigUpdatedEvent = z.object({
  type: z.literal('config.updated'),
  properties: z.object({
    key: z.string().optional(),
  }),
});

export const TodoUpdatedEvent = z.object({
  type: z.literal('todo.updated'),
  properties: z.object({
    sessionId: z.string(),
    todos: z.array(z.object({
      id: z.string(),
      content: z.string(),
      status: z.enum(['pending', 'in_progress', 'completed']),
      priority: z.enum(['high', 'medium', 'low']).optional(),
    })),
  }),
});

export const MessageDeltaEvent = z.object({
  type: z.literal('message.delta'),
  properties: z.object({
    sessionId: z.string(),
    messageId: z.string(),
    delta: z.string(),
  }),
});

export const MessageCompleteEvent = z.object({
  type: z.literal('message.complete'),
  properties: z.object({
    sessionId: z.string(),
    messageId: z.string(),
  }),
});

export const ToolStartEvent = z.object({
  type: z.literal('tool.start'),
  properties: z.object({
    sessionId: z.string(),
    toolName: z.string(),
    toolCallId: z.string(),
    toolKind: z.string().optional(),
    arguments: z.string().optional(),
  }),
});

export const ToolResultEvent = z.object({
  type: z.literal('tool.result'),
  properties: z.object({
    sessionId: z.string(),
    toolName: z.string(),
    toolCallId: z.string(),
    success: z.boolean(),
    summary: z.string().optional(),
    output: z.string().optional(),
    metadata: z.record(z.any()).optional(),
  }),
});

export const TokenUsageEvent = z.object({
  type: z.literal('token.usage'),
  properties: z.object({
    sessionId: z.string(),
    inputTokens: z.number().optional(),
    outputTokens: z.number().optional(),
    totalTokens: z.number().optional(),
    cacheReadTokens: z.number().optional(),
    cacheWriteTokens: z.number().optional(),
  }),
});

export const ThinkingDeltaEvent = z.object({
  type: z.literal('thinking.delta'),
  properties: z.object({
    sessionId: z.string(),
    delta: z.string(),
  }),
});

export const ThinkingCompletedEvent = z.object({
  type: z.literal('thinking.completed'),
  properties: z.object({
    sessionId: z.string(),
  }),
});

export const SessionErrorEvent = z.object({
  type: z.literal('session.error'),
  properties: z.object({
    sessionId: z.string(),
    error: z.string(),
  }),
});

export const BusEventPayload = z.discriminatedUnion('type', [
  SessionCreatedEvent,
  SessionUpdatedEvent,
  SessionDeletedEvent,
  SessionStatusEvent,
  SessionErrorEvent,
  MessageCreatedEvent,
  MessageUpdatedEvent,
  MessagePartUpdatedEvent,
  MessageDeltaEvent,
  MessageCompleteEvent,
  PermissionAskedEvent,
  PermissionRepliedEvent,
  ServerConnectedEvent,
  ServerHeartbeatEvent,
  ConfigUpdatedEvent,
  TodoUpdatedEvent,
  ToolStartEvent,
  ToolResultEvent,
  TokenUsageEvent,
  ThinkingDeltaEvent,
  ThinkingCompletedEvent,
]);

export type BusEventPayload = z.infer<typeof BusEventPayload>;

export type EventType = BusEventPayload['type'];

export type EventProperties<T extends EventType> = Extract<
  BusEventPayload,
  { type: T }
>['properties'];
