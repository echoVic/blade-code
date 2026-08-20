import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  finalAssistantText,
  findSessionTranscript,
  readSessionEvents,
} from '../integration/real-api/sessionForkTrajectoryHarness.js';

export const TOOL_ADMISSION_CALL_IDS = [
  'call-1',
  'call-2',
  'call-3',
  'call-4',
] as const;

async function directoryEntries(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory)).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function waitFor(
  predicate: () => Promise<boolean>,
  message: string,
  timeoutMs = 90_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message, { cause: lastError });
}

function equalEntries(actual: readonly string[], expected: readonly string[]): boolean {
  return (
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

async function assertState(
  stateDir: string,
  expectedStarted: readonly string[],
  expectedActive: readonly string[],
  expectedCompleted: readonly string[]
): Promise<void> {
  let lastState: {
    started: string[];
    active: string[];
    completed: string[];
  } = { started: [], active: [], completed: [] };
  try {
    await waitFor(
      async () => {
        const [started, active, completed] = await Promise.all([
          directoryEntries(path.join(stateDir, 'started')),
          directoryEntries(path.join(stateDir, 'active')),
          directoryEntries(path.join(stateDir, 'completed')),
        ]);
        lastState = { started, active, completed };
        return (
          equalEntries(started, expectedStarted) &&
          equalEntries(active, expectedActive) &&
          equalEntries(completed, expectedCompleted)
        );
      },
      'Tool admission fixture did not reach the expected stable state',
      5_000
    );
  } catch (error) {
    throw new Error(
      `Unexpected tool admission state: ${JSON.stringify({
        ...lastState,
        expectedStarted,
        expectedActive,
        expectedCompleted,
      })}`,
      { cause: error }
    );
  }
}

async function release(stateDir: string, callId: string): Promise<void> {
  const releaseDir = path.join(stateDir, 'release');
  await mkdir(releaseDir, { recursive: true });
  await writeFile(path.join(releaseDir, callId), 'release');
}

function countCanonicalBashCalls(storageRoot: string, sessionId: string): number {
  const transcript = findSessionTranscript(storageRoot, sessionId);
  return readSessionEvents(transcript).filter(
    (event) =>
      event.type === 'part_created' &&
      event.data.partType === 'tool_call' &&
      event.data.payload !== null &&
      typeof event.data.payload === 'object' &&
      !Array.isArray(event.data.payload) &&
      event.data.payload.toolName === 'Bash'
  ).length;
}

export async function driveToolAdmissionFixture(input: {
  storageRoot: string;
  sessionId: string;
  stateDir: string;
  waitForQueuedEvidence: () => Promise<void>;
}): Promise<void> {
  await waitFor(
    async () => countCanonicalBashCalls(input.storageRoot, input.sessionId) === 4,
    'The Provider did not commit four canonical Bash calls'
  );
  await input.waitForQueuedEvidence();
  await waitFor(
    async () =>
      (await directoryEntries(path.join(input.stateDir, 'started'))).length >= 2,
    'The first two admitted Bash calls did not start'
  );
  const firstWave = await directoryEntries(path.join(input.stateDir, 'started'));
  if (firstWave.length !== 2) {
    throw new Error(`Expected exactly two initially admitted calls, got ${firstWave}`);
  }
  await assertState(input.stateDir, firstWave, firstWave, []);

  await release(input.stateDir, firstWave[0]);
  await waitFor(
    async () =>
      (await directoryEntries(path.join(input.stateDir, 'started'))).length >= 3,
    'Releasing the first call did not admit exactly one successor'
  );
  const thirdWave = await directoryEntries(path.join(input.stateDir, 'started'));
  const thirdCall = thirdWave.find((callId) => !firstWave.includes(callId));
  if (!thirdCall || thirdWave.length !== 3) {
    throw new Error(`Expected one newly admitted third call, got ${thirdWave}`);
  }
  await assertState(input.stateDir, thirdWave, [firstWave[1], thirdCall].sort(), [
    firstWave[0],
  ]);

  await release(input.stateDir, firstWave[1]);
  await waitFor(
    async () =>
      (await directoryEntries(path.join(input.stateDir, 'started'))).length >= 4,
    'Releasing the second call did not admit exactly one successor'
  );
  const fourthWave = await directoryEntries(path.join(input.stateDir, 'started'));
  const remainingCalls = fourthWave.filter((callId) => !firstWave.includes(callId));
  await assertState(input.stateDir, fourthWave, remainingCalls, [...firstWave].sort());

  await Promise.all(remainingCalls.map((callId) => release(input.stateDir, callId)));
  await waitFor(
    async () =>
      (await directoryEntries(path.join(input.stateDir, 'completed'))).length === 4,
    'The admitted Bash calls did not all complete'
  );
  await assertState(
    input.stateDir,
    [...TOOL_ADMISSION_CALL_IDS],
    [],
    [...TOOL_ADMISSION_CALL_IDS]
  );
}

export async function waitForToolAdmissionSessionCompletion(
  storageRoot: string,
  sessionId: string,
  finalMarker: string
): Promise<void> {
  await waitFor(async () => {
    const events = readSessionEvents(findSessionTranscript(storageRoot, sessionId));
    const results = events.filter(
      (event) =>
        event.type === 'part_created' &&
        event.data.partType === 'tool_result' &&
        event.data.payload !== null &&
        typeof event.data.payload === 'object' &&
        !Array.isArray(event.data.payload) &&
        event.data.payload.toolName === 'Bash'
    );
    return (
      results.length === 4 &&
      events.filter((event) => event.type === 'turn_completed').length === 1 &&
      finalAssistantText(events) === finalMarker
    );
  }, 'Tool admission Session did not persist four results, one completed turn, and the final marker');
}
