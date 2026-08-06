import { describe, expect, it } from 'vitest';
import { Bus } from '../../../../src/server/bus.js';
import { EventRoutes } from '../../../../src/server/routes/events.js';

async function readSseEvent(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder
): Promise<string> {
  let buffer = '';
  while (!buffer.includes('\n\n')) {
    const result = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Timed out waiting for SSE event')), 2000)
      ),
    ]);
    if (result.done) throw new Error('SSE stream ended before the next event');
    buffer += decoder.decode(result.value, { stream: true });
  }
  return buffer;
}

describe('EventRoutes global task feed', () => {
  it('forwards only task lifecycle events without prompt or tool payloads', async () => {
    const controller = new AbortController();
    const response = await EventRoutes().request('/', {
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Expected an SSE response body');
    const decoder = new TextDecoder();

    try {
      const connected = await readSseEvent(reader, decoder);
      expect(connected).toContain('"type":"connected"');

      Bus.publish(
        { sessionId: 'session-1', projectPath: '/workspace/a' },
        'message.created',
        { content: 'private prompt' }
      );
      Bus.publish(
        { sessionId: 'session-1', projectPath: '/workspace/a' },
        'tool.started',
        { arguments: { secret: 'private tool arguments' } }
      );
      Bus.publish(
        { sessionId: 'session-1', projectPath: '/workspace/a' },
        'task.status',
        {
          taskStatus: 'running',
          taskStartedAt: '2026-08-05T12:00:00.000Z',
          taskDiffStat: {
            changedFiles: 2,
            additions: 7,
            deletions: 1,
            commits: 0,
          },
          taskQueuePosition: 2,
          taskQueueDepth: 4,
          taskConcurrencyLimit: 3,
          taskInFlight: 1,
          prompt: 'private prompt in task event',
          arguments: { secret: 'private task arguments' },
        }
      );

      const taskEvent = await readSseEvent(reader, decoder);
      expect(taskEvent).toContain('"type":"task.status"');
      expect(taskEvent).toContain('"sessionId":"session-1"');
      expect(taskEvent).toContain('"projectPath":"/workspace/a"');
      expect(taskEvent).toContain('"taskStatus":"running"');
      expect(taskEvent).toContain(
        '"taskDiffStat":{"changedFiles":2,"additions":7,"deletions":1,"commits":0}'
      );
      expect(taskEvent).toContain('"taskQueuePosition":2');
      expect(taskEvent).toContain('"taskQueueDepth":4');
      expect(taskEvent).toContain('"taskConcurrencyLimit":3');
      expect(taskEvent).toContain('"taskInFlight":1');
      expect(taskEvent).not.toContain('private prompt');
      expect(taskEvent).not.toContain('private tool arguments');
      expect(taskEvent).not.toContain('private task arguments');
    } finally {
      controller.abort();
      await reader.cancel();
    }
  });
});
