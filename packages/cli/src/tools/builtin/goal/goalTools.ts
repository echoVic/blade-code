import { GoalStore } from '../../../goals/GoalStore.js';
import {
  getGoalTaskListId,
  readGoalExecutionFrontier,
} from '../../../goals/executionFrontier.js';
import { formatGoalSummary } from '../../../goals/prompts.js';
import { StringEnum, Type } from '../../../schema/index.js';
import { getBladeStorageRoot } from '../../../context/storage/pathUtils.js';
import { createTool } from '../../core/createTool.js';
import type { ExecutionContext, ToolResult } from '../../types/index.js';
import { ToolErrorType, ToolKind } from '../../types/index.js';

interface GoalToolOptions {
  sessionId: string;
  workspaceRoot: string;
  configDir?: string;
}

function getStore(context: ExecutionContext, options: GoalToolOptions): GoalStore {
  return new GoalStore(
    context.workspaceRoot ?? options.workspaceRoot,
    context.sessionId ?? options.sessionId
  );
}

function failure(error: unknown): ToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    success: false,
    llmContent: { error: message },
    error: {
      type: ToolErrorType.EXECUTION_ERROR,
      message,
      code: 'GOAL_OPERATION_FAILED',
      details: error,
    },
    metadata: { summary: message },
  };
}

export function createGoalTools(options: GoalToolOptions) {
  const configDir = options.configDir ?? getBladeStorageRoot();
  const getGoal = createTool({
    name: 'GetGoal',
    displayName: 'Get Goal',
    kind: ToolKind.ReadOnly,
    isConcurrencySafe: true,
    isRetrySafe: true,
    schema: Type.Object({}),
    description: {
      short: 'Read the persisted goal for the current session',
      long: 'Returns the objective, status, token budget, usage, elapsed time, and continuation count.',
    },
    async execute(_params, context: ExecutionContext): Promise<ToolResult> {
      try {
        const goal = await getStore(context, options).get();
        return {
          success: true,
          llmContent: { goal },
          metadata: {
            summary: goal ? formatGoalSummary(goal) : 'No goal is active',
          },
        };
      } catch (error) {
        return failure(error);
      }
    },
    category: 'Goal tools',
    tags: ['goal', 'session', 'planning'],
    abstractPermissionRule: () => '*',
  });

  const createGoal = createTool({
    name: 'CreateGoal',
    displayName: 'Create Goal',
    kind: ToolKind.ReadOnly,
    isConcurrencySafe: false,
    schema: Type.Object({
      objective: Type.String({
        minLength: 1,
        description: 'Concrete objective explicitly requested',
      }),
      tokenBudget: Type.Optional(
        Type.Integer({
          minimum: 1,
          description: 'Optional positive token budget, only when explicitly requested',
        })
      ),
    }),
    description: {
      short: 'Create a persisted active goal for the current session',
      long: 'Use only when the user explicitly requests goal mode. Fails while an unfinished goal exists.',
      important: [
        'Do not infer a goal from an ordinary coding request.',
        'Do not set tokenBudget unless the user explicitly requests one.',
      ],
    },
    async execute(params, context: ExecutionContext): Promise<ToolResult> {
      try {
        const goal = await getStore(context, options).create(params);
        return {
          success: true,
          llmContent: { goal },
          metadata: { summary: `Goal started: ${goal.objective}` },
        };
      } catch (error) {
        return failure(error);
      }
    },
    category: 'Goal tools',
    tags: ['goal', 'session', 'planning'],
    extractSignatureContent: (params) => params.objective,
    abstractPermissionRule: () => '*',
  });

  const updateGoal = createTool({
    name: 'UpdateGoal',
    displayName: 'Update Goal',
    kind: ToolKind.ReadOnly,
    isConcurrencySafe: false,
    schema: Type.Object({
      status: StringEnum(['complete', 'blocked']),
      reason: Type.Optional(
        Type.String({
          description: 'Concrete blocker; required when status is blocked',
        })
      ),
    }),
    description: {
      short: 'Request verified goal completion or mark the goal blocked',
      long:
        'Use complete only after the full objective and required verification are ' +
        'finished. Complete creates a host-verified candidate; only a fresh ' +
        'independent PASS can finalize it. Use blocked only when external ' +
        'intervention is required.',
      important: [
        'Do not mark complete because a single turn ended.',
        'A completion request is not completion; continue if the host verifier reports gaps.',
        'Do not use blocked for difficult, slow, or uncertain work.',
      ],
    },
    async execute(params, context: ExecutionContext): Promise<ToolResult> {
      try {
        const store = getStore(context, options);
        let goal: Awaited<ReturnType<GoalStore['requestCompletion']>>;
        if (params.status === 'complete') {
          const current = await store.get();
          if (!current) throw new Error('Session has no goal');
          const { frontier } = await readGoalExecutionFrontier(current, { configDir });
          if (frontier.pending > 0 || frontier.inProgress > 0 || frontier.blocked > 0) {
            throw new Error(
              `Goal has unfinished tasks (${frontier.completed}/${frontier.total} completed); update the goal-scoped task list before requesting completion`
            );
          }
          goal = await store.requestCompletion();
        } else {
          goal = await store.block(params.reason ?? '');
        }
        return {
          success: true,
          llmContent: {
            goal,
            remainingTokens:
              goal.tokenBudget === undefined
                ? null
                : Math.max(0, goal.tokenBudget - goal.tokensUsed),
          },
          metadata: {
            summary: formatGoalSummary(goal),
            goalStatus: goal.status,
            ...(params.status === 'complete' && goal.completionVerification
              ? {
                  goalCompletionRequested: true,
                  goalId: goal.goalId,
                  goalObjective: goal.objective,
                  goalCompletionAttempt: goal.completionVerification.attempt,
                  goalCompletionRequestedAt: goal.completionVerification.requestedAt,
                }
              : {}),
          },
        };
      } catch (error) {
        return failure(error);
      }
    },
    category: 'Goal tools',
    tags: ['goal', 'session', 'planning'],
    extractSignatureContent: (params) => params.status,
    abstractPermissionRule: () => '*',
  });

  return [getGoal, createGoal, updateGoal];
}
