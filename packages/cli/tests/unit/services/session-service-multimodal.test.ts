import { describe, expect, it } from 'vitest';

describe('SessionService multimodal messages', () => {
  it('round-trips multimodal user messages with image parts intact', async () => {
    const { SessionService } = await import('../../../src/services/SessionService.js');

    const messages = SessionService.convertJSONLToMessages([
      {
        id: 'e1',
        sessionId: 'session-1',
        type: 'message_created',
        timestamp: '2026-03-31T00:00:00.000Z',
        cwd: '/project',
        version: '0.0.0',
        data: { messageId: 'm1', role: 'user', createdAt: '2026-03-31T00:00:00.000Z' },
      },
      {
        id: 'e2',
        sessionId: 'session-1',
        type: 'part_created',
        timestamp: '2026-03-31T00:00:01.000Z',
        cwd: '/project',
        version: '0.0.0',
        data: {
          partId: 'p1',
          messageId: 'm1',
          partType: 'text',
          payload: { text: 'caption' },
          createdAt: '2026-03-31T00:00:01.000Z',
        },
      },
      {
        id: 'e3',
        sessionId: 'session-1',
        type: 'part_created',
        timestamp: '2026-03-31T00:00:02.000Z',
        cwd: '/project',
        version: '0.0.0',
        data: {
          partId: 'p2',
          messageId: 'm1',
          partType: 'image',
          payload: { mimeType: 'image/png', dataUrl: 'data:image/png;base64,abc' },
          createdAt: '2026-03-31T00:00:02.000Z',
        },
      },
    ] as never);

    expect(messages).toMatchObject([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'caption' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
        ],
      },
    ]);
  });

  it('round-trips image-only user messages with image parts intact', async () => {
    const { SessionService } = await import('../../../src/services/SessionService.js');

    const messages = SessionService.convertJSONLToMessages([
      {
        id: 'e1',
        sessionId: 'session-1',
        type: 'message_created',
        timestamp: '2026-03-31T00:00:00.000Z',
        cwd: '/project',
        version: '0.0.0',
        data: { messageId: 'm2', role: 'user', createdAt: '2026-03-31T00:00:00.000Z' },
      },
      {
        id: 'e2',
        sessionId: 'session-1',
        type: 'part_created',
        timestamp: '2026-03-31T00:00:01.000Z',
        cwd: '/project',
        version: '0.0.0',
        data: {
          partId: 'p2',
          messageId: 'm2',
          partType: 'image',
          payload: {
            mimeType: 'image/png',
            dataUrl: 'data:image/png;base64,image-only',
          },
          createdAt: '2026-03-31T00:00:01.000Z',
        },
      },
    ] as never);

    expect(messages).toMatchObject([
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: 'data:image/png;base64,image-only' },
          },
        ],
      },
    ]);
  });
});
