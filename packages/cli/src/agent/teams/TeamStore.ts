import * as fs from 'fs/promises';
import * as path from 'path';

export type TeamMemberStatus =
  | 'leader'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'unknown';

export interface TeamMember {
  id: string;
  name: string;
  subagentType: string;
  description: string;
  prompt?: string;
  agentId?: string;
  status: TeamMemberStatus;
  joinedAt: number;
  completedAt?: number;
}

export interface AgentTeam {
  name: string;
  description?: string;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
  leadAgentId: string;
  leadSessionId?: string;
  teamFilePath: string;
  members: TeamMember[];
}

interface TeamFile {
  teams?: AgentTeam[];
}

export class TeamStore {
  private readonly teamsDir: string;

  private constructor(configDir: string) {
    this.teamsDir = path.join(configDir, 'teams');
  }

  static getInstance(configDir: string): TeamStore {
    return new TeamStore(configDir);
  }

  static sanitizeName(name: string): string {
    return name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80);
  }

  getTeamFilePath(name: string): string {
    return path.join(this.teamsDir, TeamStore.sanitizeName(name), 'config.json');
  }

  async createTeam(input: {
    name: string;
    description?: string;
    leadAgentType?: string;
    leadSessionId?: string;
    members: TeamMember[];
  }): Promise<AgentTeam> {
    const name = await this.getUniqueTeamName(input.name);
    const now = Date.now();
    const teamFilePath = this.getTeamFilePath(name);
    const team: AgentTeam = {
      name,
      description: input.description,
      createdAt: now,
      updatedAt: now,
      leadAgentId: `team-lead-${name}`,
      leadSessionId: input.leadSessionId,
      teamFilePath,
      members: [
        {
          id: `team-lead-${name}`,
          name: 'team-lead',
          subagentType: input.leadAgentType || 'team-lead',
          description: 'Team lead for coordinating the agent team',
          status: 'leader',
          joinedAt: now,
        },
        ...input.members,
      ],
    };

    await this.saveTeam(team);
    return team;
  }

  async loadTeam(name: string): Promise<AgentTeam | undefined> {
    try {
      const raw = await fs.readFile(this.getTeamFilePath(name), 'utf-8');
      return normalizeTeam(JSON.parse(raw));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(`Failed to load team ${name}:`, error);
      }
      return undefined;
    }
  }

  async saveTeam(team: AgentTeam): Promise<void> {
    const filePath = this.getTeamFilePath(team.name);
    await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o755 });
    await fs.writeFile(
      filePath,
      JSON.stringify(
        { ...team, teamFilePath: filePath, updatedAt: Date.now() },
        null,
        2
      ),
      'utf-8'
    );
  }

  async listTeams(): Promise<AgentTeam[]> {
    try {
      const entries = await fs.readdir(this.teamsDir, { withFileTypes: true });
      const teams: AgentTeam[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const team = await this.loadTeam(entry.name);
        if (team) teams.push(team);
      }
      return teams.sort((a, b) => b.updatedAt - a.updatedAt);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('Failed to list teams:', error);
      }
      return [];
    }
  }

  async markDeleted(name: string): Promise<AgentTeam | undefined> {
    const team = await this.loadTeam(name);
    if (!team) return undefined;
    const now = Date.now();
    const deletedTeam: AgentTeam = {
      ...team,
      deletedAt: now,
      updatedAt: now,
      members: team.members.map((member) =>
        member.status === 'running'
          ? { ...member, status: 'cancelled', completedAt: member.completedAt || now }
          : member
      ),
    };
    await this.saveTeam(deletedTeam);
    return deletedTeam;
  }

  private async getUniqueTeamName(name: string): Promise<string> {
    const base = TeamStore.sanitizeName(name);
    if (!base) {
      throw new Error('team_name must contain at least one letter or number');
    }

    let candidate = base;
    let suffix = 2;
    while (await this.loadTeam(candidate)) {
      candidate = `${base}-${suffix}`;
      suffix += 1;
    }
    return candidate;
  }
}

function normalizeTeam(data: unknown): AgentTeam | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const team = data as Partial<AgentTeam>;
  if (!team.name || !Array.isArray(team.members)) return undefined;

  return {
    name: team.name,
    description: team.description,
    createdAt: typeof team.createdAt === 'number' ? team.createdAt : Date.now(),
    updatedAt: typeof team.updatedAt === 'number' ? team.updatedAt : Date.now(),
    deletedAt: typeof team.deletedAt === 'number' ? team.deletedAt : undefined,
    leadAgentId: team.leadAgentId || `team-lead@${team.name}`,
    leadSessionId: team.leadSessionId,
    teamFilePath: team.teamFilePath || '',
    members: team.members.map((member) => ({
      id: member.id,
      name: member.name,
      subagentType: member.subagentType,
      description: member.description,
      prompt: member.prompt,
      agentId: member.agentId,
      status: member.status,
      joinedAt: member.joinedAt,
      completedAt: member.completedAt,
    })),
  };
}

export type { TeamFile };
