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
  it('forwards task and interaction lifecycle events without private payloads', async () => {
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
        { sessionId: 'created-session', projectPath: '/workspace/created' },
        'session.created',
        { title: 'private created title', secret: 'private creation metadata' }
      );
      const createdEvent = await readSseEvent(reader, decoder);
      expect(createdEvent).toContain('"type":"session.created"');
      expect(createdEvent).toContain('"sessionId":"created-session"');
      expect(createdEvent).toContain('"projectPath":"/workspace/created"');
      expect(createdEvent).not.toContain('private created title');
      expect(createdEvent).not.toContain('private creation metadata');

      Bus.publish(
        { sessionId: 'deleted-session', projectPath: '/workspace/deleted' },
        'session.deleted',
        { title: 'private deleted title', secret: 'private deletion metadata' }
      );
      const deletedEvent = await readSseEvent(reader, decoder);
      expect(deletedEvent).toContain('"type":"session.deleted"');
      expect(deletedEvent).toContain('"sessionId":"deleted-session"');
      expect(deletedEvent).toContain('"projectPath":"/workspace/deleted"');
      expect(deletedEvent).not.toContain('private deleted title');
      expect(deletedEvent).not.toContain('private deletion metadata');

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
        'permission.asked',
        {
          requestId: 'permission-1',
          toolName: 'Write',
          description: 'private permission description',
          details: { diff: 'private source diff' },
        }
      );

      const pendingEvent = await readSseEvent(reader, decoder);
      expect(pendingEvent).toContain('"type":"interaction.pending"');
      expect(pendingEvent).toContain('"interactionType":"permission"');
      expect(pendingEvent).toContain('"requestId":"permission-1"');
      expect(pendingEvent).not.toContain('Write');
      expect(pendingEvent).not.toContain('private permission description');
      expect(pendingEvent).not.toContain('private source diff');

      Bus.publish(
        { sessionId: 'session-1', projectPath: '/workspace/a' },
        'interaction.resolved',
        {
          requestId: 'permission-1',
          response: { approved: true, secret: 'private response' },
        }
      );

      const resolvedEvent = await readSseEvent(reader, decoder);
      expect(resolvedEvent).toContain('"type":"interaction.resolved"');
      expect(resolvedEvent).toContain('"requestId":"permission-1"');
      expect(resolvedEvent).not.toContain('private response');

      Bus.publish(
        { sessionId: 'session-1', projectPath: '/workspace/a' },
        'question.required',
        {
          requestId: 'question-1',
          questions: [{ question: 'private question' }],
        }
      );
      const questionEvent = await readSseEvent(reader, decoder);
      expect(questionEvent).toContain('"type":"interaction.pending"');
      expect(questionEvent).toContain('"interactionType":"question"');
      expect(questionEvent).toContain('"requestId":"question-1"');
      expect(questionEvent).not.toContain('private question');

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

      Bus.publish(
        { sessionId: 'session-1', projectPath: '/workspace/a' },
        'task.delivery',
        {
          taskDelivery: {
            status: 'applied',
            updatedAt: '2026-08-05T12:05:00.000Z',
            sourceCommit: 'abc123',
            changedFiles: 2,
            internalWorktreePath: '/private/worktree',
          },
          taskWorktreeRemoved: true,
          updatedAt: '2026-08-05T12:05:00.000Z',
          secret: 'private delivery metadata',
        }
      );

      const deliveryEvent = await readSseEvent(reader, decoder);
      expect(deliveryEvent).toContain('"type":"task.delivery"');
      expect(deliveryEvent).toContain(
        '"taskDelivery":{"status":"applied","updatedAt":"2026-08-05T12:05:00.000Z","sourceCommit":"abc123","changedFiles":2}'
      );
      expect(deliveryEvent).toContain('"taskWorktreeRemoved":true');
      expect(deliveryEvent).not.toContain('/private/worktree');
      expect(deliveryEvent).not.toContain('private delivery metadata');

      Bus.publish(
        { sessionId: 'scheduled-session', projectPath: '/workspace/scheduled' },
        'schedule.fired',
        {
          scheduleId: 'schedule-1',
          firedAt: '2026-08-11T09:00:00.000Z',
          runId: 'run-1',
          status: 'running',
          prompt: 'private scheduled prompt',
        }
      );

      const scheduleEvent = await readSseEvent(reader, decoder);
      expect(scheduleEvent).toContain('"type":"schedule.fired"');
      expect(scheduleEvent).toContain('"scheduleId":"schedule-1"');
      expect(scheduleEvent).toContain('"sessionId":"scheduled-session"');
      expect(scheduleEvent).toContain('"runId":"run-1"');
      expect(scheduleEvent).not.toContain('private scheduled prompt');
    } finally {
      controller.abort();
      await reader.cancel();
    }
  });
});
