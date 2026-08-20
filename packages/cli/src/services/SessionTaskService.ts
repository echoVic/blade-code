import path from 'node:path';
import type {
  SessionTaskDispatch,
  SessionTaskIsolation,
  SessionTaskKind,
  SessionTaskPriority,
  SessionTaskRetryRef,
  SessionTaskWorktree,
} from '../context/types.js';
import { worktreeManager } from '../worktree/WorktreeManager.js';
import { type SessionMetadata, SessionService } from './SessionService.js';

export interface CreateSessionTaskInput {
  sessionId: string;
  prompt: string;
  title?: string;
  taskPriority?: SessionTaskPriority;
  taskKind?: SessionTaskKind;
  taskDueAt?: string;
  sourceProjectPath: string;
  isolation: SessionTaskIsolation;
  dispatch?: SessionTaskDispatch;
  retriedFrom?: SessionTaskRetryRef;
}

export interface CreatedSessionTask {
  metadata: SessionMetadata;
  taskWorktree?: SessionTaskWorktree;
}

function taskTitle(prompt: string): string {
  const normalized = prompt.replace(/\s+/g, ' ').trim();
  return normalized.length <= 72 ? normalized : `${normalized.slice(0, 69)}...`;
}

function taskPromptSummary(prompt: string): string {
  const normalized = prompt.replace(/\s+/g, ' ').trim();
  return normalized.length <= 500 ? normalized : `${normalized.slice(0, 497)}...`;
}

function taskWorktreeName(sessionId: string): string {
  return `task/${sessionId.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 40)}`;
}

export class SessionTaskService {
  static async createSessionTask(
    input: CreateSessionTaskInput
  ): Promise<CreatedSessionTask> {
    if (!input.prompt.trim()) {
      throw new Error('Task prompt must not be blank');
    }
    if (!path.isAbsolute(input.sourceProjectPath)) {
      throw new Error('Task source project path must be absolute');
    }
    const sourceProjectPath = path.resolve(input.sourceProjectPath);
    let taskWorktree: SessionTaskWorktree | undefined;
    try {
      taskWorktree =
        input.isolation === 'worktree'
          ? await worktreeManager.enter({
              sessionId: input.sessionId,
              workspaceRoot: sourceProjectPath,
              name: taskWorktreeName(input.sessionId),
            })
          : undefined;
      const metadata = await SessionService.createSessionMetadata(
        input.sessionId,
        taskWorktree?.workspaceRoot ?? sourceProjectPath,
        {
          title: input.title?.trim() || taskTitle(input.prompt),
          taskPromptSummary: taskPromptSummary(input.prompt),
          taskPriority: input.taskPriority,
          taskKind: input.taskKind,
          taskDueAt: input.taskDueAt,
          taskDispatch: input.dispatch,
          taskModelId: input.dispatch?.modelId,
          selectedModelId: input.dispatch?.modelId,
          permissionMode: input.dispatch?.permissionMode,
          reasoningEffort: input.dispatch?.reasoningEffort,
          serviceTier: input.dispatch?.serviceTier,
          responseVerbosity: input.dispatch?.responseVerbosity,
          communicationStyle: input.dispatch?.communicationStyle,
          communicationStyleDigest: input.dispatch?.communicationStyleDigest,
          projectInstructionsDigest: input.dispatch?.projectInstructionsDigest,
          taskRetriedFrom: input.retriedFrom,
          taskIsolation: input.isolation,
          taskSourceProjectPath: sourceProjectPath,
          taskWorktree,
        }
      );
      return { metadata, taskWorktree };
    } catch (error) {
      if (taskWorktree) {
        await worktreeManager
          .exit({
            sessionId: input.sessionId,
            action: 'remove',
            discardChanges: true,
          })
          .catch(() => undefined);
      }
      throw error;
    }
  }
}
