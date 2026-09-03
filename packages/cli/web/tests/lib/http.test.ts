import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpResponseError, requestJson } from '@/lib/http';

describe('requestJson', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('returns parsed JSON for a successful response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ value: 42 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    );

    await expect(requestJson<{ value: number }>('/value')).resolves.toEqual({
      value: 42,
    });
  });

  it('surfaces the server error message for a failed response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'Connection refused' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    );

    await expect(requestJson('/value')).rejects.toEqual(
      expect.objectContaining<HttpResponseError>({
        message: 'Connection refused',
        name: 'HttpResponseError',
        status: 503,
      })
    );
  });

  it('surfaces Blade nested error messages', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              code: 'SESSION_WORKSPACE_UNAVAILABLE',
              message: 'This session workspace is no longer available',
            },
          }),
          {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          }
        )
      )
    );

    await expect(requestJson('/value')).rejects.toEqual(
      expect.objectContaining<HttpResponseError>({
        code: 'SESSION_WORKSPACE_UNAVAILABLE',
        message: 'This session workspace is no longer available',
        name: 'HttpResponseError',
        status: 400,
      })
    );
  });

  it('surfaces session surface fixed error codes from nested envelopes', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              code: 'session_surface_cursor_invalid',
              message: 'The requested history cursor is no longer valid.',
              retryable: false,
            },
          }),
          {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          }
        )
      )
    );

    await expect(requestJson('/sessions/v2/history')).rejects.toEqual(
      expect.objectContaining<HttpResponseError>({
        code: 'session_surface_cursor_invalid',
        message: 'The requested history cursor is no longer valid.',
        name: 'HttpResponseError',
        status: 400,
      })
    );
  });
});
