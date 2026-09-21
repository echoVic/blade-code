import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpResponseError, requestJson } from '@/lib/http';
import { sessionService } from '@/services/sessionService';

describe('session SSE handshake deadlines', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function setup(maxRetries = 2, onConnected?: () => void) {
    vi.useFakeTimers();
    const connections: EventSourceDouble[] = [];
    class EventSourceDouble {
      static CLOSED = 2;
      readyState = 0;
      onmessage: ((event: { data: string }) => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(readonly url: string) {
        connections.push(this);
      }
      close() {
        this.readyState = EventSourceDouble.CLOSED;
      }
    }
    vi.stubGlobal('EventSource', EventSourceDouble);
    const ref = { sessionId: 'handshake-session', projectPath: '/workspace' };
    const state = vi.fn();
    const pending = sessionService.openEventSubscription(ref, () => undefined, {
      maxRetries,
      onConnectionStateChange: (next) => {
        state(next);
        if (next === 'connected') onConnected?.();
      },
    });
    const ready = (index: number) =>
      connections[index].onmessage?.({
        data: JSON.stringify({
          type: 'connected',
          properties: { ...ref, status: 'idle' },
        }),
      });
    return { connections, pending, ready, state };
  }

  it('bounds the first handshake without silently retrying submission setup', async () => {
    const test = setup();
    const failure = expect(test.pending).rejects.toThrow(
      'Timed out waiting for event subscription readiness'
    );
    await vi.advanceTimersByTimeAsync(10_000);
    await failure;
    expect(test.connections).toHaveLength(1);
    expect(test.connections[0].readyState).toBe(2);
    expect(test.state).toHaveBeenLastCalledWith('offline');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('times out a silent reconnect and clears its deadline after the next handshake', async () => {
    const test = setup();
    test.ready(0);
    const close = await test.pending;
    try {
      test.connections[0].onerror?.();
      await vi.advanceTimersByTimeAsync(1000);
      expect(test.connections).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(9999);
      expect(test.connections[1].readyState).not.toBe(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(test.connections[1].readyState).toBe(2);
      await vi.advanceTimersByTimeAsync(2000);
      expect(test.connections).toHaveLength(3);
      test.ready(2);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(test.connections[2].readyState).not.toBe(2);
      expect(test.state).toHaveBeenLastCalledWith('connected');
      expect(test.connections).toHaveLength(3);
    } finally {
      close();
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it('exhausts the existing retry budget when every reconnect handshake stalls', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const test = setup(2);
    test.ready(0);
    const close = await test.pending;
    try {
      test.connections[0].onerror?.();
      await vi.advanceTimersByTimeAsync(1000 + 10_000 + 2000 + 10_000);
      expect(test.connections).toHaveLength(3);
      expect(test.connections.every((source) => source.readyState === 2)).toBe(true);
      expect(test.state).toHaveBeenLastCalledWith('offline');
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(test.connections).toHaveLength(3);
    } finally {
      close();
    }
  });

  it('does not restart heartbeat timers when closed from the reconnect notification', async () => {
    let close: (() => void) | undefined;
    const test = setup(2, () => close?.());
    test.ready(0);
    close = await test.pending;
    try {
      test.connections[0].onerror?.();
      await vi.advanceTimersByTimeAsync(1000);
      test.ready(1);
      expect(test.connections[1].readyState).toBe(2);
      expect(vi.getTimerCount()).toBe(0);
      test.state.mockClear();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(test.state).not.toHaveBeenCalled();
      expect(test.connections).toHaveLength(2);
    } finally {
      close();
    }
  });

  it('cancels a pending reconnect handshake deadline on manual close', async () => {
    const test = setup();
    test.ready(0);
    const close = await test.pending;
    test.connections[0].onerror?.();
    await vi.advanceTimersByTimeAsync(1000);
    close();
    test.state.mockClear();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(test.connections).toHaveLength(2);
    expect(test.connections[1].readyState).toBe(2);
    expect(test.state).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('requestJson', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('suppresses pending resume only on the initial pre-submission SSE connection', async () => {
    vi.useFakeTimers();
    const connections: EventSourceDouble[] = [];
    class EventSourceDouble {
      static CLOSED = 2;
      readyState = 0;
      onmessage: ((event: { data: string }) => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(readonly url: string) {
        connections.push(this);
      }
      close() {
        this.readyState = EventSourceDouble.CLOSED;
      }
    }
    vi.stubGlobal('EventSource', EventSourceDouble);
    const ref = { sessionId: 'sse-submission', projectPath: '/workspace' };
    const pending = sessionService.openEventSubscription(ref, () => undefined, {
      resumePending: false,
    });
    let close: (() => void) | undefined;
    try {
      expect(
        new URL(connections[0].url, 'http://test').searchParams.get('resume')
      ).toBe('false');
      connections[0].onmessage?.({
        data: JSON.stringify({
          type: 'connected',
          properties: { ...ref, status: 'idle' },
        }),
      });
      close = await pending;
      connections[0].onmessage?.({
        data: JSON.stringify({
          seq: 7,
          type: 'committed.message_created',
          properties: { ...ref },
        }),
      });
      connections[0].onerror?.();
      await vi.advanceTimersByTimeAsync(1000);
      expect(connections).toHaveLength(2);
      const reconnect = new URL(connections[1].url, 'http://test');
      expect(reconnect.searchParams.has('resume')).toBe(false);
      expect(reconnect.searchParams.get('lastEventId')).toBe('7');
      expect(reconnect.searchParams.get('projectPath')).toBe(ref.projectPath);
    } finally {
      close?.();
    }
  });

  it('ignores callbacks from a retired SSE source without closing its replacement', async () => {
    vi.useFakeTimers();
    const connections: EventSourceDouble[] = [];
    class EventSourceDouble {
      static CLOSED = 2;
      readyState = 0;
      onmessage: ((event: { data: string }) => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(readonly url: string) {
        connections.push(this);
      }
      close() {
        this.readyState = EventSourceDouble.CLOSED;
      }
    }
    vi.stubGlobal('EventSource', EventSourceDouble);
    const ref = { sessionId: 'generation-session', projectPath: '/workspace' };
    const onEvent = vi.fn();
    const onConnectionStateChange = vi.fn();
    const pending = sessionService.openEventSubscription(ref, onEvent, {
      onConnectionStateChange,
    });
    const first = connections[0];
    const oldMessage = first.onmessage;
    const oldError = first.onerror;
    oldMessage?.({
      data: JSON.stringify({
        type: 'connected',
        properties: { ...ref, status: 'idle' },
      }),
    });
    const close = await pending;
    try {
      oldMessage?.({
        data: JSON.stringify({
          seq: 7,
          type: 'committed.message_created',
          properties: ref,
        }),
      });
      oldError?.();
      await vi.advanceTimersByTimeAsync(1000);
      const replacement = connections[1];
      replacement.onmessage?.({
        data: JSON.stringify({
          type: 'connected',
          properties: { ...ref, status: 'idle' },
        }),
      });
      onEvent.mockClear();
      onConnectionStateChange.mockClear();
      oldMessage?.({
        data: JSON.stringify({
          seq: 999,
          type: 'committed.message_created',
          properties: ref,
        }),
      });
      oldError?.();
      expect(onEvent).not.toHaveBeenCalled();
      expect(onConnectionStateChange).not.toHaveBeenCalled();
      expect(replacement.readyState).not.toBe(EventSourceDouble.CLOSED);
      replacement.onerror?.();
      await vi.advanceTimersByTimeAsync(1000);
      expect(connections).toHaveLength(3);
      expect(
        new URL(connections[2].url, 'http://test').searchParams.get('lastEventId')
      ).toBe('7');
    } finally {
      close();
    }
  });

  it('does not advance an SSE cursor for malformed or foreign-session events', async () => {
    vi.useFakeTimers();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const connections: EventSourceDouble[] = [];
    class EventSourceDouble {
      static CLOSED = 2;
      readyState = 0;
      onmessage: ((event: { data: string }) => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(readonly url: string) {
        connections.push(this);
      }
      close() {
        this.readyState = EventSourceDouble.CLOSED;
      }
    }
    vi.stubGlobal('EventSource', EventSourceDouble);
    const ref = { sessionId: 'cursor-session', projectPath: '/workspace' };
    const onEvent = vi.fn();
    const pending = sessionService.openEventSubscription(ref, onEvent);
    const source = connections[0];
    const emit = (event: unknown) =>
      source.onmessage?.({ data: JSON.stringify(event) });
    emit({ type: 'connected', properties: { ...ref, status: 'idle' } });
    const close = await pending;
    try {
      emit({ seq: 7, type: 'committed.message_created', properties: ref });
      onEvent.mockClear();
      emit({ seq: 99, properties: ref });
      emit({
        seq: 100,
        type: 'committed.message_created',
        properties: { ...ref, sessionId: 'other-session' },
      });
      emit({
        seq: 101,
        type: 'committed.message_created',
        properties: { ...ref, projectPath: '/other-workspace' },
      });
      expect(onEvent).not.toHaveBeenCalled();
      source.onerror?.();
      await vi.advanceTimersByTimeAsync(1000);
      expect(
        new URL(connections[1].url, 'http://test').searchParams.get('lastEventId')
      ).toBe('7');
    } finally {
      close();
      consoleError.mockRestore();
    }
  });

  it('keeps the current SSE connection alive on unscoped heartbeats without advancing its cursor', async () => {
    vi.useFakeTimers();
    const connections: EventSourceDouble[] = [];
    class EventSourceDouble {
      static CLOSED = 2;
      readyState = 0;
      onmessage: ((event: { data: string }) => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(readonly url: string) {
        connections.push(this);
      }
      close() {
        this.readyState = EventSourceDouble.CLOSED;
      }
    }
    vi.stubGlobal('EventSource', EventSourceDouble);
    const ref = { sessionId: 'heartbeat-session', projectPath: '/workspace' };
    const onEvent = vi.fn();
    const pending = sessionService.openEventSubscription(ref, onEvent);
    const source = connections[0];
    const emit = (event: unknown) =>
      source.onmessage?.({ data: JSON.stringify(event) });
    emit({ type: 'connected', properties: { ...ref, status: 'idle' } });
    const close = await pending;
    try {
      emit({ seq: 7, type: 'committed.message_created', properties: ref });
      onEvent.mockClear();
      await vi.advanceTimersByTimeAsync(30_000);
      emit({ seq: 999, type: 'heartbeat', properties: { timestamp: Date.now() } });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(source.readyState).not.toBe(EventSourceDouble.CLOSED);
      expect(connections).toHaveLength(1);
      expect(onEvent).not.toHaveBeenCalled();
      source.onerror?.();
      await vi.advanceTimersByTimeAsync(1000);
      expect(
        new URL(connections[1].url, 'http://test').searchParams.get('lastEventId')
      ).toBe('7');
    } finally {
      close();
    }
  });

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
