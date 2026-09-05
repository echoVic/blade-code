import { type ChildProcess, spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import type { TurnActivityProjection } from '../../src/api/turnActivitySchemas.js';
import { ChildBackedRecordingAcpClient } from './acp/ChildBackedRecordingAcpClient.js';
import { createTuiTaskAttentionRunnerEnvironment } from './tuiTaskAttentionPtyDriver.js';

interface RunnerInput {
  cliEntry: string;
  workspace: string;
  home: string;
  storageRoot: string;
  prompt: string;
  marker: string;
  secret: string;
  releaseFile: string;
}

function loadInput(): RunnerInput {
  const encoded = process.env.BLADE_TURN_ACTIVITY_ACP_INPUT;
  if (!encoded) throw new Error('Missing BLADE_TURN_ACTIVITY_ACP_INPUT');
  delete process.env.BLADE_TURN_ACTIVITY_ACP_INPUT;
  return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as RunnerInput;
}

function waitForChildExit(
  child: ChildProcess,
  timeoutMs = 30_000
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Turn activity ACP child did not exit'));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      child.off('error', onError);
      child.off('exit', onExit);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      resolve({ code, signal });
    };
    child.once('error', onError);
    child.once('exit', onExit);
  });
}

async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 120_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

function activityProjections(
  client: ChildBackedRecordingAcpClient
): TurnActivityProjection[] {
  return client.sessionUpdates.flatMap(({ update }) => {
    const activity = update._meta?.['blade/turnActivity'];
    return activity && typeof activity === 'object' && !Array.isArray(activity)
      ? [activity as TurnActivityProjection]
      : [];
  });
}

async function run(input: RunnerInput) {
  const child = spawn(process.execPath, [input.cliEntry, '--acp'], {
    cwd: input.workspace,
    env: {
      ...createTuiTaskAttentionRunnerEnvironment(process.env, {
        HOME: input.home,
        BLADE_STORAGE_ROOT: input.storageRoot,
        BLADE_AUTO_MEMORY: '0',
        BLADE_TELEMETRY_DISABLED: '1',
        TERM: 'xterm-256color',
      }),
      BLADE_API_KEY: input.secret,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (!child.stdin || !child.stdout) {
    child.kill('SIGKILL');
    throw new Error('Turn activity ACP stdio was unavailable');
  }
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer | string) => {
    stderr = `${stderr}${chunk.toString()}`.slice(-64_000);
  });
  const client = new ChildBackedRecordingAcpClient();
  const connection = new acp.ClientSideConnection(
    () => client,
    acp.ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>
    )
  );
  try {
    await connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { terminal: true },
    });
    const created = await connection.newSession({
      cwd: input.workspace,
      mcpServers: [],
    });
    await connection.setSessionMode({ sessionId: created.sessionId, modeId: 'yolo' });
    const prompt = connection.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: input.prompt }],
    });
    await waitFor(
      () =>
        activityProjections(client).some(
          (activity) =>
            activity.snapshot?.phase === 'executing_tools' &&
            activity.snapshot.activeTools.some((tool) => tool.name === 'Bash')
        ),
      'ACP did not project active Bash before release'
    );
    await writeFile(input.releaseFile, 'release\n', { mode: 0o600 });
    const result = await prompt;
    if (result.stopReason !== 'end_turn') {
      throw new Error(`Unexpected turn activity ACP stop reason: ${result.stopReason}`);
    }
    const projections = activityProjections(client);
    const serialized = JSON.stringify(client.sessionUpdates);
    const firstActiveIndex = projections.findIndex(
      (activity) => activity.snapshot !== null
    );
    const activeProjections =
      firstActiveIndex >= 0 ? projections.slice(firstActiveIndex) : projections;
    const generations = new Set(
      activeProjections.map((activity) => activity.generation)
    );
    const revisions = activeProjections.map((activity) => activity.revision);
    const execution = projections.find(
      (activity) =>
        activity.snapshot?.phase === 'executing_tools' &&
        activity.snapshot.activeTools.some((tool) => tool.name === 'Bash')
    );
    if (!execution || activeProjections.at(-1)?.snapshot !== null) {
      throw new Error('ACP did not project Bash activity followed by terminal clear');
    }
    if (generations.size !== 1) {
      throw new Error('ACP emitted more than one turn activity generation');
    }
    if (
      revisions.some((revision, index) => index > 0 && revision < revisions[index - 1]!)
    ) {
      throw new Error(
        `ACP turn activity revisions were not monotonic: ${revisions.join(',')}`
      );
    }
    if (serialized.includes(input.secret)) {
      throw new Error('ACP turn activity evidence contained credentials');
    }

    child.kill('SIGTERM');
    const exit = await waitForChildExit(child);
    await connection.closed.catch(() => undefined);
    if (exit.signal || exit.code !== 0) {
      throw new Error(
        `Turn activity ACP exited ${exit.code ?? exit.signal}: ${stderr.replaceAll(
          input.secret,
          '[redacted]'
        )}`
      );
    }
    return {
      success: true,
      sessionId: created.sessionId,
      generationCount: generations.size,
      revisions,
      phases: activeProjections.map((activity) => activity.snapshot?.phase ?? 'clear'),
      sawBash: true,
      terminalClearSeen: true,
      terminalReleaseCount: [...client.releaseCounts.values()].reduce(
        (sum, count) => sum + count,
        0
      ),
      processes: client.releasedProcesses,
    };
  } finally {
    await client.close().catch(() => undefined);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}

async function main(): Promise<void> {
  const input = loadInput();
  try {
    process.stdout.write(JSON.stringify(await run(input)));
  } catch (error) {
    process.stdout.write(
      JSON.stringify({
        success: false,
        error: (error instanceof Error ? error.message : String(error)).replaceAll(
          input.secret,
          '[redacted]'
        ),
      })
    );
    process.exitCode = 1;
  }
}

if (import.meta.main) await main();
