import { GoalStore } from '../goals/GoalStore.js';
import { formatGoalSummary } from '../goals/prompts.js';
import type { GoalSnapshot } from '../goals/types.js';
import type { SlashCommand, SlashCommandContext, SlashCommandResult } from './types.js';

function storeFor(context: SlashCommandContext): GoalStore {
  if (!context.sessionId) {
    throw new Error('/goal requires a session');
  }
  return new GoalStore(context.workspaceRoot ?? context.cwd, context.sessionId);
}

function parseCreateArgs(args: string[]): {
  objective: string;
  tokenBudget?: number;
} {
  const remaining = [...args];
  let tokenBudget: number | undefined;
  const budgetIndex = remaining.lastIndexOf('--budget');
  if (budgetIndex >= 0) {
    const raw = remaining[budgetIndex + 1];
    if (!raw || !/^[1-9]\d*$/.test(raw)) {
      throw new Error('--budget requires a positive integer');
    }
    tokenBudget = Number(raw);
    remaining.splice(budgetIndex, 2);
  }
  const objective = remaining.join(' ').trim();
  if (!objective) {
    throw new Error('Usage: /goal <objective> [--budget <tokens>]');
  }
  return { objective, tokenBudget };
}

function goalResult(
  goal: GoalSnapshot,
  action?: 'start_goal' | 'resume_goal'
): SlashCommandResult {
  return {
    success: true,
    message: formatGoalSummary(goal),
    content: formatGoalSummary(goal),
    data: {
      ...(action ? { action } : {}),
      goal,
    },
  };
}

async function goalHandler(
  args: string[],
  context: SlashCommandContext
): Promise<SlashCommandResult> {
  try {
    const store = storeFor(context);
    const subcommand = args[0]?.toLowerCase();

    if (!subcommand || subcommand === 'status') {
      const goal = await store.get();
      return goal
        ? goalResult(goal)
        : {
            success: true,
            message: 'No goal is configured for this session.',
            content: 'No goal is configured for this session.',
          };
    }

    if (subcommand === 'clear') {
      const cleared = await store.clear();
      return {
        success: true,
        message: cleared ? 'Goal cleared.' : 'No goal was configured.',
        content: cleared ? 'Goal cleared.' : 'No goal was configured.',
        data: { action: 'goal_cleared', goal: null },
      };
    }

    if (subcommand === 'pause') {
      return goalResult(await store.pause());
    }

    if (subcommand === 'resume') {
      return goalResult(await store.resume(), 'resume_goal');
    }

    if (subcommand === 'edit') {
      const objective = args.slice(1).join(' ').trim();
      if (!objective) throw new Error('Usage: /goal edit <objective>');
      return goalResult(await store.edit(objective), 'resume_goal');
    }

    return goalResult(await store.create(parseCreateArgs(args)), 'start_goal');
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

const goalCommand: SlashCommand = {
  name: 'goal',
  description: '创建并持续执行 session 级目标',
  fullDescription:
    '创建、查看、暂停、恢复、编辑或清除持久化目标。Active goal 会在逻辑 turn 结束后自动续跑。',
  usage: '/goal [<objective> [--budget <tokens>]|status|pause|resume|edit|clear]',
  category: 'agent',
  examples: [
    '/goal migrate the project and run all tests',
    '/goal status',
    '/goal pause',
    '/goal resume',
    '/goal edit finish the migration and update docs',
    '/goal clear',
  ],
  handler: goalHandler,
};

export default goalCommand;
