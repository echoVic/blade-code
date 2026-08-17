import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SessionRuntime } from '../../../src/agent/runtime/SessionRuntime.js';

export interface RootTurnAutoResumeFixture {
  sessionId: string;
  marker: string;
  expectedResponse: string;
  markerPath: string;
  prompt: string;
  inputMessageId: string;
  orphanToolCallId: string;
}

export async function seedRootTurnAutoResumeFixture(input: {
  workspace: string;
  sessionId: string;
  marker: string;
  modelId?: string;
}): Promise<RootTurnAutoResumeFixture> {
  const markerPath = path.join(input.workspace, 'root-turn-marker.txt');
  const responsePrefix = 'ROOT_TURN_RECOVERED_';
  const expectedResponse = `${responsePrefix}${input.marker}`;
  const prompt = [
    'Resume this interrupted root turn from durable state.',
    'The previous Write may already have created root-turn-marker.txt.',
    'When its process-restart tool receipt says side effects are uncertain,',
    'call Read exactly once on root-turn-marker.txt before deciding what to do.',
    `If the exact trimmed content is ${input.marker}, do not call Write, Edit,`,
    'ApplyPatch, or Bash. Reply with exactly one token formed by concatenating',
    `these quoted segments without separators: ${JSON.stringify(
      responsePrefix
    )} ${JSON.stringify(input.marker)}.`,
  ].join(' ');
  if (prompt.includes(expectedResponse)) {
    throw new Error('Root-turn expected response must not contaminate its prompt');
  }
  await writeFile(markerPath, `${input.marker}\n`);

  const runtime = await SessionRuntime.create({
    sessionId: input.sessionId,
    workspaceRoot: input.workspace,
    ...(input.modelId ? { modelId: input.modelId } : {}),
  });
  try {
    const prepared = await runtime.prepareInputTurn(prompt);
    if (!prepared.accepted) {
      throw new Error('Root-turn fixture input was not durably accepted');
    }
    const contextManager = runtime.getExecutionEngine().getContextManager();
    await contextManager.saveMessage(input.sessionId, 'user', prompt, null, {
      inboxMessageId: prepared.messageId,
    });
    const orphanToolCallId = await contextManager.saveToolUse(
      input.sessionId,
      'Write',
      {
        file_path: markerPath,
        content: `${input.marker}\n`,
      }
    );
    return {
      sessionId: input.sessionId,
      marker: input.marker,
      expectedResponse,
      markerPath,
      prompt,
      inputMessageId: prepared.messageId,
      orphanToolCallId,
    };
  } finally {
    await runtime.dispose();
  }
}
