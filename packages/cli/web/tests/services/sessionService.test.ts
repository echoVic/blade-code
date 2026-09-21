import { afterEach, describe, expect, it, vi } from 'vitest';
import { sessionService } from '../../src/services/sessionService';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('sessionService message history', () => {
  it('preserves durable message ids returned by the server', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify([
            {
              id: 'durable-message-1',
              role: 'assistant',
              content: 'Persisted response',
            },
          ]),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }
        )
      )
    );

    await expect(
      sessionService.getMessages({
        sessionId: 'session-1',
        projectPath: '/workspace',
      })
    ).resolves.toMatchObject([
      {
        id: 'durable-message-1',
        role: 'assistant',
        content: 'Persisted response',
      },
    ]);
  });
});
