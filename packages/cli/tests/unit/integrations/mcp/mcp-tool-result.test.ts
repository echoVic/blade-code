import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  MAX_MCP_TOOL_ERROR_BYTES,
  MAX_MCP_TOOL_RESULT_CONTENTS,
  MAX_MCP_TOOL_TEXT_PART_BYTES,
  type McpToolArtifactWriter,
  normalizeMcpToolResult,
  sanitizeMcpToolError,
} from '../../../../src/mcp/McpToolResult.js';

function writer(): McpToolArtifactWriter & {
  write: ReturnType<typeof vi.fn>;
} {
  return {
    write: vi.fn(async (request) => {
      const sha256 = createHash('sha256').update(request.bytes).digest('hex');
      return {
        id: sha256,
        kind: request.kind,
        size: request.bytes.length,
        sha256,
        persisted: true,
        mimeType: request.mimeType,
        sourceUri: request.sourceUri,
        path: `/private/artifacts/${sha256}.bin`,
      };
    }),
  };
}

describe('MCP tool result normalization', () => {
  it('preserves bounded text and structured content while summarizing binary parts', async () => {
    const artifacts = writer();
    const image = Buffer.from('image-bytes').toString('base64');
    const audio = Buffer.from('audio-bytes').toString('base64');
    const blob = Buffer.from('resource-bytes').toString('base64');
    const result = await normalizeMcpToolResult(
      {
        content: [
          { type: 'text', text: 'FIRST_TEXT' },
          {
            type: 'resource',
            resource: {
              uri: 'context://inline',
              mimeType: 'text/plain',
              text: 'RESOURCE_TEXT',
            },
          },
          {
            type: 'resource_link',
            uri: 'context://linked',
            name: 'linked',
            description: 'Linked context',
            mimeType: 'text/plain',
            _meta: { secret: 'do-not-project' },
          },
          { type: 'image', data: image, mimeType: 'image/png' },
          { type: 'audio', data: audio, mimeType: 'audio/wav' },
          {
            type: 'resource',
            resource: {
              uri: 'context://binary',
              mimeType: 'application/octet-stream',
              blob,
              _meta: { secret: 'do-not-project' },
            },
          },
        ],
        structuredContent: {
          marker: 'STRUCTURED_MARKER',
          nested: { count: 2 },
        },
        _meta: {
          bearer: 'do-not-project',
        },
      },
      artifacts
    );

    expect(result.isError).toBe(false);
    expect(result.llmContent).toContain('FIRST_TEXT');
    expect(result.llmContent).toContain('RESOURCE_TEXT');
    expect(result.llmContent).toContain('context://linked');
    expect(result.llmContent).toContain('STRUCTURED_MARKER');
    expect(result.llmContent).toContain('image artifact:');
    expect(result.llmContent).toContain('audio artifact:');
    expect(result.llmContent).toContain('resource artifact:');
    expect(result.llmContent).not.toContain(image);
    expect(result.llmContent).not.toContain(audio);
    expect(result.llmContent).not.toContain(blob);
    expect(JSON.stringify(result)).not.toContain('do-not-project');
    expect(result.metadata).toMatchObject({
      contentCount: 6,
      artifactCount: 3,
      binaryOmitted: true,
      truncated: false,
    });
    expect(artifacts.write).toHaveBeenCalledTimes(3);
  });

  it('persists oversized normalized text and returns bounded head/tail previews', async () => {
    const artifacts = writer();
    const middle = 'x'.repeat(120 * 1024);
    const result = await normalizeMcpToolResult(
      {
        content: [
          {
            type: 'text',
            text: `HEAD_MARKER\n${middle}\nTAIL_MARKER`,
          },
        ],
      },
      artifacts
    );

    expect(result.metadata.truncated).toBe(true);
    expect(result.metadata.artifactCount).toBe(1);
    expect(result.llmContent).toContain('HEAD_MARKER');
    expect(result.llmContent).toContain('TAIL_MARKER');
    expect(result.llmContent).toContain('/private/artifacts/');
    expect(Buffer.byteLength(result.llmContent)).toBeLessThan(16 * 1024);
    expect(artifacts.write).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'text',
        mimeType: 'text/plain',
      })
    );
  });

  it('preserves the protocol error bit without trusting raw error metadata', async () => {
    const result = await normalizeMcpToolResult({
      content: [{ type: 'text', text: 'REMOTE_FAILURE' }],
      isError: true,
      _meta: { raw: 'secret' },
    });

    expect(result.isError).toBe(true);
    expect(result.llmContent).toBe('REMOTE_FAILURE');
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it.each([
    [
      {
        content: Array.from({ length: MAX_MCP_TOOL_RESULT_CONTENTS + 1 }, () => ({
          type: 'text',
          text: 'x',
        })),
      },
      'content parts',
    ],
    [
      {
        content: [
          {
            type: 'text',
            text: 'x'.repeat(MAX_MCP_TOOL_TEXT_PART_BYTES + 1),
          },
        ],
      },
      'text',
    ],
    [
      {
        content: [
          {
            type: 'image',
            mimeType: 'image/png',
            data: 'not-base64',
          },
        ],
      },
      'base64',
    ],
    [{ content: [{ type: 'unknown' }] }, 'Unsupported'],
    [{ content: [], structuredContent: [] }, 'structuredContent'],
  ])('rejects malformed or excessive results %#', async (result, expected) => {
    await expect(normalizeMcpToolResult(result)).rejects.toThrow(expected);
  });

  it('redacts and bounds untrusted tool errors', () => {
    const result = sanitizeMcpToolError(
      new Error(
        `GET https://example.test/private?token=secret Bearer token-value ` +
          `sk-${'x'.repeat(80)} \0${'你'.repeat(4_096)}`
      )
    );

    expect(result).toContain('[redacted-url]');
    expect(result).toContain('Bearer [redacted]');
    expect(result).not.toContain('token-value');
    expect(result).not.toContain('sk-');
    expect(result).not.toContain('\0');
    expect(Buffer.byteLength(result)).toBeLessThanOrEqual(MAX_MCP_TOOL_ERROR_BYTES);
  });
});
