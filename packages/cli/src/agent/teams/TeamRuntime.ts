import type {
  CommunicationStyleSelection,
  PermissionMode,
  ReasoningEffortSelection,
  ResponseVerbositySelection,
  ServiceTierSelection,
} from '../../config/types.js';
import type { SessionLspResources } from '../../lsp/WorkspaceLspResources.js';
import { Bus } from '../../server/bus.js';
import type { SessionRef } from '../../server/sessionRef.js';
import type { SessionAgentResources } from '../resources/WorkspaceAgentResources.js';
import type { SessionModelResources } from '../resources/WorkspaceModelResources.js';
import type { AgentSession } from '../subagents/AgentSessionStore.js';
import { BackgroundAgentManager } from '../subagents/BackgroundAgentManager.js';
import type { SubagentRegistry } from '../subagents/SubagentRegistry.js';
import type { SubagentConfig } from '../subagents/types.js';
import { TeamCoordinator } from './TeamCoordinator.js';
import type { TeamEventProperties, TeamEventType } from './TeamEvents.js';
import {
  formatTeamMessage,
  TeamMailbox,
  teamMessageMetadata,
  type TeamMessage,
} from './TeamMailbox.js';
import {
  type AgentTeam,
  type TeamMember,
  type TeamMemberStatus,
  TeamStore,
} from './TeamStore.js';
import { type TeamTask, TeamTaskGraph } from './TeamTaskGraph.js';

const WRITE_TOOLS = new Set(['Edit', 'Write', 'ApplyPatch', 'Bash']);
const TEAM_COORDINATION_TOOLS = ['TeamTaskClaim', 'TeamInbox'] as const;
export const MAX_TEAM_MEMBERS = 32;
export const MAX_TEAM_TASKS = 256;

export interface TeamMemberInput {
  name: string;
  subagentType: string;
  description?: string;
  prompt: string;
}

export interface TeamTaskInput {
  subject: string;
  description: string;
  dependsOn?: string[];
  assignedTo?: string;
  priority?: 'high' | 'medium' | 'low';
}

export interface TeamMemberSnapshot {
  id: string;
  name: string;
  subagentType: string;
  description: string;
  agentId?: string;
  status: TeamMemberStatus;
  result?: AgentSession['result'];
  stats?: AgentSession['stats'];
  worktreePath?: string;
}

export interface TeamSnapshot {
  name: string;
  description?: string;
  status: 'idle' | 'running' | 'completed' | 'failed' | 'deleted';
  leadAgentId: string;
  leadSessionId?: string;
  workspaceRoot?: string;
  peerMessagingEnabled: boolean;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
  members: TeamMemberSnapshot[];
  tasks: TeamTask[];
}

export interface TeamRuntimeOptions {
  configDir: string;
  subagentRegistry: SubagentRegistry;
  agentResources?: SessionAgentResources;
  modelResources?: SessionModelResources;
  lspResources?: SessionLspResources;
  getReasoningEffort?: () => ReasoningEffortSelection;
  getServiceTier?: () => ServiceTierSelection;
  getResponseVerbosity?: () => ResponseVerbositySelection;
  getCommunicationStyle?: () => CommunicationStyleSelection;
}

export class TeamRuntime {
  private readonly store: TeamStore;
  private readonly manager = BackgroundAgentManager.getInstance();

  constructor(private readonly options: TeamRuntimeOptions) {
    this.store = TeamStore.getInstance(options.configDir);
  }

