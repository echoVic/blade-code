import { execFile } from 'node:child_process';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.unmock('child_process');

const execFileAsync = promisify(execFile);
const VENDOR_DIR = path.resolve('vendor/ripgrep');

let packageDir: string;

beforeEach(async () => {
  packageDir = await mkdtemp(path.join(os.tmpdir(), 'blade-pack-'));
});

afterEach(async () => {
  await rm(packageDir, { recursive: true, force: true });
});

// 用真实的 files 字段与 vendor/ripgrep 下真实的忽略文件模拟一次打包
it('packs the vendored ripgrep binaries into the npm tarball', async () => {
  const { files } = JSON.parse(await readFile('package.json', 'utf8')) as {
    files: string[];
  };
  await writeFile(
    path.join(packageDir, 'package.json'),
    JSON.stringify({ name: 'blade-pack-probe', version: '0.0.0', files })
  );
  const vendorDir = path.join(packageDir, 'vendor/ripgrep');
  await mkdir(path.join(vendorDir, 'linux-x64'), { recursive: true });
  await mkdir(path.join(vendorDir, 'win32-x64'), { recursive: true });
  for (const entry of await readdir(VENDOR_DIR, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.startsWith('.')) {
      await copyFile(
        path.join(VENDOR_DIR, entry.name),
        path.join(vendorDir, entry.name)
      );
    }
  }
  await writeFile(path.join(vendorDir, 'linux-x64/rg'), 'rg', { mode: 0o755 });
  await writeFile(path.join(vendorDir, 'win32-x64/rg.exe'), 'rg');

  const { stdout } = await execFileAsync(
    'npm',
    ['pack', '--dry-run', '--json', '--ignore-scripts'],
    { cwd: packageDir }
  );
  const [{ files: packed }] = JSON.parse(stdout) as [
    { files: Array<{ path: string; mode: number }> },
  ];

  const linuxBinary = packed.find(
    (file) => file.path === 'vendor/ripgrep/linux-x64/rg'
  );
  expect(linuxBinary?.mode ?? 0).toBe(0o755);
  expect(packed.map((file) => file.path)).toContain('vendor/ripgrep/win32-x64/rg.exe');
});
