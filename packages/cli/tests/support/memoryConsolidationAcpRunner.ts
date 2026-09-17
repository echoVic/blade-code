import { access, readFile } from 'node:fs/promises';
import * as acp from '@agentclientprotocol/sdk';
import { findSessionTranscript } from '../integration/real-api/sessionForkTrajectoryHarness.js';
import { ChildBackedRecordingAcpClient } from './acp/ChildBackedRecordingAcpClient.js';
import { createBladeAcpChildHarness } from './acp/createBladeAcpChildHarness.js';

interface RunnerInput {
  cliEntry: string;
  workspace: string;
  home: string;
  storageRoot: string;
  sessionId: string;
  manualCompaction?: { readyFile: string; cancelledFile: string };
  prompt: string;
  marker: string;
  discoveryPrompt: string;
  discoveryMarker: string;
  secret: string;
}

function loadInput(): RunnerInput {
  const encoded = process.env.BLADE_MEMORY_CONSOLIDATION_ACP_INPUT;
  if (!encoded) throw new Error('Missing BLADE_MEMORY_CONSOLIDATION_ACP_INPUT');
  delete process.env.BLADE_MEMORY_CONSOLIDATION_ACP_INPUT;
  return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as RunnerInput;
}

async function run(input: RunnerInput) {
  const client = new ChildBackedRecordingAcpClient();
  const harness = createBladeAcpChildHarness({
    ...input,
    client,
    autoMemory: true,
    env: {
      BLADE_VERSION: '999.0.0',
      BLADE_API_KEY: input.secret,
    },
    stdioError: 'Memory consolidation ACP stdio is unavailable',
  });
  const { connection } = harness;
  let sessionId = '';
  try {
    await connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { terminal: true },
    });
    await connection.loadSession({
      sessionId: input.sessionId,
      cwd: input.workspace,
      mcpServers: [],
    });
    sessionId = input.sessionId;
    await connection.setSessionMode({ sessionId, modeId: 'yolo' });
    if (input.manualCompaction) {
      const waitForFile = async (file: string, timeoutMs: number) => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          if (
            await access(file).then(
              () => true,
              () => false
            )
          )
            return;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        throw new Error('Manual compaction ACP barrier expired');
      };
      const transcript = findSessionTranscript(input.storageRoot, sessionId);
      const before = await readFile(transcript);
      const pending = connection.prompt({
        sessionId,
        prompt: [{ type: 'text', text: '/compact' }],
      });
      await waitForFile(input.manualCompaction.readyFile, 90_000);
      const started = Date.now();
      await connection.cancel({ sessionId });
      await waitForFile(input.manualCompaction.cancelledFile, 10_000);
      const result = await pending;
      if (result.stopReason !== 'cancelled')
        throw new Error('Manual compaction ACP did not report cancellation');
      if (!(await readFile(transcript)).equals(before))
        throw new Error('Cancelled manual compaction changed the transcript');
      const content = client.agentText(sessionId);
      if (!content.includes('上下文压缩已取消') || content.includes('[FAIL]'))
        throw new Error('Manual compaction ACP cancellation output is incorrect');
      const exit = await harness.shutdown();
      if (exit.signal || exit.code !== 0)
        throw new Error(`Manual compaction ACP exited ${exit.code ?? exit.signal}`);
      return {
        success: true,
        cancelled: true,
        transcriptUnchanged: true,
        cancellationMs: Date.now() - started,
      };
    }
    const result = await connection.prompt({
      sessionId,
      prompt: [{ type: 'text', text: input.prompt }],
    });
    if (result.stopReason !== 'end_turn') {
      throw new Error(`Unexpected memory ACP stop reason: ${result.stopReason}`);
    }
    const serialized = JSON.stringify(client.sessionUpdates);
    const compactions = client.sessionUpdates.flatMap((notification) => {
      const metadata = notification.update._meta?.['blade/compaction'];
      return metadata && typeof metadata === 'object' && !Array.isArray(metadata)
        ? [metadata]
        : [];
    });
    if (serialized.includes(input.secret)) {
      throw new Error('Memory consolidation ACP updates leaked a credential');
    }
    if (harness.stderr.includes(input.secret)) {
      throw new Error('Memory consolidation ACP stderr leaked a credential');
    }
    const discovery = await connection.newSession({
      cwd: input.workspace,
      mcpServers: [],
    });
    await connection.setSessionMode({
      sessionId: discovery.sessionId,
      modeId: 'yolo',
    });
    const discoveryResult = await connection.prompt({
      sessionId: discovery.sessionId,
      prompt: [{ type: 'text', text: input.discoveryPrompt }],
    });
    if (discoveryResult.stopReason !== 'end_turn') {
      throw new Error(
        `Unexpected memory discovery ACP stop reason: ${discoveryResult.stopReason}`
      );
    }

    const exit = await harness.shutdown();
    if (exit.signal || exit.code !== 0) {
      throw new Error(`Memory consolidation ACP exited ${exit.code ?? exit.signal}`);
    }
    return {
      success: true,
      sessionId,
      finalMarkerSeen: client.agentText(sessionId).includes(input.marker),
      discoveryMarkerSeen: client
        .agentText(discovery.sessionId)
        .includes(input.discoveryMarker),
      compactions,
      updateCount: client.sessionUpdates.length,
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
