import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  FileStat,
  FileSystemService,
} from '../../src/services/FileSystemService.js';
import { parseApplyPatch } from '../../src/tools/builtin/file/applyPatchParser.js';
import {
  commitLocalPatchTransaction,
  commitRemotePatchTransaction,
  type LocalPatchFileSystem,
  planLocalPatchTransaction,
  planRemotePatchTransaction,
} from '../../src/tools/builtin/file/applyPatchTransaction.js';

const roots: string[] = [];
let previousStorageRoot: string | undefined;

async function workspace(name: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `blade-patch-${name}-`));
  roots.push(root);
  return fs.realpath(root);
}

async function write(root: string, relative: string, content: string) {
  const filePath = path.join(root, relative);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
}

function realTransactionFs(): LocalPatchFileSystem {
  return {
    lstat: (filePath) => fs.lstat(filePath),
    readFile: (filePath) => fs.readFile(filePath),
    writeFile: (filePath, content, options) => fs.writeFile(filePath, content, options),
    mkdir: (dirPath) => fs.mkdir(dirPath),
    rename: (from, to) => fs.rename(from, to),
    rm: (filePath, options) => fs.rm(filePath, options),
    rmdir: (dirPath) => fs.rmdir(dirPath),
    syncFile: async (filePath) => {
      const handle = await fs.open(filePath, 'r');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    },
    syncDirectory: async (dirPath) => {
      const handle = await fs.open(dirPath, 'r');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    },
  };
}

beforeEach(() => {
  previousStorageRoot = process.env.BLADE_STORAGE_ROOT;
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true })));
  if (previousStorageRoot === undefined) delete process.env.BLADE_STORAGE_ROOT;
  else process.env.BLADE_STORAGE_ROOT = previousStorageRoot;
});

