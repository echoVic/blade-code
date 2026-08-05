import * as os from 'os';
import * as path from 'path';
import { z } from 'zod';
import type { AgentSession } from '../../../agent/subagents/AgentSessionStore.js';
import { BackgroundAgentManager } from '../../../agent/subagents/BackgroundAgentManager.js';
import { subagentRegistry } from '../../../agent/subagents/SubagentRegistry.js';
import {
  type AgentTeam,
  type TeamMember,
  TeamStore,
} from '../../../agent/teams/TeamStore.js';
import { getCwd } from '../../../utils/cwd.js';
import { createTool } from '../../core/createTool.js';
import type { ExecutionContext, ToolResult } from '../../types/index.js';
import { ToolErrorType, ToolKind } from '../../types/index.js';

const memberSchema = z.object({
  name: z
    .string()
    .min(1)
    .describe('Human-readable teammate name, e.g. researcher or test-runner'),
  subagent_type: z
    .string()
    .min(1)
    .describe('Registered subagent type to launch for this teammate'),
  description: z.string().min(3).max(100).optional(),
  prompt: z.string().min(10).describe('Detailed assignment for this teammate'),
});

export function createTeamTools(opts?: { sessionId?: string; configDir?: string }) {
  const sessionId = opts?.sessionId || `session_${Date.now()}`;
  const configDir = opts?.configDir || path.join(os.homedir(), '.blade');

  return [
    createTeamCreateTool({ sessionId, configDir }),
    createTeamStatusTool({ configDir }),
    createTeamDeleteTool({ configDir }),
  ];
}

function createTeamCreateTool(opts: { sessionId: string; configDir: string }) {
  return createTool({
    name: 'TeamCreate',
    displayName: 'Team Create',
    kind: ToolKind.ReadOnly,
    isConcurrencySafe: false,
    schema: z.object({
      team_name: z.string().min(1).describe('Name for the new agent team'),
      description: z.string().optional().describe('Team description or purpose'),
      agent_type: z
        .string()
        .optional()
        .describe('Optional role/type label for the team lead'),
      members: z
        .array(memberSchema)
        .default([])
        .describe('Initial teammates to launch as background agents'),
    }),
    description: {
      short: 'Create an agent team and optionally launch teammate subagents',
      long: getTeamCreatePrompt(),
      usageNotes: [
        'Use TeamCreate when a task benefits from coordinated parallel agents',
        'Each member is launched with the requested subagent_type as a background agent',
        'Use TeamStatus to inspect teammate progress and collect agent IDs for TaskOutput',
      ],
    },
    async execute(params, context: ExecutionContext): Promise<ToolResult> {
      try {
        ensureSubagentsLoaded();
        const duplicate = findDuplicateMemberName(params.members.map((m) => m.name));
        if (duplicate) {
          return teamError(`Duplicate teammate name: ${duplicate}`, '创建团队失败');
        }

        const invalidTypes = params.members
          .map((member) => member.subagent_type)
          .filter((type) => !subagentRegistry.getSubagent(type));
        if (invalidTypes.length > 0) {
          return teamError(
            `Invalid subagent type(s): ${[...new Set(invalidTypes)].join(', ')}. Available: ${subagentRegistry.getAllNames().join(', ') || 'none'}`,
            '创建团队失败'
          );
        }

        const manager = BackgroundAgentManager.getInstance();
        const store = TeamStore.getInstance(opts.configDir);
        const team = await store.createTeam({
          name: params.team_name,
          description: params.description,
          leadAgentType: params.agent_type,
          leadSessionId: context.sessionId || opts.sessionId,
          members: [],
        });
        const now = Date.now();
        const members: TeamMember[] = [];

        for (const member of params.members) {
          const config = subagentRegistry.getSubagent(member.subagent_type);
          if (!config) continue;
          const effectiveConfig = {
            ...config,
            model:
              config.model && config.model !== 'inherit'
                ? config.model
                : (context.modelId ?? config.model),
            permissionMode: config.permissionMode ?? context.permissionMode,
          };

          const memberId = `team-${TeamStore.sanitizeName(member.name)}-${team.name}`;
          const prompt = buildMemberPrompt({
            teamName: team.name,
            teamDescription: params.description,
            memberName: member.name,
            memberPrompt: member.prompt,
            teamFileHint: team.teamFilePath,
          });
          const agentId = manager.startBackgroundAgent({
            config: effectiveConfig,
            description: member.description || member.name,
            prompt,
            parentSessionId: context.sessionId || opts.sessionId,
            parentProjectPath: context.workspaceRoot || getCwd(),
            permissionMode: context.permissionMode,
            agentId: memberId,
            taskListId: team.name,
            workspaceRoot: context.workspaceRoot || getCwd(),
            isolation: effectiveConfig.isolation,
          });

          members.push({
            id: memberId,
            name: member.name,
            subagentType: member.subagent_type,
            description: member.description || member.name,
            prompt: member.prompt,
            agentId,
            status: 'running',
            joinedAt: now,
          });
        }

        const updatedTeam: AgentTeam = {
          ...team,
          members: [...team.members, ...members],
          updatedAt: Date.now(),
        };
        await store.saveTeam(updatedTeam);
        const syncedTeam = await syncTeamStatuses(store, updatedTeam);

        return {
          success: true,
          llmContent: {
            team: toPublicTeam(syncedTeam),
            message:
              members.length > 0
                ? `Team created with ${members.length} teammate(s). Use TeamStatus(team_name: "${syncedTeam.name}") to inspect progress.`
                : `Team created. Use Task and TaskCreate tools to coordinate work for "${syncedTeam.name}".`,
          },
          metadata: {
            summary: `创建 Agent Team: ${syncedTeam.name} (${members.length} teammates)`,
            team_name: syncedTeam.name,
            team_file_path: syncedTeam.teamFilePath,
            lead_agent_id: syncedTeam.leadAgentId,
            member_agent_ids: members.map((member) => member.agentId).filter(Boolean),
          },
        };
      } catch (error) {
        return teamException(error, '创建团队失败');
      }
    },
    version: '1.0.0',
    category: 'Agent Team',
    tags: ['team', 'agents', 'subagent', 'parallel'],
    extractSignatureContent: (params) => params.team_name,
    abstractPermissionRule: () => '*',
  });
}

