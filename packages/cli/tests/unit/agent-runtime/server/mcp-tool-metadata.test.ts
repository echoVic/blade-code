import { describe, expect, it } from 'vitest';
import { sanitizeToolMetadata } from '../../../../src/server/routes/session.js';

describe('MCP tool Web metadata projection', () => {
  it('replaces raw MCP results with a strict structural allowlist', () => {
    const projected = sanitizeToolMetadata({
      summary: 'MCP result',
      mcpResult: {
        isError: false,
        contentCount: 2,
        textBytes: 10,
        structuredBytes: 20,
        artifactCount: 1,
        truncated: true,
        binaryOmitted: true,
        content: [
          {
            type: 'image',
            data: 'RAW_BASE64',
          },
        ],
        structuredContent: {
          secret: 'RAW_STRUCTURED_SECRET',
        },
        _meta: {
          secret: 'RAW_META_SECRET',
        },
        artifacts: [
          {
            id: 'a'.repeat(64),
            sha256: 'a'.repeat(64),
            kind: 'image',
            size: 42,
            persisted: true,
            mimeType: 'image/png',
            path: '/private/artifact.png',
            ignored: 'RAW_ARTIFACT_SECRET',
          },
        ],
      },
    });

    expect(projected).toEqual({
      summary: 'MCP result',
      mcpResult: {
        isError: false,
        contentCount: 2,
        textBytes: 10,
        structuredBytes: 20,
        artifactCount: 1,
        truncated: true,
        binaryOmitted: true,
        artifacts: [
          {
            id: 'a'.repeat(64),
            sha256: 'a'.repeat(64),
            kind: 'image',
            size: 42,
            persisted: true,
            mimeType: 'image/png',
            path: '/private/artifact.png',
          },
        ],
      },
    });
    expect(JSON.stringify(projected)).not.toContain('RAW_');
  });

  it('drops malformed legacy MCP result metadata', () => {
    expect(
      sanitizeToolMetadata({
        summary: 'legacy',
        mcpResult: 'RAW_RESULT',
      })
    ).toEqual({ summary: 'legacy' });
  });
});
