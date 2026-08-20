import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { SessionEvent } from '../../src/context/types.js';
import {
  extractDurableToolTrace,
  findSessionTranscript,
  readSessionEvents,
} from '../integration/real-api/sessionForkTrajectoryHarness.js';

export interface ForegroundCommandHandoffFixture {
  stateDir: string;
  nonce: string;
  marker: string;
  command: string;
  prompt: string;
  independentPath: string;
  beforeMarker: string;
  afterMarker: string;
}

export interface ForegroundCommandHandoffEvidence {
  shellId: string;
  pid: number;
  events: SessionEvent[];
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
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

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readEvents(storageRoot: string, sessionId: string): SessionEvent[] {
  return readSessionEvents(findSessionTranscript(storageRoot, sessionId));
}

function completedToolParts(
  events: readonly SessionEvent[],
  toolName: string
): Array<Record<string, unknown>> {
  return events.flatMap((event) => {
    if (
      event.type !== 'part_created' ||
      event.data.partType !== 'tool_result' ||
      !isRecord(event.data.payload) ||
      event.data.payload.toolName !== toolName
    ) {
      return [];
    }
    return [event.data.payload];
  });
}

export async function createForegroundCommandHandoffFixture(
  workspace: string,
  nonce: string,
  childFixture: string
): Promise<ForegroundCommandHandoffFixture> {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(nonce)) {
    throw new Error('Foreground command handoff nonce is invalid');
  }
  const stateDir = path.join(workspace, `foreground-handoff-state-${nonce}`);
  const independentPath = path.join(workspace, `independent-${nonce}.txt`);
  const independentMarker = `INDEPENDENT_READ_${nonce}`;
  await Promise.all([
    mkdir(stateDir, { recursive: true }),
    writeFile(independentPath, `${independentMarker}\n`),
  ]);
  const command =
    `${shellQuote(process.execPath)} ${shellQuote(childFixture)} ` +
    `${shellQuote(stateDir)} ${shellQuote(nonce)}`;
  const marker = `FOREGROUND_HANDOFF_OK_${nonce}`;
  const beforeMarker = `HANDOFF_BEFORE_${nonce}`;
  const afterMarker = `HANDOFF_AFTER_${nonce}`;
  const prompt = [
    'Exercise the foreground command handoff contract exactly.',
    `1. Call Bash exactly once with command ${JSON.stringify(
      command
    )}, run_in_background=false, and timeout=30000.`,
    '2. The Bash result must say auto_backgrounded=true and provide shell_id.',
    `3. While that shell is still running, call Read exactly once with file_path ${JSON.stringify(
      independentPath
    )}. Confirm it contains ${independentMarker}.`,
    '4. Call TaskOutput exactly once with task_id set to the same shell_id, block=true, and timeout=30000.',
    `5. Confirm TaskOutput status is exited and stdout contains both ${beforeMarker} and ${afterMarker}.`,
    `Reply exactly ${marker}.`,
    'Do not call any other tool. Do not start another Bash command.',
  ].join('\n');
  return {
    stateDir,
    nonce,
    marker,
    command,
    prompt,
    independentPath,
    beforeMarker,
    afterMarker,
  };
}

