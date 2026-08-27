import { randomUUID } from 'node:crypto';
import { sanitizeBrowserText, sliceUtf8 } from './BrowserSecurity.js';
import {
  MAX_BROWSER_FINGERPRINT_BYTES,
  MAX_BROWSER_SNAPSHOT_BYTES,
} from './constants.js';
import { BrowserRuntimeError, type BrowserViewportSize } from './types.js';

const REF_PATTERN = /\[ref=([a-z][a-z0-9]*)\]/g;
const BOX_PATTERN = /\s+\[box=[^\]]*\]/g;
const TRUNCATION_MARKER = '\n... (browser snapshot truncated)';

export interface BrowserSnapshotAuthorityRecord {
  snapshotId: string;
  pageId: string;
  pageGeneration: number;
  origin: string;
  snapshot: string;
  truncated: boolean;
  depth: number;
  includeBoxes: boolean;
  refs: ReadonlyMap<string, BrowserRefFingerprint>;
}

export interface BrowserSnapshotInput {
  pageId: string;
  pageGeneration: number;
  origin: string;
  snapshot: string;
  depth: number;
  includeBoxes: boolean;
  maxBytes?: number;
}

export interface BrowserSnapshotValidation {
  ref: string;
  fingerprint: string;
  fingerprintExceededLimit: boolean;
  authority: BrowserSnapshotAuthorityRecord;
}

export interface BrowserScreenshotAuthorityRecord {
  screenshotId: string;
  pageId: string;
  pageGeneration: number;
  origin: string;
  sha256: string;
  viewport: BrowserViewportSize;
}

export interface BrowserScreenshotInput {
  pageId: string;
  pageGeneration: number;
  origin: string;
  sha256: string;
  viewport: BrowserViewportSize;
}

interface BrowserRefFingerprint {
  value: string;
  exceededLimit: boolean;
}

function fingerprintLine(line: string, ref: string): BrowserRefFingerprint {
  const withoutRef = line
    .replace(`[ref=${ref}]`, '')
    .replace(BOX_PATTERN, '')
    .trim()
    .replace(/\s+/g, ' ');
  return {
    value: sanitizeBrowserText(withoutRef, MAX_BROWSER_FINGERPRINT_BYTES),
    exceededLimit: Buffer.byteLength(withoutRef) > MAX_BROWSER_FINGERPRINT_BYTES,
  };
}

function parseRefs(snapshot: string): ReadonlyMap<string, BrowserRefFingerprint> {
  const refs = new Map<string, BrowserRefFingerprint>();
  for (const line of snapshot.split('\n')) {
    REF_PATTERN.lastIndex = 0;
    for (const match of line.matchAll(REF_PATTERN)) {
      const ref = match[1];
      if (refs.has(ref)) {
        throw new BrowserRuntimeError(
          'browser_snapshot_stale',
          `Browser snapshot contains duplicate ref ${ref}`
        );
      }
      refs.set(ref, fingerprintLine(line, ref));
    }
  }
  return refs;
}

export function boundBrowserSnapshot(
  value: string,
  maximumBytes = MAX_BROWSER_SNAPSHOT_BYTES
): {
  snapshot: string;
  truncated: boolean;
} {
  const sanitized = sanitizeBrowserText(value, Number.MAX_SAFE_INTEGER);
  const limit = Math.min(MAX_BROWSER_SNAPSHOT_BYTES, Math.max(0, maximumBytes));
  if (Buffer.byteLength(sanitized) <= limit) {
    return { snapshot: sanitized, truncated: false };
  }

  const markerBytes = Buffer.byteLength(TRUNCATION_MARKER);
  if (limit <= markerBytes) {
    return {
      snapshot: sliceUtf8(TRUNCATION_MARKER, limit),
      truncated: true,
    };
  }
  const budget = limit - markerBytes;
  const lines: string[] = [];
  let used = 0;
  for (const line of sanitized.split('\n')) {
    const candidate = lines.length === 0 ? line : `\n${line}`;
    const bytes = Buffer.byteLength(candidate);
    if (used + bytes > budget) break;
    lines.push(line);
    used += bytes;
  }
  const prefix =
    lines.length > 0 ? lines.join('\n') : sliceUtf8(sanitized, Math.max(0, budget));
  return {
    snapshot: `${prefix}${TRUNCATION_MARKER}`,
    truncated: true,
  };
}

export class BrowserSnapshotAuthority {
  private readonly latestByPage = new Map<string, BrowserSnapshotAuthorityRecord>();

