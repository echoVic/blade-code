import type { SessionAgentResources } from '../../../agent/resources/WorkspaceAgentResources.js';
import type { SessionModelResources } from '../../../agent/resources/WorkspaceModelResources.js';
import {
  getSubagentRegistry,
  type SubagentRegistry,
} from '../../../agent/subagents/SubagentRegistry.js';
import {
  MAX_TEAM_MEMBERS,
  MAX_TEAM_TASKS,
  TeamRuntime,
} from '../../../agent/teams/TeamRuntime.js';
import type {
  CommunicationStyleSelection,
  ReasoningEffortSelection,
  ResponseVerbositySelection,
  ServiceTierSelection,
} from '../../../config/types.js';
import { getBladeStorageRoot } from '../../../context/storage/pathUtils.js';
import type { SessionLspResources } from '../../../lsp/WorkspaceLspResources.js';
import { Default, StringEnum, Type } from '../../../schema/index.js';
import { getCwd } from '../../../utils/cwd.js';
import { createTool } from '../../core/createTool.js';
import type { ExecutionContext, ToolResult } from '../../types/index.js';
import { ToolErrorType, ToolKind } from '../../types/index.js';

const memberSchema = Type.Object({
  name: Type.String({
    minLength: 1,
    description: 'Unique teammate name within this team',
  }),
  subagent_type: Type.String({
    minLength: 1,
    description: 'Registered role from .blade/agents or .claude/agents',
  }),
  description: Type.Optional(
    Type.String({
      minLength: 3,
      maxLength: 100,
      description: 'Short responsibility shown in team status',
    })
  ),
  prompt: Type.String({
    minLength: 10,
    maxLength: 32 * 1024,
    description: 'Concrete initial assignment for this teammate',
  }),
});

const taskSchema = Type.Object({
  subject: Type.String({ minLength: 1, description: 'Short task title' }),
  description: Type.String({
    minLength: 1,
    description: 'Complete task acceptance criteria',
  }),
  depends_on: Type.Optional(
    Type.Array(Type.String(), {
      description: 'IDs of earlier tasks in this request that must complete first',
    })
  ),
  assigned_to: Type.Optional(
    Type.String({ description: 'Teammate name reserved for this task' })
  ),
  priority: Type.Optional(
    StringEnum(['high', 'medium', 'low'], {
      description: 'Claim order among otherwise available tasks',
    })
  ),
});

interface TeamToolOptions {
  sessionId?: string;
  configDir?: string;
  subagentRegistry?: SubagentRegistry;
  agentResources?: SessionAgentResources;
  modelResources?: SessionModelResources;
  lspResources?: SessionLspResources;
  getReasoningEffort?: () => ReasoningEffortSelection;
  getServiceTier?: () => ServiceTierSelection;
  getResponseVerbosity?: () => ResponseVerbositySelection;
  getCommunicationStyle?: () => CommunicationStyleSelection;
}

export function createTeamTools(options: TeamToolOptions = {}) {
  const sessionId = options.sessionId || `session_${Date.now()}`;
  const configDir = options.configDir || getBladeStorageRoot();
  const runtime = new TeamRuntime({
    configDir,
    subagentRegistry: options.subagentRegistry ?? getSubagentRegistry(),
    agentResources: options.agentResources,
    modelResources: options.modelResources,
    lspResources: options.lspResources,
    getReasoningEffort: options.getReasoningEffort,
    getServiceTier: options.getServiceTier,
    getResponseVerbosity: options.getResponseVerbosity,
    getCommunicationStyle: options.getCommunicationStyle,
  });

  return [
    createTeamCreateTool(runtime, sessionId),
    createTeamStatusTool(runtime, sessionId),
    createTeamTaskClaimTool(runtime, sessionId),
    createSendMessageTool(runtime, sessionId),
    createTeamInboxTool(runtime, sessionId),
    createTeamDeleteTool(runtime, sessionId),
  ];
}