  async create(input: {
    name: string;
    description?: string;
    leadAgentType?: string;
    owner: SessionRef;
    permissionMode?: PermissionMode;
    modelId?: string;
    peerMessagingEnabled?: boolean;
    members: TeamMemberInput[];
    tasks?: TeamTaskInput[];
    onMemberStarted?: (agentId: string) => void;
    onMemberCompleted?: (session: AgentSession) => void | Promise<void>;
  }): Promise<TeamSnapshot> {
    this.ensureSubagentsLoaded();
    this.validateMembers(input.members);

    const team = await this.store.createTeam({
      name: input.name,
      description: input.description,
      leadAgentType: input.leadAgentType,
      leadSessionId: input.owner.sessionId,
      workspaceRoot: input.owner.projectPath,
      peerMessagingEnabled: input.peerMessagingEnabled,
      members: [],
    });
    const members = input.members.map((member): TeamMember => {
      const config = this.options.subagentRegistry.getSubagent(member.subagentType);
      if (!config) {
        throw new Error(`Invalid subagent type: ${member.subagentType}`);
      }
      const memberId = `team-${TeamStore.sanitizeName(member.name)}-${team.name}`;
      return {
        id: memberId,
        name: member.name,
        subagentType: member.subagentType,
        description: member.description || member.name,
        prompt: member.prompt,
        agentId: memberId,
        joinedAt: Date.now(),
      };
    });
    const persistedTeam = { ...team, members: [...team.members, ...members] };
    const startedAgentIds: string[] = [];
    try {
      this.validateTasks(input.tasks ?? [], members);
      await this.store.saveTeam(persistedTeam);
      const graph = new TeamTaskGraph(team.taskListId, this.options.configDir);
      for (const task of input.tasks ?? []) {
        await graph.createTask({
          ...task,
          assignedTo: task.assignedTo
            ? requireMember(members, task.assignedTo).agentId
            : undefined,
        });
      }
      this.publish(input.owner, 'team.created', { teamName: team.name });

      for (const memberDefinition of members) {
        const config = this.options.subagentRegistry.getSubagent(
          memberDefinition.subagentType
        );
        if (!config) {
          throw new Error(`Invalid subagent type: ${memberDefinition.subagentType}`);
        }
        const effectiveConfig: SubagentConfig = {
          ...config,
          tools:
            config.tools && config.tools.length > 0
              ? [
                  ...new Set([
                    ...config.tools,
                    ...TEAM_COORDINATION_TOOLS,
                    ...(team.peerMessagingEnabled ? ['SendMessage'] : []),
                  ]),
                ]
              : config.tools,
          model:
            config.model && config.model !== 'inherit'
              ? config.model
              : (input.modelId ?? config.model),
          permissionMode: config.permissionMode ?? input.permissionMode,
          isolation: config.isolation ?? defaultIsolation(config),
        };

        const agentId = this.manager.startBackgroundAgent({
          config: effectiveConfig,
          description: memberDefinition.description,
          prompt: this.buildMemberPrompt(persistedTeam, memberDefinition),
          parentSessionId: input.owner.sessionId,
          providerAdmissionOwnerId: input.owner.sessionId,
          parentProjectPath: input.owner.projectPath,
          permissionMode: input.permissionMode,
          reasoningEffort: this.options.getReasoningEffort?.(),
          serviceTier: this.options.getServiceTier?.(),
          responseVerbosity: this.options.getResponseVerbosity?.(),
          communicationStyle: this.options.getCommunicationStyle?.(),
          agentId: memberDefinition.id,
          taskListId: team.taskListId,
          teamId: team.name,
          workspaceRoot: input.owner.projectPath,
          isolation: effectiveConfig.isolation,
          agentResources: this.options.agentResources,
          modelResources: this.options.modelResources,
          lspResources: this.options.lspResources,
          onStarted: (startedAgentId) =>
            this.deliverPendingMessages(
              persistedTeam,
              memberDefinition,
              startedAgentId
            ),
          onCompleted: (session) =>
            this.onMemberCompleted(persistedTeam, session, input.owner).then(() =>
              input.onMemberCompleted?.(session)
            ),
        });
        startedAgentIds.push(agentId);
        input.onMemberStarted?.(agentId);
        this.publish(input.owner, 'team.member.spawned', {
          teamName: team.name,
          member: memberDefinition,
        });
      }
    } catch (error) {
      for (const agentId of startedAgentIds) {
        this.manager.killAgent(agentId, input.owner);
      }
      await this.store.markDeleted(team.name);
      this.publish(input.owner, 'team.deleted', {
        teamName: team.name,
        reason: 'startup_failed',
      });
      throw error;
    }

    return this.getSnapshot(team.name, input.owner);
  }

  async list(owner: SessionRef): Promise<TeamSnapshot[]> {
    const teams = (await this.store.listTeams()).filter(
      (team) =>
        team.deletedAt === undefined &&
        team.leadSessionId === owner.sessionId &&
        team.workspaceRoot === owner.projectPath
    );
    return Promise.all(teams.map((team) => this.project(team)));
  }

  async getSnapshot(name: string, owner?: SessionRef): Promise<TeamSnapshot> {
    const team = await this.requireTeam(name);
    if (
      owner &&
      (team.leadSessionId !== owner.sessionId ||
        team.workspaceRoot !== owner.projectPath)
    ) {
      throw new Error(`Team not found: ${name}`);
    }
    return this.project(team);
  }

