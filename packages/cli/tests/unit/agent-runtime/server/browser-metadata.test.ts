import { describe, expect, it } from 'vitest';
import { sanitizeToolMetadata } from '../../../../src/server/routes/session.js';

describe('Browser tool metadata projection', () => {
  it('keeps only bounded Browser facts and validated screenshot descriptors', () => {
    const hash = 'a'.repeat(64);
    const projected = sanitizeToolMetadata('BrowserInspect', {
      summary: 'BrowserInspect: ok',
      secret: 'must-not-survive',
      browser: {
        action: 'BrowserInspect',
        status: 'ok',
        pageId: 'browser_page_123e4567-e89b-12d3-a456-426614174000',
        snapshotId: 'browser_snapshot_123e4567-e89b-12d3-a456-426614174000',
        origin: 'https://example.com:443',
        url: 'https://example.com/path?token=%5Bredacted%5D',
        title: 'Example',
        truncated: false,
        actionApplied: true,
        sideEffectsUncertain: false,
        diagnosticCount: 2,
        snapshot: 'private page text',
        console: ['private console'],
        headers: { authorization: 'secret' },
        artifact: {
          id: hash,
          sha256: hash,
          kind: 'image',
          mimeType: 'image/png',
          size: 1024,
          persisted: true,
          path: '/private/browser.png',
          bytes: 'base64-secret',
        },
      },
    });

    expect(projected).toEqual({
      summary: 'BrowserInspect: ok',
      browser: {
        action: 'BrowserInspect',
        status: 'ok',
        pageId: 'browser_page_123e4567-e89b-12d3-a456-426614174000',
        snapshotId: 'browser_snapshot_123e4567-e89b-12d3-a456-426614174000',
        origin: 'https://example.com:443',
        url: 'https://example.com/path?token=%5Bredacted%5D',
        title: 'Example',
        truncated: false,
        actionApplied: true,
        sideEffectsUncertain: false,
        diagnosticCount: 2,
        artifact: {
          id: hash,
          sha256: hash,
          kind: 'image',
          mimeType: 'image/png',
          size: 1024,
          persisted: true,
          path: '/private/browser.png',
        },
      },
    });
    expect(JSON.stringify(projected)).not.toContain('private page text');
    expect(JSON.stringify(projected)).not.toContain('private console');
    expect(JSON.stringify(projected)).not.toContain('authorization');
    expect(JSON.stringify(projected)).not.toContain('base64-secret');
  });

  it('drops malformed Browser IDs and artifacts', () => {
    const projected = sanitizeToolMetadata('BrowserSnapshot', {
      browser: {
        action: 'BrowserSnapshot',
        status: 'ok',
        pageId: '../escape',
        snapshotId: 'stale',
        artifact: {
          id: 'bad',
          sha256: 'different',
          kind: 'image',
          mimeType: 'image/png',
          size: Number.MAX_SAFE_INTEGER,
          persisted: true,
        },
      },
    });

    expect(projected).toEqual({
      browser: {
        action: 'BrowserSnapshot',
        status: 'ok',
      },
    });
  });
});