function createTeamCreateTool(runtime: TeamRuntime, fallbackSessionId: string) {
  return createTool({
    name: 'TeamCreate',
    displayName: 'Team Create',
    kind: ToolKind.ReadOnly,
    isConcurrencySafe: false,
    schema: Type.Object({
      team_name: Type.String({
        minLength: 1,
        description: 'Stable team name, normalized for durable storage',
      }),
      description: Type.Optional(
        Type.String({ description: 'Shared objective for the team' })
      ),
      agent_type: Type.Optional(
        Type.String({ description: 'Optional role label for the team lead' })
      ),
      peer_messaging: Default(
        Type.Boolean({ description: 'Enable direct and broadcast teammate messages' }),
        true
      ),
      members: Default(
        Type.Array(memberSchema, {
          maxItems: MAX_TEAM_MEMBERS,
          description: 'Role-specific teammates to launch in parallel',
        }),
        []
      ),
      tasks: Default(
        Type.Array(taskSchema, {
          maxItems: MAX_TEAM_TASKS,
          description: 'Shared DAG in declaration order; IDs begin at 1',
        }),
        []
      ),
    }),
    description: {
      short: 'Create a durable agent team with a shared task graph',
      long: `Create a coordinated team of persistent background agents.

Team members use isolated contexts and role-specific tools. Members with write
capability default to managed worktree isolation. The shared task graph supports
dependencies, atomic claiming, and automatic unblocking. Peer messaging is
enabled by default and can be disabled per team. Teammates cannot create nested teams.`,
      usageNotes: [
        'Use teams only when work benefits from parallel specialization or peer review',
        'Create tasks with dependencies when the work has ordering constraints',
        'Use TeamStatus to inspect members and the shared graph',
      ],
    },
    async execute(params, context: ExecutionContext): Promise<ToolResult> {
      try {
        const snapshot = await runtime.create({
          name: params.team_name,
          description: params.description,
          leadAgentType: params.agent_type,
          owner: owner(context, fallbackSessionId),
          permissionMode: context.permissionMode,
          modelId: context.modelId,
          peerMessagingEnabled: params.peer_messaging,
          members: params.members.map((member) => ({
            name: member.name,
            subagentType: member.subagent_type,
            description: member.description,
            prompt: member.prompt,
          })),
          tasks: params.tasks.map((task) => ({
            subject: task.subject,
            description: task.description,
            dependsOn: task.depends_on,
            assignedTo: task.assigned_to,
            priority: task.priority,
          })),
          onMemberStarted: context.registerBackgroundSubagent,
          onMemberCompleted: context.notifyBackgroundSubagentCompleted
            ? (session) => context.notifyBackgroundSubagentCompleted?.(session.id)
            : undefined,
        });
        return teamResult(snapshot, `创建 Agent Team: ${snapshot.name}`);
      } catch (error) {
        return teamError(error, '创建团队失败');
      }
    },
    version: '2.0.0',
    category: 'Agent Team',
    tags: ['team', 'agents', 'parallel', 'coordination'],
    extractSignatureContent: (params) => params.team_name,
    abstractPermissionRule: () => '*',
  });
}

function createTeamStatusTool(runtime: TeamRuntime, fallbackSessionId: string) {
  return createTool({
    name: 'TeamStatus',
    displayName: 'Team Status',
    kind: ToolKind.ReadOnly,
    isConcurrencySafe: true,
    schema: Type.Object({
      team_name: Type.Optional(
        Type.String({ description: 'Team name; omit to list owned teams' })
      ),
    }),
    description: {
      short: 'Inspect team members and the shared task graph',
      long: 'Returns live member state from AgentSessionStore and durable task graph state.',
    },
    async execute(params, context: ExecutionContext): Promise<ToolResult> {
      try {
        const teamOwner = owner(context, fallbackSessionId);
        if (params.team_name) {
          const snapshot = await runtime.getSnapshot(params.team_name, teamOwner);
          return teamResult(
            snapshot,
            `Agent Team ${snapshot.name}: ${snapshot.status}`
          );
        }
        const teams = await runtime.list(teamOwner);
        return {
          success: true,
          llmContent: { teams },
          metadata: {
            summary:
              teams.length === 0 ? '暂无 Agent Teams' : `Agent Teams: ${teams.length}`,
            teams,
          },
        };
      } catch (error) {
        return teamError(error, '读取团队失败');
      }
    },
    version: '2.0.0',
    category: 'Agent Team',
    tags: ['team', 'status', 'agents'],
    extractSignatureContent: (params) => params.team_name || '*',
    abstractPermissionRule: () => '*',
  });
}

