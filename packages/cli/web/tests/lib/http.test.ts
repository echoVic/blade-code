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
            error: { message: 'No model is configured' },
          }),
          {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          }
        )
      )
    );

    await expect(requestJson('/value')).rejects.toThrow('No model is configured');
  });
});
