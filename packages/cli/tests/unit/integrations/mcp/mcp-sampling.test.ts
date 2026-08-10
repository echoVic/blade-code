import type { CreateMessageRequest } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import {
  finalizeMcpSamplingResponse,
  normalizeMcpSamplingPolicy,
  normalizeMcpSamplingRequest,
} from '../../../../src/mcp/McpSampling.js';

const baseParams = {
  messages: [
    {
      role: 'user',
      content: {
        type: 'text',
        text: 'Return the release marker.',
      },
    },
  ],
  maxTokens: 512,
} satisfies CreateMessageRequest['params'];

describe('MCP sampling policy', () => {
  it('is disabled by default and clamps requests to explicit server limits', () => {
    expect(normalizeMcpSamplingPolicy(undefined)).toMatchObject({
      enabled: false,
      maxTokens: 1024,
      maxRequestsPerToolCall: 2,
      maxInputBytes: 64 * 1024,
    });
    const policy = normalizeMcpSamplingPolicy({
      enabled: true,
      maxTokens: 128,
      maxRequestsPerToolCall: 1,
      maxInputBytes: 1024,
    });
    expect(normalizeMcpSamplingRequest(baseParams, policy)).toMatchObject({
      maxTokens: 128,
      preview: 'User: Return the release marker.',
    });
  });

  it('rejects invalid policy limits', () => {
    expect(() =>
      normalizeMcpSamplingPolicy({
        enabled: true,
        maxTokens: 4097,
      })
    ).toThrow('sampling.maxTokens');
    expect(() =>
      normalizeMcpSamplingPolicy({
        enabled: true,
        maxRequestsPerToolCall: 0,
      })
    ).toThrow('sampling.maxRequestsPerToolCall');
  });

  it('normalizes text and bounded image input without including image data in preview', () => {
    const policy = normalizeMcpSamplingPolicy({ enabled: true });
    const request = normalizeMcpSamplingRequest(
      {
        systemPrompt: 'You are a release assistant.',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Inspect this image.' },
              {
                type: 'image',
                data: 'aGVsbG8=',
                mimeType: 'image/png',
              },
            ],
          },
        ],
        maxTokens: 64,
        temperature: 0.2,
        stopSequences: ['STOP'],
      } satisfies CreateMessageRequest['params'],
      policy
    );

    expect(request.messages).toEqual([
      { role: 'system', content: 'You are a release assistant.' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Inspect this image.' },
          {
            type: 'image_url',
            image_url: { url: 'data:image/png;base64,aGVsbG8=' },
          },
        ],
      },
    ]);
    expect(request.preview).toContain('[image/png image, 5 bytes]');
    expect(request.preview).not.toContain('aGVsbG8=');
  });

  it('fails closed for unnegotiated tools, server context, tasks, and content', () => {
    const policy = normalizeMcpSamplingPolicy({ enabled: true });
    expect(() =>
      normalizeMcpSamplingRequest(
        {
          ...baseParams,
          includeContext: 'allServers',
        },
        policy
      )
    ).toThrow('context was not negotiated');
    expect(() =>
      normalizeMcpSamplingRequest(
        {
          ...baseParams,
          tools: [
            {
              name: 'unsafe',
              inputSchema: { type: 'object' },
            },
          ],
        },
        policy
      )
    ).toThrow('tools were not negotiated');
    expect(() =>
      normalizeMcpSamplingRequest(
        {
          ...baseParams,
          task: {},
        },
        policy
      )
    ).toThrow('Task-based');
    expect(() =>
      normalizeMcpSamplingRequest(
        {
          ...baseParams,
          messages: [
            {
              role: 'user',
              content: {
                type: 'audio',
                data: 'aGVsbG8=',
                mimeType: 'audio/wav',
              },
            },
          ],
        },
        policy
      )
    ).toThrow('Unsupported MCP sampling content type');
    expect(() =>
      normalizeMcpSamplingRequest(
        {
          ...baseParams,
          messages: [
            {
              role: 'assistant',
              content: {
                type: 'image',
                data: 'aGVsbG8=',
                mimeType: 'image/png',
              },
            },
          ],
        },
        policy
      )
    ).toThrow('only supported in user messages');
    expect(() =>
      normalizeMcpSamplingRequest(
        {
          messages: [
            {
              role: 'user',
              content: {
                type: 'image',
                data: 'aGVsbG8=',
                mimeType: 'image/png',
              },
            },
          ],
          maxTokens: 1,
        },
        normalizeMcpSamplingPolicy({
          enabled: true,
          maxInputBytes: 4,
        })
      )
    ).toThrow('sampling input exceeds 4 bytes');
  });

  it('truncates at the first stop sequence and maps finish reasons', () => {
    const request = normalizeMcpSamplingRequest(
      {
        ...baseParams,
        stopSequences: ['<stop>', '<later>'],
      },
      normalizeMcpSamplingPolicy({ enabled: true })
    );
    expect(
      finalizeMcpSamplingResponse(
        {
          content: 'before<stop>after<later>',
          finishReason: 'stop',
        },
        'session-model',
        request
      )
    ).toEqual({
      model: 'session-model',
      role: 'assistant',
      content: { type: 'text', text: 'before' },
      stopReason: 'stopSequence',
    });
  });
});