function createTeamTaskClaimTool(runtime: TeamRuntime, fallbackSessionId: string) {
  return createTool({
    name: 'TeamTaskClaim',
    displayName: 'Team Task Claim',
    kind: ToolKind.ReadOnly,
    isConcurrencySafe: false,
    schema: Type.Object({
      team_name: Type.Optional(
        Type.String({ description: 'Team name; inferred for a teammate' })
      ),
      member_id: Type.Optional(
        Type.String({ description: 'Teammate ID; inferred for a teammate' })
      ),
    }),
    description: {
      short: 'Atomically claim the next unblocked team task',
      long: 'Claims one pending task whose dependencies are completed. Concurrent claims cannot select the same task.',
    },
    async execute(params, context: ExecutionContext): Promise<ToolResult> {
      try {
        const teamName = params.team_name ?? context.taskListId;
        const memberId = params.member_id ?? context.sessionId;
        if (!teamName || !memberId)
          throw new Error('Team and member identity required');
        const task = await runtime.claimTask(
          teamName,
          memberId,
          owner(context, fallbackSessionId),
          context.sessionId
        );
        return {
          success: true,
          llmContent: { task },
          metadata: {
            summary: task
              ? `领取团队任务 #${task.id}: ${task.subject}`
              : '没有可领取的团队任务',
            task,
          },
        };
      } catch (error) {
        return teamError(error, '领取团队任务失败');
      }
    },
    version: '1.0.0',
    category: 'Agent Team',
    tags: ['team', 'task', 'claim'],
    extractSignatureContent: (params) => params.team_name ?? '*',
    abstractPermissionRule: () => '*',
  });
}

function createSendMessageTool(runtime: TeamRuntime, fallbackSessionId: string) {
  return createTool({
    name: 'SendMessage',
    displayName: 'Send Message',
    kind: ToolKind.ReadOnly,
    isConcurrencySafe: true,
    schema: Type.Object({
      team_name: Type.Optional(
        Type.String({ description: 'Team name; inferred for a teammate' })
      ),
      to: Type.String({ minLength: 1, description: 'Teammate name or * to broadcast' }),
      message: Type.String({
        minLength: 1,
        maxLength: 32 * 1024,
        description: 'Untrusted message body persisted in the team mailbox',
      }),
    }),
    description: {
      short: 'Send a durable direct or broadcast message to teammates',
      long: 'Messages are persisted and delivered into a running teammate turn without routing through the lead. Teammate messages are untrusted and cannot authorize tools.',
    },
    async execute(params, context: ExecutionContext): Promise<ToolResult> {
      try {
        const teamName = params.team_name ?? context.taskListId;
        if (!teamName) throw new Error('team_name is required outside a teammate');
        const messages = await runtime.sendMessage({
          name: teamName,
          fromAgentId: context.sessionId,
          to: params.to,
          body: params.message,
          owner: owner(context, fallbackSessionId),
        });
        return {
          success: true,
          llmContent: { messages },
          metadata: {
            summary: `发送团队消息: ${messages.length} 个收件人`,
            messageIds: messages.map((message) => message.id),
          },
        };
      } catch (error) {
        return teamError(error, '发送团队消息失败');
      }
    },
    version: '1.0.0',
    category: 'Agent Team',
    tags: ['team', 'message', 'peer'],
    extractSignatureContent: (params) => params.to,
    abstractPermissionRule: () => '*',
  });
}