function createTeamStatusTool(opts: { configDir: string }) {
  return createTool({
    name: 'TeamStatus',
    displayName: 'Team Status',
    kind: ToolKind.ReadOnly,
    isConcurrencySafe: true,
    schema: z.object({
      team_name: z
        .string()
        .optional()
        .describe('Team name to inspect. Omit to list all teams.'),
    }),
    description: {
      short: 'List agent teams or inspect one team with teammate statuses',
      long: 'Use this after TeamCreate to monitor teammate background agents and find their TaskOutput IDs.',
    },
    async execute(params): Promise<ToolResult> {
      try {
        const store = TeamStore.getInstance(opts.configDir);

        if (!params.team_name) {
          const teams = await Promise.all(
            (await store.listTeams()).map((team) => syncTeamStatuses(store, team))
          );
          return {
            success: true,
            llmContent: { teams: teams.map(toPublicTeam) },
            metadata: {
              summary:
                teams.length === 0
                  ? '暂无 Agent Teams'
                  : `Agent Teams: ${teams.length}`,
              teams: teams.map(toPublicTeam),
            },
          };
        }

        const team = await store.loadTeam(params.team_name);
        if (!team) {
          return teamError(`Team not found: ${params.team_name}`, '读取团队失败');
        }
        const syncedTeam = await syncTeamStatuses(store, team);
        return {
          success: true,
          llmContent: { team: toPublicTeam(syncedTeam) },
          metadata: {
            summary: `Agent Team ${syncedTeam.name}: ${summarizeTeam(syncedTeam)}`,
            team: toPublicTeam(syncedTeam),
          },
        };
      } catch (error) {
        return teamException(error, '读取团队失败');
      }
    },
    version: '1.0.0',
    category: 'Agent Team',
    tags: ['team', 'status', 'agents'],
    extractSignatureContent: (params) => params.team_name || '*',
    abstractPermissionRule: () => '*',
  });
}

function createTeamDeleteTool(opts: { configDir: string }) {
  return createTool({
    name: 'TeamDelete',
    displayName: 'Team Delete',
    kind: ToolKind.ReadOnly,
    isConcurrencySafe: false,
    schema: z.object({
      team_name: z.string().min(1).describe('Team name to delete'),
      kill_running: z
        .boolean()
        .default(true)
        .describe('Whether to cancel running teammate agents'),
    }),
    description: {
      short: 'Mark an agent team deleted and optionally cancel running teammates',
      long: 'Use this when coordinated team work is finished or should be stopped.',
    },
    async execute(params): Promise<ToolResult> {
      try {
        const store = TeamStore.getInstance(opts.configDir);
        const team = await store.loadTeam(params.team_name);
        if (!team) {
          return teamError(`Team not found: ${params.team_name}`, '删除团队失败');
        }

        const manager = BackgroundAgentManager.getInstance();
        const killed: string[] = [];
        if (params.kill_running) {
          for (const member of team.members) {
            if (member.agentId && manager.killAgent(member.agentId)) {
              killed.push(member.agentId);
            }
          }
        }

        const deleted = await store.markDeleted(params.team_name);
        return {
          success: true,
          llmContent: {
            team: deleted ? toPublicTeam(deleted) : null,
            killed_agent_ids: killed,
          },
          metadata: {
            summary: `删除 Agent Team: ${team.name}`,
            team_name: team.name,
            killed_agent_ids: killed,
          },
        };
      } catch (error) {
        return teamException(error, '删除团队失败');
      }
    },
    version: '1.0.0',
    category: 'Agent Team',
    tags: ['team', 'delete', 'agents'],
    extractSignatureContent: (params) => params.team_name,
    abstractPermissionRule: () => '*',
  });
}

