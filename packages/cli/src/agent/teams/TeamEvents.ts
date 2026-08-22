import type { MessagePersistenceMetadata } from '../../context/types.js';
import type { AgentSession } from '../subagents/AgentSessionStore.js';
import type { TeamMember } from './TeamStore.js';
import type { TeamTask } from './TeamTaskGraph.js';

export interface TeamEventProperties {
  'team.created': {
    teamName: string;
  };
  'team.member.spawned': {
    teamName: string;
    member: TeamMember;
  };
  'team.member.completed': {
    teamName: string;
    memberId: string;
    status: AgentSession['status'];
    result?: AgentSession['result'];
  };
  'team.task.claimed': {
    teamName: string;
    task: TeamTask;
    memberId: string;
  };
  'team.task.unblocked': {
    teamName: string;
    task: TeamTask;
  };
  'team.message.sent': {
    teamName: string;
    from: string;
    to: string;
    messageIds: string[];
  };
  'team.message.received': {
    teamName: string;
    messageId: string;
    content: string;
    metadata: MessagePersistenceMetadata;
  };
  'team.completed': {
    teamName: string;
    status: 'completed' | 'failed';
  };
  'team.deleted': {
    teamName: string;
    reason?: 'startup_failed';
  };
}

export type TeamEventType = keyof TeamEventProperties;
