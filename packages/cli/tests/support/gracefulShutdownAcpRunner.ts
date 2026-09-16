import { readFile } from 'node:fs/promises';
import * as acp from '@agentclientprotocol/sdk';
import { ChildBackedRecordingAcpClient } from './acp/ChildBackedRecordingAcpClient.js';
import { createBladeAcpChildHarness } from './acp/createBladeAcpChildHarness.js';

interface RunnerInput {
  cliEntry: string;
  workspace: string;
  home: string;
  storageRoot: string;
  prompt: string;
  rootPidFile: string;
  secret: string;
  signal: 'SIGINT' | 'SIGTERM';
}

interface RunnerEvidence {
  success: true;
  sessionId: string;
  output: string;
  rootPid: number;
  commandStartedAt: number;
}

function loadInput(): RunnerInput {
  const encoded = process.env.BLADE_GRACEFUL_ACP_INPUT;
  if (!encoded) throw new Error('Missing BLADE_GRACEFUL_ACP_INPUT');
  return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as RunnerInput;
}

async function waitForRootPid(filePath: string): Promise<number> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      const value = Number.parseInt(await readFile(filePath, 'utf8'), 10);
      if (Number.isSafeInteger(value) && value > 1) {
        process.kill(value, 0);
        return value;
      }
    } catch {
      // The model has not launched the fixture yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for ACP foreground process');
}

function updateShape(
  updates: readonly acp.SessionNotification[]
): Array<{ kind: string; title?: string; status?: string }> {
  return updates.map((notification) => {
    const update = notification.update;
    return {
      kind: update.sessionUpdate,
      ...('title' in update && typeof update.title === 'string'
        ? { title: update.title }
        : {}),
      ...('status' in update && typeof update.status === 'string'
        ? { status: update.status }
        : {}),
    };
  });
}

async function run(input: RunnerInput): Promise<RunnerEvidence> {
  const client = new ChildBackedRecordingAcpClient();
  const harness = createBladeAcpChildHarness({
    ...input,
    client,
    stderrLimit: 16_000,
    stdoutLimit: 256_000,
  });
  const { connection } = harness;
  let sessionId = '';
  try {
    await connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { terminal: true },
    });
    const created = await connection.newSession({
      cwd: input.workspace,
      mcpServers: [],
    });
    sessionId = created.sessionId;
    await connection.setSessionMode({ sessionId, modeId: 'yolo' });
    const prompt = connection.prompt({
      sessionId,
      prompt: [{ type: 'text', text: input.prompt }],
    });
    const rootPid = await Promise.race([
      waitForRootPid(input.rootPidFile),
      prompt.then(
        (result) => {
          throw new Error(
            `ACP prompt ended before Bash started: ${
              result.stopReason
            }; updates=${JSON.stringify(updateShape(client.sessionUpdates))}`
          );
        },
        (error) => {
          throw new Error(
            `ACP prompt failed before Bash started: ${
              error instanceof Error ? error.message : String(error)
            }; updates=${JSON.stringify(
              updateShape(client.sessionUpdates)
            )}; stderr=${harness.stderr.replaceAll(input.secret, '[redacted]')}`
          );
        }
      ),
    ]);
    const commandStartedAt = Date.now();
    const exit = await harness.shutdown(input.signal);
    await prompt.catch(() => undefined);
    if (exit.signal || exit.code !== 0) {
      throw new Error(
        `ACP graceful exit was ${exit.code ?? exit.signal}: ${harness.stderr.replaceAll(
          input.secret,
          '[redacted]'
        )}`
      );
    }
    if (harness.stdout.includes('\u001b')) {
      throw new Error('ACP shutdown stdout contained terminal control sequences');
    }
    for (const line of harness.stdout.split(/\r?\n/).filter(Boolean)) {
      JSON.parse(line);
    }
    const serializedUpdates = JSON.stringify(client.sessionUpdates);
    if ((harness.stdout + serializedUpdates + harness.stderr).includes(input.secret)) {
      throw new Error('ACP shutdown traffic contained provider credentials');
    }
    return {
      success: true,
      sessionId,
      output: JSON.stringify(updateShape(client.sessionUpdates)),
      rootPid,
      commandStartedAt,
    };
  } finally {
    await harness.close();
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
        error:
          error instanceof Error
            ? error.message.replaceAll(input.secret, '[redacted]')
            : String(error).replaceAll(input.secret, '[redacted]'),
      })
    );
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await main();
}
