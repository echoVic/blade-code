import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function launchFixture(externalStorageRoot?: string): string {
  const controlRoot = mkdtempSync(
    path.join(os.tmpdir(), 'blade-storage-root-control-')
  );
  temporaryRoots.push(controlRoot);
  const reportPath = path.join(controlRoot, 'storage-root.txt');
  const environment = { ...process.env };
  delete environment.BLADE_STORAGE_ROOT;
  if (externalStorageRoot !== undefined) {
    environment.BLADE_STORAGE_ROOT = externalStorageRoot;
  }

  const fixturePath = path.join(
    import.meta.dirname,
    '..',
    'fixtures',
    'run-owned-test-storage-root.ts'
  );
  const result = spawnSync(
    process.env.BUN_EXEC_PATH ?? 'bun',
    [fixturePath, reportPath],
    {
      encoding: 'utf8',
      env: environment,
      timeout: 10_000,
    }
  );
  expect(result.status, result.stderr || result.error?.message).toBe(0);
  return readFileSync(reportPath, 'utf8');
}

describe('owned test storage root lifecycle', () => {
  it('removes a harness-owned root when the worker process exits', () => {
    const storageRoot = launchFixture();

    expect(
      storageRoot.startsWith(path.join(os.tmpdir(), 'blade-owned-storage-child-'))
    ).toBe(true);
    expect(existsSync(storageRoot)).toBe(false);
  });

  it('preserves an explicitly configured external root', () => {
    const externalRoot = mkdtempSync(
      path.join(os.tmpdir(), 'blade-external-storage-root-')
    );
    temporaryRoots.push(externalRoot);

    const storageRoot = launchFixture(externalRoot);

    expect(storageRoot).toBe(externalRoot);
    expect(existsSync(path.join(externalRoot, 'sentinel.txt'))).toBe(true);
  });
});
