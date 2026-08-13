import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface GoalFinalizationPtyEvidence {
  success: true;
  sawInitial: true;
  sawCompleteGoal: true;
  sawFollowup: true;
  output: string;
}

export async function runGoalFinalizationPtyDriver(input: {
  workspace: string;
  storageRoot: string;
  home: string;
  sessionId: string;
  expectedInitial: string;
  followupPrompt: string;
  expectedFollowup: string;
  secret: string;
  timeoutMs?: number;
}): Promise<GoalFinalizationPtyEvidence> {
  const runner = path.resolve(import.meta.dirname, 'goalFinalizationPtyRunner.ts');
  const cliEntry = path.resolve(import.meta.dirname, '../../dist/blade.js');
  const env = Object.fromEntries(
    Object.entries({
      ...process.env,
      HOME: input.home,
      BLADE_STORAGE_ROOT: input.storageRoot,
      BLADE_AUTO_MEMORY: '0',
      BLADE_TELEMETRY_DISABLED: '1',
      TERM: 'xterm-256color',
      BLADE_GOAL_FINALIZATION_PTY_CLI_ENTRY: cliEntry,
      BLADE_GOAL_FINALIZATION_PTY_WORKSPACE: input.workspace,
      BLADE_GOAL_FINALIZATION_PTY_SESSION_ID: input.sessionId,
      BLADE_GOAL_FINALIZATION_PTY_INITIAL: input.expectedInitial,
      BLADE_GOAL_FINALIZATION_PTY_FOLLOWUP_PROMPT: input.followupPrompt,
      BLADE_GOAL_FINALIZATION_PTY_FOLLOWUP: input.expectedFollowup,
      BLADE_GOAL_FINALIZATION_PTY_SECRET: input.secret,
    }).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  );
  const result = await execFileAsync('bun', [runner], {
    cwd: path.resolve(import.meta.dirname, '../..'),
    env,
    timeout: input.timeoutMs ?? 240_000,
    maxBuffer: 64 * 1024,
    killSignal: 'SIGKILL',
  });
  const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
  if (
    parsed.success !== true ||
    parsed.sawInitial !== true ||
    parsed.sawCompleteGoal !== true ||
    parsed.sawFollowup !== true ||
    typeof parsed.output !== 'string'
  ) {
    throw new Error(
      `Goal finalization PTY evidence is incomplete: ${String(
        parsed.error ?? parsed.output ?? 'unknown'
      )}`
    );
  }
  if (parsed.output.includes(input.secret)) {
    throw new Error('Goal finalization PTY evidence contains Provider credentials');
  }
  return parsed as unknown as GoalFinalizationPtyEvidence;
}