  issue(input: BrowserSnapshotInput): BrowserSnapshotAuthorityRecord {
    const bounded = boundBrowserSnapshot(input.snapshot, input.maxBytes);
    const record: BrowserSnapshotAuthorityRecord = {
      snapshotId: `browser_snapshot_${randomUUID()}`,
      pageId: input.pageId,
      pageGeneration: input.pageGeneration,
      origin: input.origin,
      snapshot: bounded.snapshot,
      truncated: bounded.truncated,
      depth: input.depth,
      includeBoxes: input.includeBoxes,
      refs: parseRefs(bounded.snapshot),
    };
    this.latestByPage.set(input.pageId, record);
    return record;
  }

  validate(input: {
    pageId: string;
    snapshotId: string;
    pageGeneration: number;
    origin: string;
    ref: string;
  }): BrowserSnapshotValidation {
    const authority = this.validateSnapshot(input);
    const fingerprint = authority.refs.get(input.ref);
    if (!fingerprint) {
      throw new BrowserRuntimeError(
        'browser_snapshot_stale',
        'Browser ref is not present in the latest snapshot'
      );
    }
    return {
      ref: input.ref,
      fingerprint: fingerprint.value,
      fingerprintExceededLimit: fingerprint.exceededLimit,
      authority,
    };
  }

  validateSnapshot(input: {
    pageId: string;
    snapshotId: string;
    pageGeneration: number;
    origin: string;
  }): BrowserSnapshotAuthorityRecord {
    const authority = this.latestByPage.get(input.pageId);
    if (
      !authority ||
      authority.snapshotId !== input.snapshotId ||
      authority.pageGeneration !== input.pageGeneration ||
      authority.origin !== input.origin
    ) {
      throw new BrowserRuntimeError(
        'browser_snapshot_stale',
        'Browser snapshot is stale; capture a new snapshot before interacting'
      );
    }
    return authority;
  }

  verifyFreshFingerprint(
    validation: BrowserSnapshotValidation,
    freshSnapshot: string
  ): void {
    const fresh = parseRefs(freshSnapshot);
    const fingerprint = fresh.get(validation.ref);
    if (
      !fingerprint ||
      fingerprint.value !== validation.fingerprint ||
      fingerprint.exceededLimit !== validation.fingerprintExceededLimit
    ) {
      throw new BrowserRuntimeError(
        'browser_snapshot_stale',
        'Browser ref changed after the latest snapshot; capture a new snapshot'
      );
    }
  }

  invalidate(pageId: string): void {
    this.latestByPage.delete(pageId);
  }

  clear(): void {
    this.latestByPage.clear();
  }
}

export class BrowserScreenshotAuthority {
  private readonly latestByPage = new Map<string, BrowserScreenshotAuthorityRecord>();

  issue(input: BrowserScreenshotInput): BrowserScreenshotAuthorityRecord {
    const record: BrowserScreenshotAuthorityRecord = {
      screenshotId: `browser_screenshot_${randomUUID()}`,
      pageId: input.pageId,
      pageGeneration: input.pageGeneration,
      origin: input.origin,
      sha256: input.sha256,
      viewport: { ...input.viewport },
    };
    this.latestByPage.set(input.pageId, record);
    return record;
  }

  validate(
    input: BrowserScreenshotInput & { screenshotId: string }
  ): BrowserScreenshotAuthorityRecord {
    const authority = this.latestByPage.get(input.pageId);
    if (
      !authority ||
      authority.screenshotId !== input.screenshotId ||
      authority.pageGeneration !== input.pageGeneration ||
      authority.origin !== input.origin
    ) {
      throw new BrowserRuntimeError(
        'browser_snapshot_stale',
        'Browser screenshot is stale; capture a new screenshot before coordinate interaction'
      );
    }
    if (
      authority.viewport.width !== input.viewport.width ||
      authority.viewport.height !== input.viewport.height
    ) {
      throw new BrowserRuntimeError(
        'browser_snapshot_stale',
        'Browser screenshot viewport changed; capture a new screenshot before coordinate interaction'
      );
    }
    if (authority.sha256 !== input.sha256) {
      throw new BrowserRuntimeError(
        'browser_snapshot_stale',
        'Browser screenshot pixels changed; capture a new screenshot before coordinate interaction'
      );
    }
    return authority;
  }

  invalidate(pageId: string): void {
    this.latestByPage.delete(pageId);
  }

  clear(): void {
    this.latestByPage.clear();
  }
}
