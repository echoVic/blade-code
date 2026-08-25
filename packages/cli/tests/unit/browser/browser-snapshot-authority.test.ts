import { describe, expect, it } from 'vitest';
import {
  BrowserSnapshotAuthority,
  boundBrowserSnapshot,
} from '../../../src/browser/BrowserSnapshotAuthority.js';
import {
  MAX_BROWSER_FINGERPRINT_BYTES,
  MAX_BROWSER_SNAPSHOT_BYTES,
} from '../../../src/browser/constants.js';

describe('BrowserSnapshotAuthority', () => {
  it('issues opaque latest snapshot identities with ref fingerprints', () => {
    const authority = new BrowserSnapshotAuthority();
    const first = authority.issue({
      pageId: 'page-a',
      pageGeneration: 1,
      origin: 'https://example.com:443',
      snapshot: '- button "Save" [ref=f5e1]\n- textbox "Name" [ref=e2]',
      depth: 12,
      includeBoxes: false,
    });
    const validation = authority.validate({
      pageId: 'page-a',
      snapshotId: first.snapshotId,
      pageGeneration: 1,
      origin: 'https://example.com:443',
      ref: 'f5e1',
    });

    expect(first.snapshotId).toMatch(/^browser_snapshot_/);
    expect(validation.fingerprint).toBe('- button "Save"');
    authority.verifyFreshFingerprint(
      validation,
      '- button "Save" [ref=f5e1]\n- textbox "Name" [ref=e2]'
    );
  });

  it('rejects stale identity, generation, origin, and refs', () => {
    const authority = new BrowserSnapshotAuthority();
    const record = authority.issue({
      pageId: 'page-a',
      pageGeneration: 2,
      origin: 'https://example.com:443',
      snapshot: '- button "Save" [ref=e1]',
      depth: 12,
      includeBoxes: false,
    });

    for (const candidate of [
      { snapshotId: 'old', pageGeneration: 2, origin: record.origin, ref: 'e1' },
      {
        snapshotId: record.snapshotId,
        pageGeneration: 3,
        origin: record.origin,
        ref: 'e1',
      },
      {
        snapshotId: record.snapshotId,
        pageGeneration: 2,
        origin: 'https://other.test:443',
        ref: 'e1',
      },
      {
        snapshotId: record.snapshotId,
        pageGeneration: 2,
        origin: record.origin,
        ref: 'e9',
      },
    ]) {
      expect(() =>
        authority.validate({
          pageId: 'page-a',
          ...candidate,
        })
      ).toThrow('snapshot');
    }
  });

  it('rejects a fresh snapshot whose ref fingerprint changed', () => {
    const authority = new BrowserSnapshotAuthority();
    const record = authority.issue({
      pageId: 'page-a',
      pageGeneration: 1,
      origin: 'https://example.com:443',
      snapshot: '- button "Delete" [ref=e1]',
      depth: 12,
      includeBoxes: false,
    });
    const validation = authority.validate({
      pageId: 'page-a',
      snapshotId: record.snapshotId,
      pageGeneration: 1,
      origin: record.origin,
      ref: 'e1',
    });

    expect(() =>
      authority.verifyFreshFingerprint(
        validation,
        '- button "Confirm purchase" [ref=e1]'
      )
    ).toThrow('changed');
  });

  it('preserves an oversized fingerprint signal for fail-closed control checks', () => {
    const authority = new BrowserSnapshotAuthority();
    const label = 'x'.repeat(MAX_BROWSER_FINGERPRINT_BYTES + 1);
    const record = authority.issue({
      pageId: 'page-a',
      pageGeneration: 1,
      origin: 'https://example.com:443',
      snapshot: `- textbox "${label}" [ref=e1]`,
      depth: 12,
      includeBoxes: false,
    });

    const validation = authority.validate({
      pageId: 'page-a',
      snapshotId: record.snapshotId,
      pageGeneration: 1,
      origin: record.origin,
      ref: 'e1',
    });

    expect(Buffer.byteLength(validation.fingerprint)).toBeLessThanOrEqual(
      MAX_BROWSER_FINGERPRINT_BYTES
    );
    expect(validation.fingerprintExceededLimit).toBe(true);
  });

  it('ignores Playwright box annotations in fingerprints', () => {
    const authority = new BrowserSnapshotAuthority();
    const record = authority.issue({
      pageId: 'page-a',
      pageGeneration: 1,
      origin: 'https://example.com:443',
      snapshot: '- button "Save" [ref=e1] [box=0,0,20,20]',
      depth: 12,
      includeBoxes: true,
    });
    const validation = authority.validate({
      pageId: 'page-a',
      snapshotId: record.snapshotId,
      pageGeneration: 1,
      origin: record.origin,
      ref: 'e1',
    });

    authority.verifyFreshFingerprint(
      validation,
      '- button "Save" [ref=e1] [box=1,2,20,20]'
    );
  });

  it('rejects duplicate refs', () => {
    const authority = new BrowserSnapshotAuthority();
    expect(() =>
      authority.issue({
        pageId: 'page-a',
        pageGeneration: 1,
        origin: 'https://example.com:443',
        snapshot: '- button "One" [ref=e1]\n- button "Two" [ref=e1]',
        depth: 12,
        includeBoxes: false,
      })
    ).toThrow('duplicate ref');
  });

  it('bounds snapshots by complete UTF-8 lines', () => {
    const input = `${'line\n'.repeat(MAX_BROWSER_SNAPSHOT_BYTES)}结束`;
    const result = boundBrowserSnapshot(input);

    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.snapshot)).toBeLessThanOrEqual(
      MAX_BROWSER_SNAPSHOT_BYTES
    );
    expect(result.snapshot).toContain('browser snapshot truncated');
    expect(result.snapshot).not.toContain('\uFFFD');
  });

  it('invalidates one page or all pages', () => {
    const authority = new BrowserSnapshotAuthority();
    const record = authority.issue({
      pageId: 'page-a',
      pageGeneration: 1,
      origin: 'https://example.com:443',
      snapshot: '- button "Save" [ref=e1]',
      depth: 12,
      includeBoxes: false,
    });
    authority.invalidate('page-a');
    expect(() =>
      authority.validate({
        pageId: 'page-a',
        snapshotId: record.snapshotId,
        pageGeneration: 1,
        origin: record.origin,
        ref: 'e1',
      })
    ).toThrow();

    authority.issue({
      pageId: 'page-b',
      pageGeneration: 1,
      origin: 'https://example.com:443',
      snapshot: '- button "Save" [ref=e2]',
      depth: 12,
      includeBoxes: false,
    });
    authority.clear();
    expect(() =>
      authority.validate({
        pageId: 'page-b',
        snapshotId: 'missing',
        pageGeneration: 1,
        origin: 'https://example.com:443',
        ref: 'e2',
      })
    ).toThrow();
  });
});