function ensureSubagentsLoaded(): void {
  if (subagentRegistry.getAllNames().length === 0) {
    subagentRegistry.loadFromStandardLocations();
  }
}

function buildMemberPrompt(input: {
  teamName: string;
  teamDescription?: string;
  memberName: string;
  memberPrompt: string;
  teamFileHint: string;
}): string {
  return `
You are ${input.memberName}, a teammate in Blade agent team "${input.teamName}".

Team purpose: ${input.teamDescription || 'Coordinate parallel agent work'}.
Team file: ${input.teamFileHint}
Shared task list: ${input.teamName}
Workspace: ${getCwd()}

Work independently on your assignment and return a concise final result for the team lead. Use the available task tools to track work when helpful. If you need implementation access, only proceed if your subagent type has the required tools.

Assignment:
${input.memberPrompt}
`.trim();
}

async function syncTeamStatuses(store: TeamStore, team: AgentTeam): Promise<AgentTeam> {
  const manager = BackgroundAgentManager.getInstance();
  let changed = false;
  const members = team.members.map((member) => {
    if (!member.agentId) return member;
    const session = manager.getAgent(member.agentId);
    if (!session) return { ...member, status: 'unknown' as const };
    const nextStatus = mapAgentStatus(session);
    if (nextStatus !== member.status || session.completedAt !== member.completedAt) {
      changed = true;
      return {
        ...member,
        status: nextStatus,
        completedAt: session.completedAt,
      };
    }
    return member;
  });

  const synced = { ...team, members };
  if (changed) await store.saveTeam(synced);
  return synced;
}

function mapAgentStatus(session: AgentSession): TeamMember['status'] {
  switch (session.status) {
    case 'running':
      return 'running';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'unknown';
  }
}

function toPublicTeam(team: AgentTeam) {
  const manager = BackgroundAgentManager.getInstance();
  return {
    name: team.name,
    description: team.description,
    status: team.deletedAt ? 'deleted' : summarizeTeam(team),
    team_file_path: team.teamFilePath,
    lead_agent_id: team.leadAgentId,
    lead_session_id: team.leadSessionId,
    created_at: new Date(team.createdAt).toISOString(),
    updated_at: new Date(team.updatedAt).toISOString(),
    deleted_at: team.deletedAt ? new Date(team.deletedAt).toISOString() : undefined,
    members: team.members.map((member) => {
      const session = member.agentId ? manager.getAgent(member.agentId) : undefined;
      return {
        id: member.id,
        name: member.name,
        subagent_type: member.subagentType,
        description: member.description,
        agent_id: member.agentId,
        status: member.status,
        task_output_id: member.agentId,
        result: session?.result,
        stats: session?.stats,
      };
    }),
  };
}

function summarizeTeam(team: AgentTeam): string {
  const counts = team.members.reduce<Record<string, number>>((acc, member) => {
    acc[member.status] = (acc[member.status] || 0) + 1;
    return acc;
  }, {});
  return Object.entries(counts)
    .map(([status, count]) => `${count} ${status}`)
    .join(', ');
}

function findDuplicateMemberName(names: string[]): string | undefined {
  const seen = new Set<string>();
  for (const name of names) {
    const key = TeamStore.sanitizeName(name);
    if (seen.has(key)) return name;
    seen.add(key);
  }
  return undefined;
}

function teamError(message: string, summary: string): ToolResult {
  return {
    success: false,
    llmContent: message,
    error: {
      type: ToolErrorType.VALIDATION_ERROR,
      message,
    },
    metadata: { summary },
  };
}

function teamException(error: unknown, summary: string): ToolResult {
  const err = error as Error;
  return {
    success: false,
    llmContent: `Team operation failed: ${err.message}`,
    error: {
      type: ToolErrorType.EXECUTION_ERROR,
      message: err.message,
      details: error,
    },
    metadata: { summary },
  };
}

function getTeamCreatePrompt(): string {
  return `
Create a named team for coordinated parallel agent work. This is Blade's team layer over the existing Task background-agent system, inspired by Claude Code's TeamCreate workflow.

When to use:
- The user asks for a team, swarm, group of agents, or collaborative agents.
- The work benefits from independent research, planning, implementation, or verification streams.
- You need durable team state under ~/.blade/teams and trackable teammate agent IDs.

Workflow:
1. Create the team with a short team_name and optional description.
2. Include initial members when you already know the parallel assignments.
3. Each member must use a registered subagent_type from the Task tool's available agent list.
4. Inspect progress with TeamStatus.
5. Retrieve detailed teammate output with TaskOutput using the member task_output_id.
6. Stop the team with TeamDelete when the work is complete or cancelled.
`.trim();
}
