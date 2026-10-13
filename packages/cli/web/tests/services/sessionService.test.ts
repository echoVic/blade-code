import { afterEach, describe, expect, it, vi } from 'vitest';
import { sessionService } from '../../src/services/sessionService';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('sessionService message history', () => {
  it('sends security mode to the native review endpoint', async () => {
    const request = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ reviewId: 'security-1', status: 'running' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    vi.stubGlobal('fetch', request);
    await sessionService.startCodeReview(
      { sessionId: 'session-1', projectPath: '/workspace' },
      { kind: 'uncommitted', mode: 'security' }
    );
    const options = request.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(options.body))).toMatchObject({
      projectPath: '/workspace',
      kind: 'uncommitted',
      mode: 'security',
    });
  });

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
              timestamp: 1_756_944_000_000,
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
        timestamp: 1_756_944_000_000,
      },
    ]);
  });
});
