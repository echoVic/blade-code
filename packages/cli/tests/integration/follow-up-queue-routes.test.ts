import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('child_process');
vi.unmock('node:child_process');

import { ActiveTurnMailbox } from '../../src/agent/runtime/ActiveTurnMailbox.js';
import { FollowUpQueueSnapshotSchema } from '../../src/api/followUpQueueSchemas.js';
import { Bus } from '../../src/server/bus.js';
import { createSessionRouteController } from '../../src/server/routes/session.js';
import { SessionService } from '../../src/services/SessionService.js';
import { getState } from '../../src/store/vanilla.js';
import { createDefaultMockConfig } from '../support/mocks/mockConfig.js';

function createSseCollector(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Expected SSE response body');
  const decoder = new TextDecoder();
  let buffer = '';
  return {
    async next() {
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline) {
        const delimiter = buffer.indexOf('\n\n');
        if (delimiter >= 0) {
          const raw = buffer.slice(0, delimiter);
          buffer = buffer.slice(delimiter + 2);
          const data = raw
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n');
          if (data) {
            return JSON.parse(data) as {
              type: string;
              seq?: number;
              properties: Record<string, unknown>;
            };
          }
          continue;
        }
        const remaining = deadline - Date.now();
        const result = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error('Timed out waiting for SSE')), remaining);
          }),
        ]);
        if (result.done) throw new Error('SSE stream ended');
        buffer += decoder.decode(result.value, { stream: true });
      }
      throw new Error('Timed out waiting for SSE');
    },
    cancel: () => reader.cancel().catch(() => undefined),
  };
}

describe('follow-up queue HTTP and SSE lifecycle', () => {
  let root: string;
  let workspace: string;
  let previousStorageRoot: string | undefined;
  let previousConfig: ReturnType<typeof getState>['config']['config'];

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'blade-follow-up-routes-'));
    workspace = path.join(root, 'workspace');
    previousStorageRoot = process.env.BLADE_STORAGE_ROOT;
    previousConfig = getState().config.config;
    process.env.BLADE_STORAGE_ROOT = path.join(root, 'storage');
    await mkdir(workspace, { recursive: true });
    getState().config.actions.setConfig(
      createDefaultMockConfig({
        agentTeamsEnabled: false,
        disableAllHooks: true,
        lspServers: {},
        mcpEnabled: false,
        mcpServers: {},
      })
    );
  });

  afterEach(async () => {
    if (previousConfig) getState().config.actions.setConfig(previousConfig);
    if (previousStorageRoot === undefined) delete process.env.BLADE_STORAGE_ROOT;
    else process.env.BLADE_STORAGE_ROOT = previousStorageRoot;
    await rm(root, { recursive: true, force: true });
  });

  it('reads, removes, reorders, conflicts, and publishes committed snapshots', async () => {
    const sessionId = 'follow-up-route-integration';
    await SessionService.createSessionMetadata(sessionId, workspace, {
      title: 'Follow-up route integration',
      taskIsolation: 'local',
      taskStatus: 'completed',
    });
    const mailbox = await ActiveTurnMailbox.create(workspace, sessionId);
    await mailbox.enqueue('first queued request', {
      allowBeforeTurn: true,
      messageId: 'first-follow-up',
    });
    await mailbox.enqueue('second queued request', {
      allowBeforeTurn: true,
      messageId: 'second-follow-up',
    });
    const controller = createSessionRouteController();
    const published: Array<{ type: string; properties: Record<string, unknown> }> = [];
    const unsubscribe = Bus.subscribe((event) => {
      if (event.sessionId === sessionId && event.projectPath === workspace) {
        published.push({ type: event.type, properties: event.properties });
      }
    });
    const query = `?projectPath=${encodeURIComponent(workspace)}`;
    const abort = new AbortController();
    const eventsResponse = await controller.app.request(
      `/${sessionId}/events${query}`,
      { signal: abort.signal }
    );
    const events = createSseCollector(eventsResponse);

    try {
      const connected = await events.next();
      expect(connected).toMatchObject({
        type: 'connected',
        properties: {
          followUpQueue: {
            pending: 2,
            items: [{ id: 'first-follow-up' }, { id: 'second-follow-up' }],
          },
        },
      });
      const beforeResponse = await controller.app.request(
        `/${sessionId}/follow-ups${query}`
      );
      expect(beforeResponse.status).toBe(200);
      const before = FollowUpQueueSnapshotSchema.parse(await beforeResponse.json());
      expect(before.items.map((item) => item.id)).toEqual([
        'first-follow-up',
        'second-follow-up',
      ]);

      const movedResponse = await controller.app.request(
        `/${sessionId}/follow-ups/mutate${query}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            expectedVersion: before.version,
            operation: { type: 'move', messageId: 'second-follow-up', toPosition: 0 },
          }),
        }
      );
      expect(movedResponse.status).toBe(200);
      const moved = FollowUpQueueSnapshotSchema.parse(
        (await movedResponse.json()).snapshot
      );
      expect(moved.items.map((item) => item.id)).toEqual([
        'second-follow-up',
        'first-follow-up',
      ]);
      const changed = await events.next();
      expect(changed).toMatchObject({
        type: 'follow_up.queue.changed',
        properties: { queue: moved },
      });
      expect(changed.seq).toBeUndefined();

      const staleResponse = await controller.app.request(
        `/${sessionId}/follow-ups/mutate${query}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            expectedVersion: before.version,
            operation: { type: 'remove', messageId: 'first-follow-up' },
          }),
        }
      );
      expect(staleResponse.status).toBe(409);
      await expect(staleResponse.json()).resolves.toMatchObject({
        error: { code: 'revision_conflict' },
        snapshot: moved,
      });

      const removedResponse = await controller.app.request(
        `/${sessionId}/follow-ups/mutate${query}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            expectedVersion: moved.version,
            operation: { type: 'remove', messageId: 'first-follow-up' },
          }),
        }
      );
      expect(removedResponse.status).toBe(200);
      const removed = FollowUpQueueSnapshotSchema.parse(
        (await removedResponse.json()).snapshot
      );
      expect(removed.items.map((item) => item.id)).toEqual(['second-follow-up']);
      expect(
        published.filter((event) => event.type === 'follow_up.queue.changed')
      ).toHaveLength(2);
      abort.abort();
      await events.cancel();
    } finally {
      abort.abort();
      await events.cancel();
      unsubscribe();
      await controller.shutdown();
    }
  });
});
