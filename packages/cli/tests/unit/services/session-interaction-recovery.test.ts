import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DurableSteeringInbox } from '../../../src/agent/runtime/DurableSteeringInbox.js';
import { PersistentStore } from '../../../src/context/storage/PersistentStore.js';
import { getSessionFilePath } from '../../../src/context/storage/pathUtils.js';
import { SessionInteractionService } from '../../../src/services/SessionInteractionService.js';
import { SessionService } from '../../../src/services/SessionService.js';

describe('SessionInteractionService durable recovery', () => {
  let storageRoot: string;
  let workspace: string;
  let previousStorageRoot: string | undefined;

  beforeEach(async () => {
    previousStorageRoot = process.env.BLADE_STORAGE_ROOT;
    storageRoot = await mkdtemp(path.join(os.tmpdir(), 'blade-interaction-store-'));
    workspace = await mkdtemp(path.join(os.tmpdir(), 'blade-interaction-workspace-'));
    process.env.BLADE_STORAGE_ROOT = storageRoot;
  });

  afterEach(async () => {
    if (previousStorageRoot === undefined) delete process.env.BLADE_STORAGE_ROOT;
    else process.env.BLADE_STORAGE_ROOT = previousStorageRoot;
    await Promise.all([
      rm(storageRoot, { recursive: true, force: true }),
      rm(workspace, { recursive: true, force: true }),
    ]);
  });

  async function createToolCall(
    sessionId: string,
    toolName = 'AskUserQuestion'
  ): Promise<string> {
    const store = new PersistentStore(workspace);
    await store.initSession(sessionId);
    return store.saveToolUse(sessionId, toolName, { fixture: true });
  }

  it('fsyncs request before the surface and response before tool continuation', async () => {
    const sessionId = 'interaction-order';
    const toolCallId = await createToolCall(sessionId);
    const surface = vi.fn(async (details) => {
      const metadata = await SessionService.findSessionMetadata(sessionId, workspace);
      expect(metadata?.pendingInteraction).toEqual({
        type: 'question',
        requestId: details.interactionRequestId,
      });
      return {
        approved: true,
        answers: { Channel: 'Stable' },
      };
    });
    const handler = SessionInteractionService.createConfirmationHandler(
      { requestConfirmation: surface },
      {
        sessionId,
        projectPath: workspace,
        toolCallId,
        toolName: 'AskUserQuestion',
      }
    );

    await expect(
      handler!.requestConfirmation({
        type: 'askUserQuestion',
        message: 'Choose a channel',
        questions: [
          {
            header: 'Channel',
            question: 'Which channel?',
            multiSelect: false,
            options: [
              { label: 'Stable', description: 'Stable releases' },
              { label: 'Canary', description: 'Early releases' },
            ],
          },
        ],
      })
    ).resolves.toMatchObject({
      approved: true,
      answers: { Channel: 'Stable' },
    });
    expect(surface).toHaveBeenCalledTimes(1);
    expect(
      (await SessionService.findSessionMetadata(sessionId, workspace))
        ?.pendingInteraction
    ).toBeUndefined();

    const transcript = await readFile(getSessionFilePath(workspace, sessionId), 'utf8');
    expect(transcript.indexOf('"interaction_requested"')).toBeLessThan(
      transcript.indexOf('"interaction_responded"')
    );
  });

  it('recovers a question without replaying the interrupted tool invocation', async () => {
    const sessionId = 'interaction-question-recovery';
    const toolCallId = await createToolCall(sessionId);
    const request = await SessionInteractionService.request(
      {
        sessionId,
        projectPath: workspace,
        toolCallId,
        toolName: 'AskUserQuestion',
      },
      {
        type: 'askUserQuestion',
        message: 'Choose a database',
        questions: [
          {
            header: 'Database',
            question: 'Which database?',
            multiSelect: false,
            options: [
              { label: 'Postgres', description: 'Production database' },
              { label: 'SQLite', description: 'Embedded database' },
            ],
          },
        ],
      }
    );

    await SessionInteractionService.respondAndRecover(
      workspace,
      sessionId,
      request.requestId,
      {
        approved: true,
        answers: { Database: 'Postgres' },
      }
    );

    const events = await new PersistentStore(workspace).loadEvents(sessionId);
    const recoveredResult = events?.find(
      (event) =>
        event.type === 'part_created' &&
        event.data.partType === 'tool_result' &&
        event.data.partId === toolCallId
    );
    expect(recoveredResult).toMatchObject({
      type: 'part_created',
      data: {
        payload: {
          toolCallId,
          toolName: 'AskUserQuestion',
          output: 'User answers:\nDatabase: Postgres',
          metadata: {
            interactionRecovery: true,
            requestId: request.requestId,
          },
        },
      },
    });

    const inbox = await DurableSteeringInbox.open(workspace, sessionId);
    expect(inbox.list()).toEqual([
      expect.objectContaining({
        id: `interaction-${request.requestId}`,
        content: expect.stringContaining('Database: Postgres'),
      }),
    ]);
    await expect(
      SessionInteractionService.recoverResponded(workspace, sessionId)
    ).resolves.toBe(0);
  });

  it('closes an approved permission fail-closed instead of replaying side effects', async () => {
    const sessionId = 'interaction-permission-recovery';
    const toolCallId = await createToolCall(sessionId, 'Write');
    const request = await SessionInteractionService.request(
      {
        sessionId,
        projectPath: workspace,
        toolCallId,
        toolName: 'Write',
      },
      {
        type: 'permission',
        toolName: 'Write',
        message: 'Write production.txt',
        args: { file_path: 'production.txt', content: 'approved' },
      }
    );

    await SessionInteractionService.respond(workspace, sessionId, request.requestId, {
      approved: true,
      scope: 'once',
    });
    await expect(
      SessionInteractionService.recoverResponded(workspace, sessionId)
    ).resolves.toBe(1);

    const messages = await SessionService.loadSession(sessionId, workspace);
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'tool',
          name: 'Write',
          content: expect.stringContaining('original invocation was not replayed'),
        }),
      ])
    );
    await expect(
      readFile(path.join(workspace, 'production.txt'), 'utf8')
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not inherit pending interaction state across a fork', async () => {
    const sessionId = 'interaction-parent';
    const toolCallId = await createToolCall(sessionId);
    await SessionInteractionService.request(
      {
        sessionId,
        projectPath: workspace,
        toolCallId,
        toolName: 'AskUserQuestion',
      },
      {
        type: 'askUserQuestion',
        message: 'Choose',
        questions: [
          {
            header: 'Choice',
            question: 'Which choice?',
            multiSelect: false,
            options: [
              { label: 'A', description: 'Option A' },
              { label: 'B', description: 'Option B' },
            ],
          },
        ],
      }
    );
    expect(
      (await SessionService.findSessionMetadata(sessionId, workspace))
        ?.pendingInteraction
    ).toBeDefined();

    const fork = await SessionService.forkSession(sessionId, {
      sourceProjectPath: workspace,
      targetProjectPath: workspace,
      newSessionId: 'interaction-child',
    });
    expect(fork.metadata.pendingInteraction).toBeUndefined();
    expect(
      await readFile(getSessionFilePath(workspace, fork.sessionId), 'utf8')
    ).not.toContain('interaction_requested');
  });

  it('never persists MCP elicitation form content in the response ledger', async () => {
    const sessionId = 'interaction-elicitation-secret';
    const toolCallId = await createToolCall(sessionId, 'mcp__fixture__configure');
    const request = await SessionInteractionService.request(
      {
        sessionId,
        projectPath: workspace,
        toolCallId,
        toolName: 'mcp__fixture__configure',
      },
      {
        type: 'mcpElicitation',
        message: 'Configure MCP',
        mcpElicitation: {
          serverName: 'fixture',
          mode: 'form',
          message: 'Enter a token',
          fields: [],
          requestedSchema: {},
        },
      }
    );
    await SessionInteractionService.respond(workspace, sessionId, request.requestId, {
      approved: true,
      elicitation: {
        action: 'accept',
        content: { token: 'TOP_SECRET_FORM_VALUE' },
      },
    });

    const transcript = await readFile(getSessionFilePath(workspace, sessionId), 'utf8');
    expect(transcript).not.toContain('TOP_SECRET_FORM_VALUE');
    expect(transcript).toContain('"elicitation":{"action":"accept"}');
  });

  it('rejects interaction payloads above the durable budget before showing UI', async () => {
    const sessionId = 'interaction-budget';
    const toolCallId = await createToolCall(sessionId, 'Bash');
    const surface = vi.fn();
    const handler = SessionInteractionService.createConfirmationHandler(
      {
        requestConfirmation: surface,
      },
      {
        sessionId,
        projectPath: workspace,
        toolCallId,
        toolName: 'Bash',
      }
    );

    await expect(
      handler!.requestConfirmation({
        type: 'permission',
        toolName: 'Bash',
        message: 'x'.repeat(130 * 1024),
      })
    ).rejects.toThrow('Interaction details exceeds');
    expect(surface).not.toHaveBeenCalled();
  });

  it('does not show a request when the owning tool call is not durable', async () => {
    const sessionId = 'interaction-missing-tool';
    await new PersistentStore(workspace).initSession(sessionId);
    const surface = vi.fn();
    const handler = SessionInteractionService.createConfirmationHandler(
      { requestConfirmation: surface },
      {
        sessionId,
        projectPath: workspace,
        toolCallId: 'missing-tool-call',
        toolName: 'Write',
      }
    );

    await expect(
      handler!.requestConfirmation({
        type: 'permission',
        toolName: 'Write',
        message: 'Write a file',
      })
    ).rejects.toThrow('Interaction requires a durable tool call');
    expect(surface).not.toHaveBeenCalled();
  });
});
