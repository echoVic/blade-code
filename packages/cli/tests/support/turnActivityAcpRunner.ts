import { type ChildProcess, spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import type { TurnActivityProjection } from '../../src/api/turnActivitySchemas.js';
import { ChildBackedRecordingAcpClient } from './acp/ChildBackedRecordingAcpClient.js';
import { waitForChildExit } from './asyncTestUtils.js';
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
  cleanupFailure?: 'kill' | 'release';
  cleanupCancellation?: boolean;
  creationCancellation?: 'reject' | 'late';
  reasoningEffort?: 'high';
  emptyFinalFailure?: boolean;
  codingTask?: boolean;
}

function loadInput(): RunnerInput {
  const encoded = process.env.BLADE_TURN_ACTIVITY_ACP_INPUT;
  if (!encoded) throw new Error('Missing BLADE_TURN_ACTIVITY_ACP_INPUT');
  delete process.env.BLADE_TURN_ACTIVITY_ACP_INPUT;
  return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as RunnerInput;
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
  const child = spawn(
    process.execPath,
    [input.cliEntry, ...(input.codingTask ? ['--trust-workspace'] : []), '--acp'],
    {
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
    }
  );
  if (!child.stdin || !child.stdout) {
    child.kill('SIGKILL');
    throw new Error('Turn activity ACP stdio was unavailable');
  }
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer | string) => {
    stderr = `${stderr}${chunk.toString()}`.slice(-64_000);
  });
  class CleanupFailureClient extends ChildBackedRecordingAcpClient {
    failureEnabled = true;
    killAttempts = 0;
    releaseAttempts = 0;
    override async killTerminal(
      params: acp.KillTerminalRequest
    ): Promise<acp.KillTerminalResponse> {
      this.killAttempts++;
      if (this.failureEnabled && input.cleanupFailure === 'kill')
        throw new Error('PRIVATE_ACP_KILL_FAILURE');
      return super.killTerminal(params);
    }
    override async releaseTerminal(
      params: acp.ReleaseTerminalRequest
    ): Promise<acp.ReleaseTerminalResponse> {
      this.releaseAttempts++;
      if (this.failureEnabled && input.cleanupFailure === 'release')
        throw new Error('PRIVATE_ACP_RELEASE_FAILURE');
      if (this.failureEnabled && input.cleanupFailure === 'kill')
        await super.killTerminal(params);
      return super.releaseTerminal(params);
    }
  }
  let finishCreation!: () => void;
  const creationBarrier = new Promise<void>((resolve) => {
    finishCreation = resolve;
  });
  class CreationCancellationClient extends ChildBackedRecordingAcpClient {
    creationStarted = false;
    killAttempts = 0;
    override async createTerminal(
      params: acp.CreateTerminalRequest
    ): Promise<acp.CreateTerminalResponse> {
      if (input.creationCancellation === 'reject') {
        this.createRequests.push(params);
        this.creationStarted = true;
        await creationBarrier;
        throw new Error('PRIVATE_CREATE_REJECTED');
      }
      const result = await super.createTerminal(params);
      this.creationStarted = true;
      await creationBarrier;
      return result;
    }
    override async killTerminal(
      params: acp.KillTerminalRequest
    ): Promise<acp.KillTerminalResponse> {
      this.killAttempts++;
      return super.killTerminal(params);
    }
  }
  const client = input.creationCancellation
    ? new CreationCancellationClient()
    : input.cleanupFailure
      ? new CleanupFailureClient()
      : new ChildBackedRecordingAcpClient();
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
    if (input.reasoningEffort) {
      await connection.setSessionConfigOption({
        sessionId: created.sessionId,
        configId: 'reasoning_effort',
        value: input.reasoningEffort,
      });
    }
    if (input.codingTask) {
      const result = await connection.prompt({
        sessionId: created.sessionId,
        prompt: [{ type: 'text', text: input.prompt }],
      });
      const toolUpdates = client.sessionUpdates.flatMap(({ update }) =>
        update.sessionUpdate === 'tool_call_update'
          ? [{ id: update.toolCallId, status: update.status }]
          : []
      );
      if (
        result.stopReason !== 'end_turn' ||
        toolUpdates.filter((update) => update.status === 'completed').length < 3
      )
        throw new Error('ACP coding task did not complete with visible tools');
      if (client.activeTerminalCount() !== 0)
        throw new Error('ACP coding terminal was not released');
      if (JSON.stringify(client.sessionUpdates).includes(input.secret))
        throw new Error('ACP coding task leaked credentials');
      child.kill('SIGTERM');
      const exit = await waitForChildExit(child);
      await connection.closed.catch(() => undefined);
      if (exit.signal || exit.code !== 0)
        throw new Error('ACP coding runner did not exit cleanly');
      return {
        success: true,
        sessionId: created.sessionId,
        toolUpdates,
        terminalRequests: client.createRequests.length,
        activeTerminals: 0,
      };
    }
    if (input.emptyFinalFailure) {
      let failure: unknown;
      try {
        await connection.prompt({
          sessionId: created.sessionId,
          prompt: [{ type: 'text', text: input.prompt }],
        });
      } catch (error) {
        failure = error;
      }
      if (
        !(failure instanceof acp.RequestError) ||
        !failure.data ||
        typeof failure.data !== 'object' ||
        !('failureType' in failure.data) ||
        failure.data.failureType !== 'intent_fulfillment_failed'
      ) {
        throw new Error(
          'ACP accepted an empty final or reported an unexpected failure'
        );
      }
      if (client.createRequests.length !== 0)
        throw new Error('Empty final launched a terminal');
      const updateIndex = client.sessionUpdates.length;
      const resumed = await connection.prompt({
        sessionId: created.sessionId,
        prompt: [
          {
            type: 'text',
            text: `Replace the previous failed request with this request: reply exactly ${input.marker}. Do not use tools.`,
          },
        ],
      });
      const answer = client.sessionUpdates
        .slice(updateIndex)
        .flatMap(({ update }) =>
          update.sessionUpdate === 'agent_message_chunk' &&
          update.content.type === 'text'
            ? [update.content.text]
            : []
        )
        .join('');
      if (
        resumed.stopReason !== 'end_turn' ||
        answer.trim() !== input.marker ||
        client.createRequests.length !== 0
      )
        throw new Error('ACP did not recover from an empty final');
      if (JSON.stringify(client.sessionUpdates).includes(input.secret))
        throw new Error('ACP leaked credentials');
      child.kill('SIGTERM');
      const exit = await waitForChildExit(child);
      await connection.closed.catch(() => undefined);
      if (exit.signal || exit.code !== 0)
        throw new Error('ACP empty final runner did not exit cleanly');
      return {
        success: true,
        sessionId: created.sessionId,
        sawBash: false,
        terminalClearSeen: true,
        emptyFinalFailure: true,
      };
    }
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
    if (client instanceof CreationCancellationClient) {
      await waitFor(
        () => client.creationStarted,
        'ACP terminal creation did not reach the barrier',
        30_000
      );
      await connection.cancel({ sessionId: created.sessionId });
      await connection.setSessionMode({ sessionId: created.sessionId, modeId: 'yolo' });
      finishCreation();
    } else if (input.cleanupCancellation) {
      await waitFor(
        () => client.activeTerminalCount() === 1,
        'ACP cleanup cancellation terminal did not start',
        30_000
      );
      await connection.cancel({ sessionId: created.sessionId });
    } else if (input.cleanupFailure !== 'kill') {
      await writeFile(input.releaseFile, 'release\n', { mode: 0o600 });
    }
    const result = await prompt;
    if (
      result.stopReason !==
      (input.creationCancellation || input.cleanupCancellation
        ? 'cancelled'
        : 'end_turn')
    ) {
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
    let cleanupEvidence:
      | {
          failure: 'kill' | 'release';
          killAttempts: number;
          releaseAttempts: number;
          failedUpdates: number;
        }
      | undefined;
    if (input.cleanupFailure && client instanceof CleanupFailureClient) {
      const failedUpdates = client.sessionUpdates.filter(
        ({ update }) =>
          update.sessionUpdate === 'tool_call_update' && update.status === 'failed'
      );
      if (
        failedUpdates.length !== 1 ||
        !JSON.stringify(failedUpdates).includes('ACP terminal finalization failed')
      ) {
        throw new Error('ACP cleanup failure was not projected as one failed tool');
      }
      if (serialized.includes('PRIVATE_ACP_'))
        throw new Error('ACP cleanup leaked client diagnostics');
      const text = client.sessionUpdates
        .flatMap(({ update }) =>
          update.sessionUpdate === 'agent_message_chunk' &&
          update.content.type === 'text'
            ? [update.content.text]
            : []
        )
        .join('');
      if (!input.cleanupCancellation && text.trim() !== input.marker)
        throw new Error('ACP cleanup final response mismatch');
      if (
        client.createRequests.length !== 1 ||
        client.releaseAttempts !== 1 ||
        client.killAttempts !==
          (input.cleanupCancellation || input.cleanupFailure === 'kill' ? 1 : 0)
      ) {
        throw new Error('ACP cleanup requests were repeated');
      }
      cleanupEvidence = {
        failure: input.cleanupFailure,
        killAttempts: client.killAttempts,
        releaseAttempts: client.releaseAttempts,
        failedUpdates: failedUpdates.length,
      };
      client.failureEnabled = false;
      await client.close();
      if (client.activeTerminalCount() !== 0)
        throw new Error('Fixture terminals remained after cleanup');
      if (input.cleanupCancellation) {
        const updateIndex = client.sessionUpdates.length;
        const followup = await connection.prompt({
          sessionId: created.sessionId,
          prompt: [
            {
              type: 'text',
              text: `If the cancelled Bash reported ACP terminal finalization failed, reply exactly ${input.marker}. Otherwise reply UNEXPECTED_RESULT. Do not call tools.`,
            },
          ],
        });
        const answer = client.sessionUpdates
          .slice(updateIndex)
          .flatMap(({ update }) =>
            update.sessionUpdate === 'agent_message_chunk' &&
            update.content.type === 'text'
              ? [update.content.text]
              : []
          )
          .join('');
        if (
          followup.stopReason !== 'end_turn' ||
          answer.trim() !== input.marker ||
          client.createRequests.length !== 1
        ) {
          throw new Error(
            'ACP cleanup cancellation recovery lost the failure or replayed the command'
          );
        }
        if (JSON.stringify(client.sessionUpdates).includes(input.secret)) {
          throw new Error('ACP cleanup cancellation recovery leaked credentials');
        }
      }
    }

    let creationEvidence:
      | {
          outcome: 'reject' | 'late';
          attempts: number;
          kills: number;
          activeTerminals: number;
          resumed: true;
        }
      | undefined;
    if (input.creationCancellation && client instanceof CreationCancellationClient) {
      if (
        client.createRequests.length !== 1 ||
        client.activeTerminalCount() !== 0 ||
        client.killAttempts !== (input.creationCancellation === 'late' ? 1 : 0)
      ) {
        throw new Error(
          'Cancelled ACP creation did not release exactly its owned resources'
        );
      }
      if (serialized.includes('PRIVATE_'))
        throw new Error('ACP creation cancellation leaked diagnostics');
      const updateIndex = client.sessionUpdates.length;
      const followup = await connection.prompt({
        sessionId: created.sessionId,
        prompt: [
          {
            type: 'text',
            text: `Reply exactly ${input.marker}. Do not call any tools or repeat the cancelled command.`,
          },
        ],
      });
      if (followup.stopReason !== 'end_turn')
        throw new Error('ACP did not recover after cancelled creation');
      const finalText = client.sessionUpdates
        .slice(updateIndex)
        .flatMap(({ update }) =>
          update.sessionUpdate === 'agent_message_chunk' &&
          update.content.type === 'text'
            ? [update.content.text]
            : []
        )
        .join('');
      if (finalText.trim() !== input.marker || client.createRequests.length !== 1) {
        throw new Error(
          'ACP cancellation follow-up did not return the exact marker without replay'
        );
      }
      if (JSON.stringify(client.sessionUpdates).includes(input.secret)) {
        throw new Error('ACP cancellation recovery leaked credentials');
      }
      creationEvidence = {
        outcome: input.creationCancellation,
        attempts: client.createRequests.length,
        kills: client.killAttempts,
        activeTerminals: client.activeTerminalCount(),
        resumed: true,
      };
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
      ...(cleanupEvidence ? { cleanupFailure: cleanupEvidence } : {}),
      ...(creationEvidence ? { creationCancellation: creationEvidence } : {}),
      terminalReleaseCount: [...client.releaseCounts.values()].reduce(
        (sum, count) => sum + count,
        0
      ),
      processes: client.releasedProcesses,
    };
  } finally {
    finishCreation();
    if (client instanceof CleanupFailureClient) client.failureEnabled = false;
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
