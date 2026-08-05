import { chmod, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileCredentialStore } from '../../../../src/services/pi/FileCredentialStore.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe('FileCredentialStore', () => {
  it('persists provider credentials with owner-only permissions', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'blade-auth-'));
    roots.push(root);
    await chmod(root, 0o755);
    const filePath = path.join(root, 'auth.json');
    const store = new FileCredentialStore(filePath);

    await store.modify('deepseek', async () => ({
      type: 'api_key',
      key: 'secret',
    }));

    expect(await store.read('deepseek')).toEqual({
      type: 'api_key',
      key: 'secret',
    });
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual({
      deepseek: { type: 'api_key', key: 'secret' },
    });
    expect((await stat(root)).mode & 0o777).toBe(0o700);
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
  });

  it('deletes credentials without exposing their contents in list()', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'blade-auth-'));
    roots.push(root);
    const store = new FileCredentialStore(path.join(root, 'auth.json'));
    await store.modify('deepseek', async () => ({
      type: 'api_key',
      key: 'secret',
    }));

    expect(await store.list()).toEqual([{ providerId: 'deepseek', type: 'api_key' }]);
    await store.delete('deepseek');
    expect(await store.read('deepseek')).toBeUndefined();
  });
});
