import { GoalStore } from '../../../goals/GoalStore.js';
import { formatGoalSummary } from '../../../goals/prompts.js';
import { StringEnum, Type } from '../../../schema/index.js';
import { createTool } from '../../core/createTool.js';
import type { ExecutionContext, ToolResult } from '../../types/index.js';
import { ToolErrorType, ToolKind } from '../../types/index.js';

interface GoalToolOptions {
  sessionId: string;
  workspaceRoot: string;
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
    },
    metadata: { summary: message },
  };
}

export function createGoalTools(options: GoalToolOptions) {
  const getGoal = createTool({
    name: 'GetGoal',
    displayName: 'Get Goal',
    kind: ToolKind.ReadOnly,
    isConcurrencySafe: true,
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
      short: 'Mark the persisted goal complete or blocked',
      long: 'Use complete only after the full objective and required verification are finished. Use blocked only when external intervention is required.',
      important: [
        'Do not mark complete because a single turn ended.',
        'Do not use blocked for difficult, slow, or uncertain work.',
      ],
    },
    async execute(params, context: ExecutionContext): Promise<ToolResult> {
      try {
        const store = getStore(context, options);
        const goal =
          params.status === 'complete'
            ? await store.complete()
            : await store.block(params.reason ?? '');
        return {
          success: true,
          llmContent: {
            goal,
            remainingTokens:
              goal.tokenBudget === undefined
                ? null
                : Math.max(0, goal.tokenBudget - goal.tokensUsed),
          },
          metadata: { summary: formatGoalSummary(goal) },
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