  async claimTask(
    name: string,
    memberId: string,
    owner?: SessionRef,
    actorAgentId?: string
  ): Promise<TeamTask | null> {
    const team = await this.requireTeam(name);
    const member = findMember(team, memberId);
    if (!member || member.name === 'team-lead') {
      throw new Error(`Unknown teammate: ${memberId}`);
    }
    this.assertActorAccess(team, owner, actorAgentId, member);
    const task = await new TeamCoordinator(
      new TeamTaskGraph(team.taskListId, this.options.configDir)
    ).claimNext(member.agentId ?? member.id);
    if (task && team.leadSessionId && team.workspaceRoot) {
      this.publish(
        { sessionId: team.leadSessionId, projectPath: team.workspaceRoot },
        'team.task.claimed',
        { teamName: team.name, task, memberId: member.id }
      );
    }
    return task;
  }

  async sendMessage(input: {
    name: string;
    fromAgentId?: string;
    to: string;
    body: string;
    owner?: SessionRef;
  }): Promise<TeamMessage[]> {
    const team = await this.requireTeam(input.name);
    if (!team.peerMessagingEnabled) {
      throw new Error(`Peer messaging is disabled for team ${team.name}`);
    }
    const sender = this.resolveSender(team, input.fromAgentId, input.owner);

    const recipients =
      input.to === '*'
        ? team.members.filter((member) => member.id !== sender.id)
        : [findMember(team, input.to)].filter(
            (member): member is TeamMember => member !== undefined
          );
    if (recipients.length === 0) {
      throw new Error(`Unknown teammate: ${input.to}`);
    }

    const mailbox = new TeamMailbox(team.name, this.options.configDir);
    const messages: TeamMessage[] = [];
    for (const recipient of recipients) {
      const message = await mailbox.send({
        from: sender.name,
        to: recipient.name,
        body: input.body,
        targetAgentId: recipient.agentId,
      });
      messages.push(message);
      if (recipient.name === 'team-lead') {
        const owner = teamOwner(team);
        if (owner) {
          this.publish(owner, 'team.message.received', {
            teamName: team.name,
            messageId: message.id,
            content: formatTeamMessage(message),
            metadata: teamMessageMetadata(message),
          });
        }
      } else if (recipient.agentId) {
        const delivered = await this.manager.enqueueSteering(
          recipient.agentId,
          formatTeamMessage(message),
          teamOwner(team)
        );
        if (delivered) await mailbox.markDelivered([message.id]);
      }
    }
    const owner = teamOwner(team);
    if (owner) {
      this.publish(owner, 'team.message.sent', {
        teamName: team.name,
        from: sender.name,
        to: input.to,
        messageIds: messages.map((message) => message.id),
      });
    }
    return messages;
  }

  async inbox(input: {
    name: string;
    recipient: string;
    acknowledge?: string[];
    owner?: SessionRef;
    actorAgentId?: string;
  }): Promise<TeamMessage[]> {
    const team = await this.requireTeam(input.name);
    const member = findMember(team, input.recipient);
    if (!member) throw new Error(`Unknown teammate: ${input.recipient}`);
    if (member.name === 'team-lead') {
      this.assertOwner(team, input.owner);
    } else {
      this.assertActorAccess(team, input.owner, input.actorAgentId, member);
    }
    const mailbox = new TeamMailbox(team.name, this.options.configDir);
    if (input.acknowledge?.length) {
      await mailbox.acknowledge(input.acknowledge, member.agentId ?? member.name);
    }
    return mailbox.list(member.agentId ?? member.name);
  }

  async delete(
    name: string,
    options: { owner?: SessionRef; killRunning?: boolean } = {}
  ): Promise<TeamSnapshot> {
    const team = await this.requireOwnedTeam(name, options.owner);
    if (options.killRunning !== false) {
      for (const member of team.members) {
        if (member.agentId) this.manager.killAgent(member.agentId, teamOwner(team));
      }
    }
    const deleted = await this.store.markDeleted(team.name);
    if (!deleted) throw new Error(`Team not found: ${team.name}`);
    const owner = teamOwner(team);
    if (owner) this.publish(owner, 'team.deleted', { teamName: team.name });
    return this.project(deleted);
  }

  private async onMemberCompleted(
    team: AgentTeam,
    session: AgentSession,
    owner: SessionRef
  ): Promise<void> {
    const completion = await new TeamCoordinator(
      new TeamTaskGraph(team.taskListId, this.options.configDir)
    ).completeMemberWork(session);
    for (const task of completion.unblockedTasks) {
      this.publish(owner, 'team.task.unblocked', {
        teamName: team.name,
        task,
      });
    }
    this.publish(owner, 'team.member.completed', {
      teamName: team.name,
      memberId: session.id,
      status: session.status,
      result: session.result,
    });
    const snapshot = await this.getSnapshot(team.name, owner);
    if (snapshot.status === 'completed' || snapshot.status === 'failed') {
      this.publish(owner, 'team.completed', {
        teamName: team.name,
        status: snapshot.status,
      });
    }
  }

