import { describe, expect, it } from 'vitest';
import {
  diffMcpContentCatalog,
  normalizeMcpPromptResult,
  normalizeMcpPrompts,
  normalizeMcpResourceResult,
  normalizeMcpResources,
  normalizeMcpResourceTemplates,
} from '../../../../src/mcp/McpContentCatalog.js';

describe('MCP content catalog', () => {
  it('normalizes resources, templates, and prompt arguments', () => {
    expect(
      normalizeMcpResources([
        {
          uri: 'context://schema',
          name: 'schema',
          description: 'line one\nline two',
          mimeType: 'application/json',
          size: 42,
        },
      ])
    ).toEqual([
      {
        uri: 'context://schema',
        name: 'schema',
        description: 'line one\nline two',
        mimeType: 'application/json',
        size: 42,
      },
    ]);
    expect(
      normalizeMcpResourceTemplates([
        {
          uriTemplate: 'context://item/{id}',
          name: 'item',
          mimeType: 'application/json',
        },
      ])
    ).toEqual([
      {
        uriTemplate: 'context://item/{id}',
        name: 'item',
        mimeType: 'application/json',
      },
    ]);
    expect(
      normalizeMcpPrompts([
        {
          name: 'report',
          description: 'Build a report',
          arguments: [{ name: 'topic', required: true }],
        },
      ])
    ).toEqual([
      {
        name: 'report',
        description: 'Build a report',
        arguments: [{ name: 'topic', required: true }],
      },
    ]);
  });

  it('rejects duplicate identities, unsafe controls, and oversized metadata', () => {
    expect(() =>
      normalizeMcpResources([
        { uri: 'context://same', name: 'one' },
        { uri: 'context://same', name: 'two' },
      ])
    ).toThrow('duplicate "context://same"');
    expect(() =>
      normalizeMcpResourceTemplates([
        { uriTemplate: 'context://bad\u0000/{id}', name: 'bad' },
      ])
    ).toThrow('resource template URI is invalid');
    expect(() =>
      normalizeMcpPrompts([
        {
          name: 'large',
          description: 'x'.repeat(16 * 1024 + 1),
        },
      ])
    ).toThrow('description exceeds 16384 bytes');
  });

  it('keeps all text contents and replaces binary payloads with metadata', () => {
    const encoded = Buffer.from('binary-data').toString('base64');
    const result = normalizeMcpResourceResult({
      contents: [
        { uri: 'context://text', text: 'first', mimeType: 'text/plain' },
        { uri: 'context://text', text: 'second', mimeType: 'text/plain' },
        {
          uri: 'context://binary',
          blob: encoded,
          mimeType: 'application/octet-stream',
        },
      ],
    });
    expect(result.contents).toEqual([
      expect.objectContaining({ text: 'first' }),
      expect.objectContaining({ text: 'second' }),
      {
        uri: 'context://binary',
        mimeType: 'application/octet-stream',
        binary: {
          size: 11,
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          omitted: true,
        },
      },
    ]);
    expect(JSON.stringify(result)).not.toContain(encoded);
    expect(() =>
      normalizeMcpResourceResult({
        contents: [{ uri: 'context://bad', blob: 'not base64' }],
      })
    ).toThrow('invalid base64');
    expect(() =>
      normalizeMcpResourceResult({
        contents: Array.from({ length: 5 }, (_, index) => ({
          uri: `context://part-${index}`,
          text: 'x'.repeat(1024 * 1024),
        })),
      })
    ).toThrow('exceeds 4194304 total bytes');
  });

  it('preserves prompt roles and bounds embedded binary content', () => {
    const encoded = Buffer.from('image').toString('base64');
    const result = normalizeMcpPromptResult({
      description: 'Resolved prompt',
      messages: [
        { role: 'user', content: { type: 'text', text: 'hello' } },
        {
          role: 'assistant',
          content: {
            type: 'image',
            data: encoded,
            mimeType: 'image/png',
          },
        },
        {
          role: 'user',
          content: {
            type: 'resource_link',
            uri: 'context://linked',
            name: 'linked',
          },
        },
      ],
    });
    expect(result).toEqual({
      description: 'Resolved prompt',
      messages: [
        { role: 'user', content: { type: 'text', text: 'hello' } },
        {
          role: 'assistant',
          content: {
            type: 'image',
            mimeType: 'image/png',
            binary: {
              size: 5,
              sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
              omitted: true,
            },
          },
        },
        {
          role: 'user',
          content: {
            type: 'resource_link',
            uri: 'context://linked',
            name: 'linked',
          },
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain(encoded);
  });

  it('reports add/remove/update deltas by protocol identity', () => {
    const before = [
      { uri: 'context://stable', name: 'stable', description: 'v1' },
      { uri: 'context://removed', name: 'removed' },
    ];
    const after = [
      { uri: 'context://stable', name: 'stable', description: 'v2' },
      { uri: 'context://added', name: 'added' },
    ];
    expect(diffMcpContentCatalog(before, after, (item) => item.uri)).toEqual({
      added: ['context://added'],
      removed: ['context://removed'],
      updated: ['context://stable'],
    });
  });
});
