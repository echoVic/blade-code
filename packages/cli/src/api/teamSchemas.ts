import { Runtime, type Static, StringEnum, Type } from '../schema/index.js';

export const TeamMemberSnapshotSchema = Runtime(
  Type.Object({
    id: Type.String(),
    name: Type.String(),
    subagentType: Type.String(),
    description: Type.String(),
    agentId: Type.Optional(Type.String()),
    status: StringEnum([
      'leader',
      'running',
      'completed',
      'failed',
      'cancelled',
      'unknown',
    ]),
    result: Type.Optional(Type.Unknown()),
    stats: Type.Optional(Type.Unknown()),
    worktreePath: Type.Optional(Type.String()),
  })
);

export const TeamTaskSnapshotSchema = Runtime(
  Type.Object({
    id: Type.String(),
    subject: Type.String(),
    description: Type.String(),
    status: StringEnum(['pending', 'blocked', 'running', 'completed']),
    owner: Type.Optional(Type.String()),
    priority: StringEnum(['high', 'medium', 'low']),
    dependsOn: Type.Array(Type.String()),
    blocks: Type.Array(Type.String()),
    result: Type.Optional(Type.String()),
    createdAt: Type.String(),
    startedAt: Type.Optional(Type.String()),
    completedAt: Type.Optional(Type.String()),
  })
);

export const TeamSnapshotSchema = Runtime(
  Type.Object({
    name: Type.String(),
    description: Type.Optional(Type.String()),
    status: StringEnum(['idle', 'running', 'completed', 'failed', 'deleted']),
    leadAgentId: Type.String(),
    leadSessionId: Type.Optional(Type.String()),
    workspaceRoot: Type.Optional(Type.String()),
    peerMessagingEnabled: Type.Boolean(),
    createdAt: Type.Number(),
    updatedAt: Type.Number(),
    deletedAt: Type.Optional(Type.Number()),
    members: Type.Array(TeamMemberSnapshotSchema),
    tasks: Type.Array(TeamTaskSnapshotSchema),
  })
);
export type TeamSnapshot = Static<typeof TeamSnapshotSchema>;

export const TeamCreateRequestSchema = Runtime(
  Type.Object({
    sessionId: Type.String({ minLength: 1 }),
    projectPath: Type.String({ minLength: 1 }),
    name: Type.String({ minLength: 1 }),
    description: Type.Optional(Type.String()),
    leadAgentType: Type.Optional(Type.String()),
    peerMessagingEnabled: Type.Optional(Type.Boolean()),
    members: Type.Array(
      Type.Object({
        name: Type.String({ minLength: 1 }),
        subagentType: Type.String({ minLength: 1 }),
        description: Type.Optional(Type.String()),
        prompt: Type.String({ minLength: 10, maxLength: 32 * 1024 }),
      }),
      { maxItems: 32 }
    ),
    tasks: Type.Optional(
      Type.Array(
        Type.Object({
          subject: Type.String({ minLength: 1 }),
          description: Type.String({ minLength: 1 }),
          dependsOn: Type.Optional(Type.Array(Type.String())),
          assignedTo: Type.Optional(Type.String()),
          priority: Type.Optional(StringEnum(['high', 'medium', 'low'])),
        }),
        { maxItems: 256 }
      )
    ),
  })
);

export const TeamMessageRequestSchema = Runtime(
  Type.Object({
    sessionId: Type.String({ minLength: 1 }),
    projectPath: Type.String({ minLength: 1 }),
    to: Type.String({ minLength: 1 }),
    message: Type.String({ minLength: 1, maxLength: 32 * 1024 }),
  })
);

export const TeamTaskClaimRequestSchema = Runtime(
  Type.Object({
    sessionId: Type.String({ minLength: 1 }),
    projectPath: Type.String({ minLength: 1 }),
    memberId: Type.String({ minLength: 1 }),
  })
);
