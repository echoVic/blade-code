import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SessionRuntime } from '../../../src/agent/runtime/SessionRuntime.js';
import { GoalStore } from '../../../src/goals/GoalStore.js';

export interface GoalFinalizationHandoffFixture {
  sessionId: string;
  goalId: string;
  turnId: string;
  inputMessageId: string;
  artifactPath: string;
  artifactMarker: string;
  finalResponse: string;
}

export async function seedGoalFinalizationHandoffFixture(input: {
  workspace: string;
  sessionId: string;
  marker: string;
  modelId?: string;
}): Promise<GoalFinalizationHandoffFixture> {
  const artifactPath = path.join(input.workspace, 'goal-finalization-artifact.txt');
  const artifactMarker = `ARTIFACT_${input.marker}`;
  const finalResponse = `FINAL_${input.marker}`;
  const prompt = [
    'Finish the persisted Goal exactly once.',
    'The artifact and independent verification are already complete.',
    'Do not repeat completed work after a process restart.',
  ].join(' ');
  await writeFile(artifactPath, `${artifactMarker}\n`);

  const runtime = await SessionRuntime.create({
    sessionId: input.sessionId,
    workspaceRoot: input.workspace,
    ...(input.modelId ? { modelId: input.modelId } : {}),
  });
  try {
    const prepared = await runtime.prepareInputTurn(prompt);
    if (!prepared.accepted) {
      throw new Error('Goal finalization fixture input was not durably accepted');
    }
    const contextManager = runtime.getExecutionEngine().getContextManager();
    await contextManager.saveMessage(input.sessionId, 'user', prompt, null, {
      inboxMessageId: prepared.messageId,
    });

    const goal = await runtime.createGoal({
      objective: `Keep ${path.basename(artifactPath)} equal to ${artifactMarker}.`,
    });
    const preparedFrontier = await runtime.prepareGoalContinuation(goal);
    if (!preparedFrontier.ok) {
      throw new Error(
        `Goal frontier fixture preparation failed: ${preparedFrontier.error.message}`
      );
    }
    const goalStore = new GoalStore(input.workspace, input.sessionId);
    await goalStore.requestCompletion();
    const passed = await goalStore.recordCompletionVerification({
      verdict: 'pass',
      verifierSessionId: `verifier-${input.marker.toLowerCase()}`,
      summary: 'The artifact and requested final response were verified.',
      evidenceSha256: 'a'.repeat(64),
    });
    const verification = passed.completionVerification;
    if (!verification?.verifierSessionId || !verification.evidenceSha256) {
      throw new Error('Goal finalization fixture verification was not persisted');
    }
    await contextManager.saveMessage(
      input.sessionId,
      'assistant',
      finalResponse,
      null,
      {
        turnFinalization: {
          turnId: prepared.handle.id,
          inputMessageIds: [prepared.messageId],
          turnsCount: 3,
          toolCallsCount: 2,
          durationMs: 1200,
          goalFinalization: {
            goalId: goal.goalId,
            verificationAttempt: verification.attempt,
            verifierSessionId: verification.verifierSessionId,
            evidenceSha256: verification.evidenceSha256,
            goalUpdatedAt: passed.updatedAt,
          },
        },
      }
    );

    return {
      sessionId: input.sessionId,
      goalId: goal.goalId,
      turnId: prepared.handle.id,
      inputMessageId: prepared.messageId,
      artifactPath,
      artifactMarker,
      finalResponse,
    };
  } finally {
    await runtime.dispose();
  }
}