export async function driveForegroundCommandHandoffFixture(input: {
  storageRoot: string;
  sessionId: string;
  fixture: ForegroundCommandHandoffFixture;
  waitForSurfaceHandoff: (shellId: string) => Promise<void>;
}): Promise<ForegroundCommandHandoffEvidence> {
  const startedFile = path.join(input.fixture.stateDir, 'started', input.fixture.nonce);
  const activeFile = path.join(input.fixture.stateDir, 'active', input.fixture.nonce);
  const completedFile = path.join(
    input.fixture.stateDir,
    'completed',
    input.fixture.nonce
  );
  const releaseFile = path.join(input.fixture.stateDir, 'release', input.fixture.nonce);
  const launchesFile = path.join(input.fixture.stateDir, 'launches');

  await waitFor(
    () => exists(startedFile),
    'Foreground handoff child did not reach its started barrier',
    45_000
  );
  const pid = Number.parseInt(await readFile(startedFile, 'utf8'), 10);
  if (!Number.isSafeInteger(pid) || pid <= 0 || !processAlive(pid)) {
    throw new Error('Foreground handoff child PID was not alive');
  }

  let shellId = '';
  await waitFor(() => {
    const results = completedToolParts(
      readEvents(input.storageRoot, input.sessionId),
      'Bash'
    );
    if (results.length !== 1) return false;
    const result = results[0];
    const output = result.output;
    const metadata = result.metadata;
    if (!isRecord(output) || !isRecord(metadata)) return false;
    if (
      output.auto_backgrounded !== true ||
      output.background_reason !== 'foreground_budget' ||
      metadata.auto_backgrounded !== true ||
      metadata.background_reason !== 'foreground_budget' ||
      metadata.foreground_budget_ms !== 1_000 ||
      typeof output.shell_id !== 'string' ||
      output.shell_id !== metadata.shell_id
    ) {
      return false;
    }
    shellId = output.shell_id;
    return true;
  }, 'Durable Bash result did not publish foreground handoff metadata');

  if (
    !(await exists(activeFile)) ||
    (await exists(completedFile)) ||
    !processAlive(pid)
  ) {
    throw new Error('Foreground handoff returned after the child stopped running');
  }
  const launches = (await readFile(launchesFile, 'utf8'))
    .trim()
    .split('\n')
    .filter(Boolean);
  if (launches.length !== 1 || launches[0] !== String(pid)) {
    throw new Error(
      `Foreground handoff launched the command more than once: ${launches}`
    );
  }
  await input.waitForSurfaceHandoff(shellId);

  await waitFor(() => {
    const reads = completedToolParts(
      readEvents(input.storageRoot, input.sessionId),
      'Read'
    );
    return reads.length === 1;
  }, 'The Agent did not complete independent Read while the shell was running');
  if (
    !(await exists(activeFile)) ||
    (await exists(completedFile)) ||
    !processAlive(pid)
  ) {
    throw new Error('Independent Read did not complete while the child was active');
  }

  await writeFile(releaseFile, 'release');
  await waitFor(
    async () => (await exists(completedFile)) && !(await exists(activeFile)),
    'Foreground handoff child did not complete after host release'
  );
  await waitFor(
    () => !processAlive(pid),
    'Foreground handoff child remained after terminal completion'
  );

  await waitFor(() => {
    const events = readEvents(input.storageRoot, input.sessionId);
    const outputs = completedToolParts(events, 'TaskOutput');
    return (
      outputs.length === 1 &&
      events.filter((event) => event.type === 'turn_completed').length === 1
    );
  }, 'Foreground handoff Session did not complete through TaskOutput');

  const events = readEvents(input.storageRoot, input.sessionId);
  const trace = extractDurableToolTrace(events);
  if (
    trace.length !== 3 ||
    trace.map((record) => record.toolName).join(',') !== 'Bash,Read,TaskOutput'
  ) {
    throw new Error(
      `Foreground handoff tool order is invalid: ${trace
        .map((record) => record.toolName)
        .join(',')}`
    );
  }
  const [bash, read, taskOutput] = trace;
  if (
    !isRecord(bash.input) ||
    bash.input.command !== input.fixture.command ||
    bash.input.run_in_background === true ||
    !isRecord(read.input) ||
    read.input.file_path !== input.fixture.independentPath ||
    !isRecord(taskOutput.input) ||
    taskOutput.input.task_id !== shellId ||
    taskOutput.input.block !== true ||
    !isRecord(taskOutput.output) ||
    taskOutput.output.status !== 'exited' ||
    typeof taskOutput.output.stdout !== 'string' ||
    !taskOutput.output.stdout.includes(input.fixture.beforeMarker) ||
    !taskOutput.output.stdout.includes(input.fixture.afterMarker)
  ) {
    throw new Error('Foreground handoff durable tool trace violated its contract');
  }

  const transcript = await readFile(
    findSessionTranscript(input.storageRoot, input.sessionId),
    'utf8'
  );
  if (!transcript.includes(input.fixture.marker)) {
    throw new Error('Foreground handoff final marker is absent from transcript');
  }
  return { shellId, pid, events };
}

export async function releaseForegroundCommandHandoffFixture(
  fixture: ForegroundCommandHandoffFixture
): Promise<void> {
  await mkdir(path.join(fixture.stateDir, 'release'), { recursive: true });
  await writeFile(path.join(fixture.stateDir, 'release', fixture.nonce), 'release');
}

export async function cleanupForegroundCommandHandoffFixture(
  fixture: ForegroundCommandHandoffFixture
): Promise<void> {
  await releaseForegroundCommandHandoffFixture(fixture).catch(() => undefined);
  await rm(fixture.stateDir, { recursive: true, force: true }).catch(() => undefined);
}