  private async project(team: AgentTeam): Promise<TeamSnapshot> {
    const tasks = await new TeamTaskGraph(
      team.taskListId,
      this.options.configDir
    ).listTasks();
    const members = team.members.map((member): TeamMemberSnapshot => {
      if (member.name === 'team-lead') {
        return { ...member, status: 'leader' };
      }
      const session = member.agentId
        ? this.manager.getAgent(member.agentId)
        : undefined;
      return {
        ...member,
        status: session ? mapAgentStatus(session) : 'unknown',
        result: session?.result,
        stats: session?.stats,
        worktreePath: session?.worktree?.workspaceRoot,
      };
    });
    const workerStatuses = members
      .filter((member) => member.status !== 'leader')
      .map((member) => member.status);
    const hasRunningWorker = workerStatuses.some(
      (memberStatus) => memberStatus === 'running'
    );
    const hasFailedWorker = workerStatuses.some(
      (memberStatus) => memberStatus === 'failed' || memberStatus === 'cancelled'
    );
    const allWorkersCompleted =
      workerStatuses.length > 0 &&
      workerStatuses.every((memberStatus) => memberStatus === 'completed');
    const allTasksCompleted =
      tasks.length === 0 || tasks.every((task) => task.status === 'completed');
    const status: TeamSnapshot['status'] = team.deletedAt
      ? 'deleted'
      : hasRunningWorker
        ? 'running'
        : hasFailedWorker || (allWorkersCompleted && !allTasksCompleted)
          ? 'failed'
          : allWorkersCompleted && allTasksCompleted
            ? 'completed'
            : 'idle';
    return {
      name: team.name,
      description: team.description,
      status,
      leadAgentId: team.leadAgentId,
      leadSessionId: team.leadSessionId,
      workspaceRoot: team.workspaceRoot,
      peerMessagingEnabled: team.peerMessagingEnabled,
      createdAt: team.createdAt,
      updatedAt: team.updatedAt,
      deletedAt: team.deletedAt,
      members,
      tasks,
    };
  }

  private async requireTeam(name: string): Promise<AgentTeam> {
    const team = await this.store.loadTeam(name);
    if (!team) throw new Error(`Team not found: ${name}`);
    return team;
  }

  private async requireOwnedTeam(name: string, owner?: SessionRef): Promise<AgentTeam> {
    const team = await this.requireTeam(name);
    this.assertOwner(team, owner);
    return team;
  }

  private ensureSubagentsLoaded(): void {
    if (this.options.subagentRegistry.getAllNames().length === 0) {
      this.options.subagentRegistry.loadFromStandardLocations();
    }
  }

  private validateMembers(members: readonly TeamMemberInput[]): void {
    if (members.length > MAX_TEAM_MEMBERS) {
      throw new Error(`Agent Team cannot exceed ${MAX_TEAM_MEMBERS} teammates`);
    }
    const names = new Set<string>();
    for (const member of members) {
      const name = TeamStore.sanitizeName(member.name);
      if (!name) throw new Error('Teammate name must contain a letter or number');
      if (name === 'team-lead') {
        throw new Error('Teammate name is reserved: team-lead');
      }
      if (names.has(name)) throw new Error(`Duplicate teammate name: ${member.name}`);
      names.add(name);
      const prompt = member.prompt.trim();
      if (prompt.length < 10 || prompt.length > 32 * 1024) {
        throw new Error('Teammate prompt must contain 10-32768 characters');
      }
      if (!this.options.subagentRegistry.getSubagent(member.subagentType)) {
        throw new Error(`Invalid subagent type: ${member.subagentType}`);
      }
    }
  }

  private validateTasks(
    tasks: readonly TeamTaskInput[],
    members: readonly TeamMember[]
  ): void {
    if (tasks.length > MAX_TEAM_TASKS) {
      throw new Error(`Agent Team cannot exceed ${MAX_TEAM_TASKS} tasks`);
    }
    const memberNames = new Set(
      members.flatMap((member) => [member.id, member.agentId, member.name])
    );
    for (const [index, task] of tasks.entries()) {
      if (task.assignedTo && !memberNames.has(task.assignedTo)) {
        throw new Error(`Unknown assigned teammate: ${task.assignedTo}`);
      }
      const currentId = String(index + 1);
      for (const dependencyId of task.dependsOn ?? []) {
        const dependency = Number(dependencyId);
        if (
          !Number.isSafeInteger(dependency) ||
          dependency < 1 ||
          dependency >= Number(currentId)
        ) {
          throw new Error(
            `Task ${currentId} depends on unavailable task ${dependencyId}`
          );
        }
      }
    }
  }

