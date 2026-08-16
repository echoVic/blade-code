import { type ChildProcess, spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import { ChildBackedRecordingAcpClient } from './acp/ChildBackedRecordingAcpClient.js';

interface RunnerInput {
  cliEntry: string;
  workspace: string;
  home: string;
  storageRoot: string;
  providerHoldPath: string;
  providerReleasePath: string;
  primaryMarker: string;
  rejectedMarker: string;
  secondaryMarker: string;
  followUpMarker: string;
  secret: string;
}

function loadInput(): RunnerInput {
  const encoded = process.env.BLADE_SESSION_RESIDENCY_ACP_INPUT;
  if (!encoded) throw new Error('Missing BLADE_SESSION_RESIDENCY_ACP_INPUT');
  return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as RunnerInput;
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  message: string,
  timeoutMs = 60_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
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
      reject(new Error('Session residency ACP child did not exit'));
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

function prompt(connection: acp.ClientSideConnection, sessionId: string, text: string) {
  return connection.prompt({
    sessionId,
    prompt: [{ type: 'text', text }],
  });
}

function agentText(client: ChildBackedRecordingAcpClient, sessionId: string): string {
  return client.sessionUpdates
    .filter((notification) => notification.sessionId === sessionId)
    .flatMap((notification) =>
      notification.update.sessionUpdate === 'agent_message_chunk' &&
      notification.update.content.type === 'text'
        ? [notification.update.content.text]
        : []
    )
    .join('');
}

async function createSession(
  connection: acp.ClientSideConnection,
  workspace: string
): Promise<string> {
  const session = await connection.newSession({
    cwd: workspace,
    mcpServers: [],
  });
  await connection.setSessionMode({
    sessionId: session.sessionId,
    modeId: 'yolo',
  });
  return session.sessionId;
}

async function run(input: RunnerInput) {
  const child = spawn(process.execPath, [input.cliEntry, '--acp'], {
    cwd: input.workspace,
    env: {
      ...process.env,
      HOME: input.home,
      BLADE_STORAGE_ROOT: input.storageRoot,
      BLADE_AUTO_MEMORY: '0',
      BLADE_TELEMETRY_DISABLED: '1',
      TERM: 'xterm-256color',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (!child.stdin || !child.stdout) {
    child.kill('SIGKILL');
    throw new Error('Session residency ACP stdio was unavailable');
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
  let primarySessionId = '';
  let secondarySessionId = '';
  try {
    const initialized = await connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { terminal: true },
    });
    if (!initialized.agentCapabilities?.sessionCapabilities?.close) {
      throw new Error('Session residency ACP did not advertise session/close');
    }

    primarySessionId = await createSession(connection, input.workspace);
    const primaryPrompt = prompt(
      connection,
      primarySessionId,
      `Reply with exactly ${input.primaryMarker} and no other text.`
    ).then(
      (result) => ({ kind: 'result' as const, result }),
      (error: unknown) => ({ kind: 'error' as const, error })
    );

    await waitFor(async () => {
      try {
        await readFile(input.providerHoldPath);
        return true;
      } catch {
        return false;
      }
    }, 'Session residency ACP primary request did not reach Provider hold');

    const rejected = await connection
      .newSession({
        cwd: input.workspace,
        mcpServers: [],
        _meta: {
          'blade/taskIsolation': 'local',
          'blade/taskPrompt': input.rejectedMarker,
        },
      })
      .then(
        () => ({ kind: 'result' as const }),
        (error: unknown) => ({
          kind: 'error' as const,
          message: error instanceof Error ? error.message : String(error),
        })
      );
    if (
      rejected.kind !== 'error' ||
      !rejected.message.includes('Session runtime capacity is full')
    ) {
      throw new Error(
        `Session residency ACP did not reject capacity: ${JSON.stringify(rejected)}`
      );
    }

    await writeFile(input.providerReleasePath, 'release\n');
    await connection.closeSession({ sessionId: primarySessionId });
    const primaryOutcome = await primaryPrompt;

    secondarySessionId = await createSession(connection, input.workspace);
    const secondary = await prompt(
      connection,
      secondarySessionId,
      `Reply with exactly ${input.secondaryMarker} and no other text.`
    );
    if (secondary.stopReason !== 'end_turn') {
      throw new Error(
        `Session residency ACP secondary stopped with ${secondary.stopReason}`
      );
    }
    await connection.closeSession({ sessionId: secondarySessionId });

    await connection.loadSession({
      sessionId: primarySessionId,
      cwd: input.workspace,
      mcpServers: [],
    });
    await connection.setSessionMode({
      sessionId: primarySessionId,
      modeId: 'yolo',
    });
    const followUp = await prompt(
      connection,
      primarySessionId,
      `Reply with exactly ${input.followUpMarker} and no other text.`
    );
    if (followUp.stopReason !== 'end_turn') {
      throw new Error(
        `Session residency ACP follow-up stopped with ${followUp.stopReason}`
      );
    }
    await connection.closeSession({ sessionId: primarySessionId });

    const primaryText = agentText(client, primarySessionId);
    const secondaryText = agentText(client, secondarySessionId);
    if (
      !primaryText.includes(input.followUpMarker) ||
      !secondaryText.includes(input.secondaryMarker)
    ) {
      throw new Error(
        `Session residency ACP controls did not finish: ${JSON.stringify({
          primaryHasFollowUp: primaryText.includes(input.followUpMarker),
          secondaryHasMarker: secondaryText.includes(input.secondaryMarker),
          primaryTextTail: primaryText.slice(-2_048),
          secondaryTextTail: secondaryText.slice(-2_048),
          recentUpdates: client.sessionUpdates.slice(-20).map((notification) => ({
            sessionId: notification.sessionId,
            kind: notification.update.sessionUpdate,
          })),
        })}`
      );
    }
    const output = JSON.stringify(client.sessionUpdates);
    if (output.includes(input.secret)) {
      throw new Error('Session residency ACP evidence exposed credentials');
    }

    child.kill('SIGTERM');
    const exit = await waitForChildExit(child);
    await connection.closed.catch(() => undefined);
    if (exit.signal || exit.code !== 0) {
      throw new Error(
        `Session residency ACP exited ${
          exit.code ?? exit.signal
        }: ${stderr.replaceAll(input.secret, '[redacted]')}`
      );
    }
    return {
      success: true,
      primarySessionId,
      secondarySessionId,
      primaryPromptKind: primaryOutcome.kind,
      capacityMessage: rejected.message,
      output: output.slice(-256_000),
      processes: client.releasedProcesses,
    };
  } finally {
    await client.close().catch(() => undefined);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await waitForChildExit(child, 10_000).catch(() => undefined);
    }
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

if (import.meta.main) {
  await main();
}
