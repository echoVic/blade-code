import { describe, expect, it } from 'vitest';
import type { LoopEvent } from '../../../../src/agent/loop/types.js';
import { projectSessionLoopEvent } from '../../../../src/server/routes/sessionLoopEventProjection.js';

describe('projectSessionLoopEvent', () => {
  it.each([
    [
      {
        kind: 'provider_retry',
        phase: 'scheduled',
        attempt: 1,
        maxRetries: 2,
        reason: 'server_error',
        statusCode: 503,
        delayMs: 750,
        nextRetryAt: 1_750,
      } satisfies LoopEvent,
      'provider.retry',
      false,
      { attempt: 1, statusCode: 503, delayMs: 750 },
    ],
    [
      {
        kind: 'mcp_log',
        revision: 3,
        serverName: 'docs',
        level: 'warning',
        logger: 'remote',
        message: 'slow response',
        projectedBytes: 13,
        dataSha256: 'a'.repeat(64),
        truncated: false,
        detailsOmitted: true,
        timestamp: 1_000,
      } satisfies LoopEvent,
      'mcp.log',
      true,
      { serverName: 'docs', detailsOmitted: true, timestamp: 1_000 },
    ],
  ])(
    'projects $kind through its explicit surface allowlist',
    (event, type, messageScoped, properties) => {
      expect(projectSessionLoopEvent(event)).toEqual({
        type,
        messageScoped,
        properties: expect.objectContaining(properties),
      });
    }
  );

  it('formats tool results once for every session surface', () => {
    expect(
      projectSessionLoopEvent({
        kind: 'tool_result',
        toolCall: {
          id: 'call-1',
          type: 'function',
          function: { name: 'Read', arguments: '{"path":"README.md"}' },
        },
        result: {
          success: true,
          llmContent: 'file contents',
          metadata: { summary: 'Read README.md' },
        },
      })
    ).toEqual({
      type: 'tool.result',
      messageScoped: true,
      toolName: 'Read',
      properties: {
        toolName: 'Read',
        toolCallId: 'call-1',
        success: true,
        summary: 'Read README.md',
        output: '[OK] Read README.md\nfile contents',
        metadata: { summary: 'Read README.md' },
      },
    });
  });

  it('leaves surface-specific stream events to their consumers', () => {
    expect(
      projectSessionLoopEvent({ kind: 'content_delta', delta: 'partial' })
    ).toBeUndefined();
  });
});