  private resolveSender(
    team: AgentTeam,
    actorAgentId: string | undefined,
    owner: SessionRef | undefined
  ): TeamMember {
    if (actorAgentId) {
      const member = findMember(team, actorAgentId);
      if (member && member.name !== 'team-lead') {
        this.assertActorAccess(team, owner, actorAgentId, member);
        return member;
      }
      if (actorAgentId !== team.leadSessionId) {
        throw new Error('Team sender is unavailable');
      }
    }
    this.assertOwner(team, owner);
    const lead = team.members.find((member) => member.name === 'team-lead');
    if (!lead) throw new Error('Team lead is unavailable');
    return lead;
  }

  private assertActorAccess(
    team: AgentTeam,
    owner: SessionRef | undefined,
    actorAgentId: string | undefined,
    member: TeamMember
  ): void {
    if (owner && ownsTeam(team, owner)) return;
    if (!actorAgentId || member.agentId !== actorAgentId) {
      throw new Error(`Team not found: ${team.name}`);
    }
    const session = this.manager.getAgent(actorAgentId, teamOwner(team));
    if (
      !session ||
      session.teamId !== team.name ||
      session.parentSessionId !== team.leadSessionId
    ) {
      throw new Error(`Team not found: ${team.name}`);
    }
  }

  private assertOwner(team: AgentTeam, owner: SessionRef | undefined): void {
    if (!owner || !ownsTeam(team, owner)) {
      throw new Error(`Team not found: ${team.name}`);
    }
  }

  private async deliverPendingMessages(
    team: AgentTeam,
    member: TeamMember,
    agentId: string
  ): Promise<void> {
    const mailbox = new TeamMailbox(team.name, this.options.configDir);
    const pending = await mailbox.listPending(agentId);
    for (const message of pending) {
      const delivered = await this.manager.enqueueSteering(
        agentId,
        formatTeamMessage(message),
        teamOwner(team)
      );
      if (delivered) await mailbox.markDelivered([message.id]);
    }
  }

  private buildMemberPrompt(team: AgentTeam, member: TeamMember): string {
    return `
You are ${member.name}, a teammate in Blade agent team "${team.name}".

Team purpose: ${team.description || 'Coordinate parallel agent work'}.
Shared task graph: ${team.taskListId}
Workspace: ${team.workspaceRoot}
Peer messaging: ${team.peerMessagingEnabled ? 'enabled' : 'disabled'}

Use TeamTaskClaim to atomically claim available work when your assignment is complete.
Use SendMessage for direct or broadcast teammate communication and TeamInbox to inspect durable messages.
Never create a nested team. Work independently, keep task state current, and return a concise result for the team lead.

Assignment:
${member.prompt || member.description}
`.trim();
  }

  private publish<T extends TeamEventType>(
    owner: SessionRef,
    type: T,
    properties: TeamEventProperties[T]
  ): void {
    Bus.publish(owner, type, { ...properties });
  }
}

function findMember(team: AgentTeam, idOrName: string): TeamMember | undefined {
  return team.members.find(
    (member) =>
      member.id === idOrName || member.agentId === idOrName || member.name === idOrName
  );
}

function requireMember(members: readonly TeamMember[], idOrName: string): TeamMember {
  const member = members.find(
    (candidate) =>
      candidate.id === idOrName ||
      candidate.agentId === idOrName ||
      candidate.name === idOrName
  );
  if (!member) throw new Error(`Unknown assigned teammate: ${idOrName}`);
  return member;
}

function ownsTeam(team: AgentTeam, owner: SessionRef): boolean {
  return (
    team.leadSessionId === owner.sessionId && team.workspaceRoot === owner.projectPath
  );
}

function teamOwner(team: AgentTeam): SessionRef | undefined {
  return team.leadSessionId && team.workspaceRoot
    ? { sessionId: team.leadSessionId, projectPath: team.workspaceRoot }
    : undefined;
}

function mapAgentStatus(session: AgentSession): TeamMemberStatus {
  return session.status;
}

function defaultIsolation(config: SubagentConfig): 'none' | 'worktree' {
  if (!config.tools || config.tools.length === 0) return 'worktree';
  return config.tools.some((tool) => WRITE_TOOLS.has(tool)) ? 'worktree' : 'none';
}
