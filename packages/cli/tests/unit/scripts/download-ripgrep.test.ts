import { type ExecFileException, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('child_process');
vi.unmock('http');

const VERSION = '9.9.9';
const SCRIPT = path.resolve('scripts/download-ripgrep.js');
// [release target, vendor directory, binary]
const TARGETS = [
  ['x86_64-apple-darwin', 'darwin-x64', 'rg'],
  ['aarch64-apple-darwin', 'darwin-arm64', 'rg'],
  ['x86_64-unknown-linux-musl', 'linux-x64', 'rg'],
  ['aarch64-unknown-linux-musl', 'linux-arm64', 'rg'],
  ['x86_64-pc-windows-msvc', 'win32-x64', 'rg.exe'],
] as const;

function run(
  file: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}
) {
  return new Promise<{ code: number; output: string }>((resolve) => {
    execFile(file, args, options, (error: ExecFileException | null, stdout, stderr) => {
      resolve({
        code: error == null ? 0 : typeof error.code === 'number' ? error.code : 1,
        output: `${stdout}${stderr}`,
      });
    });
  });
}

describe('download-ripgrep script', () => {
  let root: string;
  let packageDir: string;
  let server: Server;
  let assets: Map<string, Buffer>;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'blade-rg-download-'));
    packageDir = path.join(root, 'package');
    await mkdir(path.join(packageDir, 'scripts'), { recursive: true });
    await writeFile(path.join(packageDir, 'package.json'), '{"type":"module"}');
    await copyFile(SCRIPT, path.join(packageDir, 'scripts/download-ripgrep.js'));

    assets = new Map();
    const staging = path.join(root, 'staging');
    for (const [target, , binary] of TARGETS) {
      const name = `ripgrep-${VERSION}-${target}`;
      await mkdir(path.join(staging, name), { recursive: true });
      await writeFile(path.join(staging, name, binary), `binary for ${target}`);
      const isZip = binary === 'rg.exe';
      const archive = `${name}.${isZip ? 'zip' : 'tar.gz'}`;
      const { code } = isZip
        ? await run('zip', ['-qr', path.join(root, archive), name], { cwd: staging })
        : await run('tar', ['-czf', path.join(root, archive), '-C', staging, name]);
      expect(code).toBe(0);
      const content = await readFile(path.join(root, archive));
      const hash = createHash('sha256').update(content).digest('hex');
      assets.set(archive, content);
      // 与官方 release 一致：Windows 包的校验文件是 CertUtil 输出格式
      assets.set(
        `${archive}.sha256`,
        Buffer.from(
          isZip
            ? `SHA256 hash of ${archive}:\n${hash}\nCertUtil: -hashfile command completed successfully.\n`
            : `${hash}  ${archive}\n`
        )
      );
    }

    server = createServer((request, response) => {
      const asset = assets.get(path.basename(request.url ?? ''));
      response.writeHead(asset ? 200 : 404).end(asset);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });

  function download() {
    const { port } = server.address() as AddressInfo;
    return run(
      process.execPath,
      [path.join(packageDir, 'scripts/download-ripgrep.js'), VERSION],
      {
        env: { ...process.env, RIPGREP_DOWNLOAD_BASE_URL: `http://127.0.0.1:${port}` },
      }
    );
  }

  function vendored(directory: string, binary: string) {
    return path.join(packageDir, 'vendor/ripgrep', directory, binary);
  }

  it('installs every platform binary from verified archives', async () => {
    const result = await download();

    expect(result.code).toBe(0);
    for (const [target, directory, binary] of TARGETS) {
      await expect(readFile(vendored(directory, binary), 'utf8')).resolves.toBe(
        `binary for ${target}`
      );
    }
    expect((await stat(vendored('linux-x64', 'rg'))).mode & 0o111).not.toBe(0);
  });

  it('fails and keeps the existing binary when a checksum does not match', async () => {
    await mkdir(path.dirname(vendored('linux-x64', 'rg')), { recursive: true });
    await writeFile(vendored('linux-x64', 'rg'), 'previous binary');
    assets.set(
      `ripgrep-${VERSION}-x86_64-unknown-linux-musl.tar.gz.sha256`,
      Buffer.from(
        `${'0'.repeat(64)}  ripgrep-${VERSION}-x86_64-unknown-linux-musl.tar.gz\n`
      )
    );

    const result = await download();

    expect(result.code).not.toBe(0);
    await expect(readFile(vendored('linux-x64', 'rg'), 'utf8')).resolves.toBe(
      'previous binary'
    );
  });

  it('fails when a platform archive is missing', async () => {
    assets.delete(`ripgrep-${VERSION}-aarch64-unknown-linux-musl.tar.gz`);

    const result = await download();

    expect(result.code).not.toBe(0);
  });
});
