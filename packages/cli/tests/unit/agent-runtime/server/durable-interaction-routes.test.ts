import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DurableSteeringInbox } from '../../../../src/agent/runtime/DurableSteeringInbox.js';
import { PersistentStore } from '../../../../src/context/storage/PersistentStore.js';
import { BladeServerError } from '../../../../src/server/error.js';
import { PermissionRoutes } from '../../../../src/server/routes/permission.js';
import { SessionInteractionService } from '../../../../src/services/SessionInteractionService.js';
import { SessionService } from '../../../../src/services/SessionService.js';

describe('durable interaction HTTP recovery', () => {
  let storageRoot: string;
  let workspace: string;
  let previousStorageRoot: string | undefined;

  beforeEach(async () => {
    previousStorageRoot = process.env.BLADE_STORAGE_ROOT;
    storageRoot = await mkdtemp(path.join(os.tmpdir(), 'blade-interaction-route-'));
    workspace = await mkdtemp(path.join(os.tmpdir(), 'blade-interaction-project-'));
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

  function createApp(): Hono {
    const app = new Hono();
    app.onError((error, context) =>
      error instanceof BladeServerError
        ? context.json(
            error.toObject(),
            error.statusCode as 400 | 404 | 409 | 429 | 500
          )
        : context.json({ error: String(error) }, 500)
    );
    app.route('/permissions', PermissionRoutes());
    return app;
  }

  it('answers a cold durable question and queues a fail-closed continuation', async () => {
    const sessionId = 'cold-question-route';
    const store = new PersistentStore(workspace);
    await store.initSession(sessionId);
    const toolCallId = await store.saveToolUse(sessionId, 'AskUserQuestion', {
      fixture: true,
    });
    const request = await SessionInteractionService.request(
      {
        sessionId,
        projectPath: workspace,
        toolCallId,
        toolName: 'AskUserQuestion',
      },
      {
        type: 'askUserQuestion',
        message: 'Choose a channel',
        questions: [
          {
            header: 'Channel',
            question: 'Which channel?',
            multiSelect: false,
            options: [
              { label: 'Stable', description: 'Stable releases' },
              { label: 'Canary', description: 'Canary releases' },
            ],
          },
        ],
      }
    );
    expect(
      (await SessionService.findSessionMetadata(sessionId, workspace))
        ?.pendingInteraction
    ).toEqual({ type: 'question', requestId: request.requestId });

    const app = createApp();
    const response = await app.request(
      `/permissions/${request.requestId}?sessionId=${sessionId}&projectPath=${encodeURIComponent(
        workspace
      )}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          approved: true,
          answers: { Channel: 'Stable' },
        }),
      }
    );

    expect(response.status).toBe(200);
    expect(
      (await SessionService.findSessionMetadata(sessionId, workspace))
        ?.pendingInteraction
    ).toBeUndefined();
    expect((await DurableSteeringInbox.open(workspace, sessionId)).list()).toEqual([
      expect.objectContaining({
        id: `interaction-${request.requestId}`,
        content: expect.stringContaining('Channel: Stable'),
      }),
    ]);
  });

  it('rejects oversized answer payloads before mutating durable state', async () => {
    const sessionId = 'cold-question-route-invalid';
    const store = new PersistentStore(workspace);
    await store.initSession(sessionId);
    const toolCallId = await store.saveToolUse(sessionId, 'AskUserQuestion', {
      fixture: true,
    });
    const request = await SessionInteractionService.request(
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
              { label: 'A', description: 'A' },
              { label: 'B', description: 'B' },
            ],
          },
        ],
      }
    );
    const app = createApp();

    const response = await app.request(
      `/permissions/${request.requestId}?sessionId=${sessionId}&projectPath=${encodeURIComponent(
        workspace
      )}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          approved: true,
          answers: { Choice: 'x'.repeat(5_000) },
        }),
      }
    );

    expect(response.status).toBe(400);
    expect(
      (await SessionService.findSessionMetadata(sessionId, workspace))
        ?.pendingInteraction
    ).toEqual({ type: 'question', requestId: request.requestId });
  });
});
