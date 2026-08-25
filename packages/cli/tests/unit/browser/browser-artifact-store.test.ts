import { chmod, lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BrowserArtifactStore } from '../../../src/browser/BrowserArtifactStore.js';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function png(suffix: string): Buffer {
  return Buffer.concat([PNG_SIGNATURE, Buffer.from(suffix)]);
}

describe('BrowserArtifactStore', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'blade-browser-artifacts-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('writes private content-addressed PNG artifacts', async () => {
    const store = new BrowserArtifactStore('project-a\u0000session-a', {
      storageRoot: root,
    });
    const bytes = png('private screenshot');
    const first = await store.writeScreenshot(bytes);
    const second = await store.writeScreenshot(bytes);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      kind: 'image',
      mimeType: 'image/png',
      persisted: true,
      size: bytes.length,
    });
    expect(first.id).toMatch(/^[a-f0-9]{64}$/);
    expect(first.path).toMatch(/browser-artifacts\/[a-f0-9]{64}\/[a-f0-9]{64}\.png$/);
    expect(await readFile(first.path!)).toEqual(bytes);
    expect((await lstat(first.path!)).mode & 0o777).toBe(0o600);
    expect((await lstat(path.dirname(first.path!))).mode & 0o777).toBe(0o700);
  });

  it('hides paths for ACP-style callers', async () => {
    const store = new BrowserArtifactStore('session-acp', {
      storageRoot: root,
      exposePaths: false,
    });

    const artifact = await store.writeScreenshot(png('acp'));
    expect(artifact.persisted).toBe(true);
    expect(artifact.path).toBeUndefined();
  });

  it('rejects invalid or oversized PNG data before persistence', async () => {
    const store = new BrowserArtifactStore('session-a', {
      storageRoot: root,
      maxArtifactBytes: 12,
    });

    await expect(store.writeScreenshot(Buffer.from('not png'))).rejects.toThrow(
      'valid PNG'
    );
    await expect(store.writeScreenshot(png('too-large'))).rejects.toThrow(
      'per-file byte limit'
    );
  });

  it('enforces count and Session byte quotas without counting duplicates twice', async () => {
    const store = new BrowserArtifactStore('session-a', {
      storageRoot: root,
      maxArtifacts: 1,
      maxSessionBytes: 64,
    });
    const first = png('first');
    await store.writeScreenshot(first);
    await store.writeScreenshot(first);

    await expect(store.writeScreenshot(png('second'))).rejects.toThrow(
      'Session quota exceeded'
    );
  });

  it('fails closed when an existing artifact loses private permissions', async () => {
    const store = new BrowserArtifactStore('session-a', { storageRoot: root });
    const bytes = png('unsafe');
    const artifact = await store.writeScreenshot(bytes);
    await chmod(artifact.path!, 0o644);

    const reopened = new BrowserArtifactStore('session-a', { storageRoot: root });
    await expect(reopened.writeScreenshot(bytes)).rejects.toThrow(
      /ownership or permissions|unsafe entry/
    );
  });

  it('removes the Session namespace explicitly', async () => {
    const store = new BrowserArtifactStore('session-a', { storageRoot: root });
    const artifact = await store.writeScreenshot(png('delete'));
    await store.removeAll();

    await expect(lstat(path.dirname(artifact.path!))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