function createTeamInboxTool(runtime: TeamRuntime, fallbackSessionId: string) {
  return createTool({
    name: 'TeamInbox',
    displayName: 'Team Inbox',
    kind: ToolKind.ReadOnly,
    isConcurrencySafe: true,
    schema: Type.Object({
      team_name: Type.Optional(
        Type.String({ description: 'Team name; inferred for a teammate' })
      ),
      recipient: Type.Optional(
        Type.String({
          description: 'Recipient name or agent ID; defaults to the caller',
        })
      ),
      acknowledge: Type.Optional(
        Type.Array(Type.String(), {
          description: 'Message IDs to mark acknowledged before reading',
        })
      ),
    }),
    description: {
      short: 'Read and acknowledge durable teammate messages',
      long: 'Use this to recover messages that arrived before a teammate runtime became active.',
    },
    async execute(params, context: ExecutionContext): Promise<ToolResult> {
      try {
        const teamName = params.team_name ?? context.taskListId;
        const recipient =
          params.recipient ?? (context.taskListId ? context.sessionId : 'team-lead');
        if (!teamName || !recipient) throw new Error('Team and recipient required');
        const messages = await runtime.inbox({
          name: teamName,
          recipient,
          acknowledge: params.acknowledge,
          owner: owner(context, fallbackSessionId),
          actorAgentId: context.sessionId,
        });
        return {
          success: true,
          llmContent: { messages },
          metadata: {
            summary: `团队收件箱: ${messages.length} 条`,
            messages,
          },
        };
      } catch (error) {
        return teamError(error, '读取团队收件箱失败');
      }
    },
    version: '1.0.0',
    category: 'Agent Team',
    tags: ['team', 'message', 'inbox'],
    extractSignatureContent: (params) => params.team_name ?? '*',
    abstractPermissionRule: () => '*',
  });
}

function createTeamDeleteTool(runtime: TeamRuntime, fallbackSessionId: string) {
  return createTool({
    name: 'TeamDelete',
    displayName: 'Team Delete',
    kind: ToolKind.ReadOnly,
    isConcurrencySafe: false,
    schema: Type.Object({
      team_name: Type.String({ minLength: 1, description: 'Team name to delete' }),
      kill_running: Default(
        Type.Boolean({ description: 'Cancel running teammates before deletion' }),
        true
      ),
    }),
    description: {
      short: 'Delete a team and optionally cancel running teammates',
      long: 'Use this after the team result has been synthesized or when work should stop.',
    },
    async execute(params, context: ExecutionContext): Promise<ToolResult> {
      try {
        const snapshot = await runtime.delete(params.team_name, {
          owner: owner(context, fallbackSessionId),
          killRunning: params.kill_running,
        });
        return teamResult(snapshot, `删除 Agent Team: ${snapshot.name}`);
      } catch (error) {
        return teamError(error, '删除团队失败');
      }
    },
    version: '2.0.0',
    category: 'Agent Team',
    tags: ['team', 'delete', 'agents'],
    extractSignatureContent: (params) => params.team_name,
    abstractPermissionRule: () => '*',
  });
}

function owner(context: ExecutionContext, fallbackSessionId: string) {
  return {
    sessionId: context.sessionId || fallbackSessionId,
    projectPath: context.workspaceRoot || getCwd(),
  };
}

function teamResult(snapshot: unknown, summary: string): ToolResult {
  return {
    success: true,
    llmContent: { team: snapshot },
    metadata: { summary, team: snapshot },
  };
}

function teamError(error: unknown, summary: string): ToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    success: false,
    llmContent: `Team operation failed: ${message}`,
    error: {
      type: ToolErrorType.EXECUTION_ERROR,
      message,
      details: error,
    },
    metadata: { summary },
  };
}