describe('ApplyPatch local transaction', () => {
  it('atomically combines add, update, delete, and move operations', async () => {
    const root = await workspace('combined');
    process.env.BLADE_STORAGE_ROOT = path.join(root, '.storage');
    await write(root, 'update.ts', 'export const value = false;\n');
    await write(root, 'move.ts', 'export const moved = false;\n');
    await write(root, 'delete.ts', 'obsolete\n');
    const operations = parseApplyPatch(`*** Begin Patch
*** Update File: update.ts
@@
-export const value = false;
+export const value = true;
*** Update File: move.ts
*** Move to: nested/moved.ts
@@
-export const moved = false;
+export const moved = true;
*** Add File: nested/added.ts
+export const added = true;
*** Delete File: delete.ts
*** End Patch`);

    const plan = await planLocalPatchTransaction(operations, root);
    await commitLocalPatchTransaction(plan);

    await expect(fs.readFile(path.join(root, 'update.ts'), 'utf8')).resolves.toBe(
      'export const value = true;\n'
    );
    await expect(fs.readFile(path.join(root, 'nested/moved.ts'), 'utf8')).resolves.toBe(
      'export const moved = true;\n'
    );
    await expect(fs.readFile(path.join(root, 'nested/added.ts'), 'utf8')).resolves.toBe(
      'export const added = true;\n'
    );
    await expect(fs.stat(path.join(root, 'move.ts'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(fs.stat(path.join(root, 'delete.ts'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect((await fs.readdir(root, { recursive: true })).join('\n')).not.toContain(
      '.blade-patch-'
    );
  });

  it('preflights every hunk before creating side effects', async () => {
    const root = await workspace('preflight');
    process.env.BLADE_STORAGE_ROOT = path.join(root, '.storage');
    await write(root, 'first.ts', 'const first = false;\n');
    await write(root, 'second.ts', 'const second = false;\n');
    const operations = parseApplyPatch(`*** Begin Patch
*** Update File: first.ts
@@
-const first = false;
+const first = true;
*** Update File: second.ts
@@
-missing context
+const second = true;
*** End Patch`);

    await expect(planLocalPatchTransaction(operations, root)).rejects.toThrow(
      'expected context was not found'
    );
    await expect(fs.readFile(path.join(root, 'first.ts'), 'utf8')).resolves.toBe(
      'const first = false;\n'
    );
  });

  it('restores every file after a mid-publication failure', async () => {
    const root = await workspace('rollback');
    process.env.BLADE_STORAGE_ROOT = path.join(root, '.storage');
    await write(root, 'first.ts', 'const first = false;\n');
    await write(root, 'second.ts', 'const second = false;\n');
    const operations = parseApplyPatch(`*** Begin Patch
*** Update File: first.ts
@@
-const first = false;
+const first = true;
*** Update File: second.ts
@@
-const second = false;
+const second = true;
*** End Patch`);
    const plan = await planLocalPatchTransaction(operations, root);
    const transactionFs = realTransactionFs();
    let renameCount = 0;
    const injected: LocalPatchFileSystem = {
      ...transactionFs,
      rename: async (from, to) => {
        renameCount++;
        if (renameCount === 3) throw new Error('injected publish failure');
        await transactionFs.rename(from, to);
      },
    };

    await expect(
      commitLocalPatchTransaction(plan, undefined, injected)
    ).rejects.toThrow('injected publish failure');
    await expect(fs.readFile(path.join(root, 'first.ts'), 'utf8')).resolves.toBe(
      'const first = false;\n'
    );
    await expect(fs.readFile(path.join(root, 'second.ts'), 'utf8')).resolves.toBe(
      'const second = false;\n'
    );
    expect((await fs.readdir(root)).join('\n')).not.toContain('.blade-patch-');
  });

  it('rejects overlapping paths and symlink escapes', async () => {
    const root = await workspace('security');
    process.env.BLADE_STORAGE_ROOT = path.join(root, '.storage');
    const outside = await workspace('outside');
    await write(root, 'same.ts', 'const value = false;\n');
    await fs.symlink(outside, path.join(root, 'link'));

    const overlapping = parseApplyPatch(`*** Begin Patch
*** Update File: same.ts
@@
-const value = false;
+const value = true;
*** Delete File: same.ts
*** End Patch`);
    await expect(planLocalPatchTransaction(overlapping, root)).rejects.toThrow(
      'overlapping file operations'
    );

    const escaping = parseApplyPatch(`*** Begin Patch
*** Add File: link/escaped.ts
+export {};
*** End Patch`);
    await expect(planLocalPatchTransaction(escaping, root)).rejects.toThrow(
      /outside|escapes/
    );
    await expect(fs.stat(path.join(outside, 'escaped.ts'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});

describe('ApplyPatch ACP remote transaction', () => {
  it('rolls back prior remote writes when a later write fails', async () => {
    const files = new Map([
      ['/remote/first.ts', 'const first = false;\n'],
      ['/remote/second.ts', 'const second = false;\n'],
    ]);
    let failed = false;
    const remote = createRemoteFileSystem(files, async (filePath, content) => {
      if (filePath.endsWith('second.ts') && content.includes('true') && !failed) {
        failed = true;
        files.set(filePath, content);
        throw new Error('remote write failed');
      }
      files.set(filePath, content);
    });
    const operations = parseApplyPatch(`*** Begin Patch
*** Update File: first.ts
@@
-const first = false;
+const first = true;
*** Update File: second.ts
@@
-const second = false;
+const second = true;
*** End Patch`);
    const plan = await planRemotePatchTransaction(operations, '/remote', remote);

    await expect(commitRemotePatchTransaction(plan, remote)).rejects.toThrow(
      'remote write failed'
    );
    expect(files.get('/remote/first.ts')).toBe('const first = false;\n');
    expect(files.get('/remote/second.ts')).toBe('const second = false;\n');
  });

  it('fails closed for remote add, delete, and move operations', async () => {
    const remote = createRemoteFileSystem(new Map());
    for (const patch of [
      '*** Add File: new.ts\n+x',
      '*** Delete File: old.ts',
      '*** Update File: old.ts\n*** Move to: moved.ts',
    ]) {
      const operations = parseApplyPatch(`*** Begin Patch\n${patch}\n*** End Patch`);
      await expect(
        planRemotePatchTransaction(operations, '/remote', remote)
      ).rejects.toThrow('Update File operations only');
    }
  });
});

function createRemoteFileSystem(
  files: Map<string, string>,
  writeFile: (filePath: string, content: string) => Promise<void> = async (
    filePath,
    content
  ) => {
    files.set(filePath, content);
  }
): FileSystemService {
  return {
    readTextFile: async (filePath) => {
      const content = files.get(filePath);
      if (content === undefined) throw new Error(`not found: ${filePath}`);
      return content;
    },
    writeTextFile: writeFile,
    exists: async (filePath) => files.has(filePath),
    readBinaryFile: async (filePath) => Buffer.from(files.get(filePath) ?? '', 'utf8'),
    stat: async (filePath): Promise<FileStat | null> =>
      files.has(filePath)
        ? {
            size: Buffer.byteLength(files.get(filePath)!),
            isDirectory: false,
            isFile: true,
            mtime: new Date(),
          }
        : null,
    mkdir: async () => undefined,
  };
}
