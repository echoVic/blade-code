import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildTypeCheckArgs,
  resolveWorkspaceRoot,
  VerifyQueue,
} from '../../../../../src/tools/execution/VerifyQueue.js';

function makeTempWorkspace(withTsconfig = true, withTypeCheckScript = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verifyq-'));
  if (withTsconfig) {
    fs.writeFileSync(path.join(dir, 'tsconfig.json'), '{}');
  }
  if (withTypeCheckScript) {
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ scripts: { 'type-check': 'tsc --noEmit' } })
    );
  }
  return dir;
}

describe('VerifyQueue', () => {
  afterEach(() => {
    VerifyQueue.resetInstance();
  });

  describe('resolveWorkspaceRoot', () => {
    it('返回含 tsconfig.json 的最近目录', () => {
      const ws = makeTempWorkspace();
      const nested = path.join(ws, 'src', 'a');
      fs.mkdirSync(nested, { recursive: true });
      const file = path.join(nested, 'foo.ts');
      fs.writeFileSync(file, '');
      expect(resolveWorkspaceRoot(file, ws)).toBe(ws);
    });

    it('monorepo: 优先子包 tsconfig', () => {
      const repo = makeTempWorkspace();
      const pkg = path.join(repo, 'packages', 'cli');
      fs.mkdirSync(pkg, { recursive: true });
      fs.writeFileSync(path.join(pkg, 'tsconfig.json'), '{}');
      const file = path.join(pkg, 'src', 'foo.ts');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '');
      expect(resolveWorkspaceRoot(file, repo)).toBe(pkg);
    });

    it('无 tsconfig 返回 null', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noconfig-'));
      const file = path.join(dir, 'a.ts');
      fs.writeFileSync(file, '');
      expect(resolveWorkspaceRoot(file, dir)).toBeNull();
    });
  });

  describe('buildTypeCheckArgs', () => {
    it('有 type-check 脚本时用 bun run type-check', () => {
      const ws = makeTempWorkspace(true, true);
      expect(buildTypeCheckArgs(ws)).toEqual({
        cmd: 'bun',
        args: ['run', 'type-check'],
      });
    });

    it('无脚本时用 tsc --noEmit --incremental', () => {
      const ws = makeTempWorkspace(true, false);
      const { cmd, args } = buildTypeCheckArgs(ws);
      expect(cmd).toBe('npx');
      expect(args).toContain('--incremental');
      expect(args).toContain('--tsBuildInfoFile');
      expect(args).toContain('.blade-tsbuildinfo');
    });
  });

  describe('verify — 并发合并 + 缓存', () => {
    it('同 workspace 的并发请求共享一次 tsc', async () => {
      const ws = makeTempWorkspace();
      const file = path.join(ws, 'a.ts');
      fs.writeFileSync(file, '');
      const runCommand = vi.fn().mockImplementation(
        async () =>
          new Promise((resolve) => {
            setTimeout(
              () => resolve({ stdout: '', stderr: '', exitCode: 0, timedOut: false }),
              20
            );
          })
      );
      const q = new VerifyQueue({ runCommand, cacheMs: 0 });

      // 并发 5 个
      const results = await Promise.all(
        Array.from({ length: 5 }, () => q.verify(file, ws))
      );
      expect(results.every((r) => r && !r.hasErrors)).toBe(true);
      expect(runCommand).toHaveBeenCalledTimes(1); // 只跑一次
    });

    it('检查运行中文件变化时会排队执行最新检查', async () => {
      const ws = makeTempWorkspace();
      const file = path.join(ws, 'a.ts');
      fs.writeFileSync(file, 'export const value = 1;\n');

      let releaseFirst!: () => void;
      const firstCheck = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const runCommand = vi
        .fn()
        .mockImplementationOnce(async () => {
          await firstCheck;
          return { stdout: '', stderr: '', exitCode: 0, timedOut: false };
        })
        .mockResolvedValue({ stdout: '', stderr: '', exitCode: 0, timedOut: false });
      const q = new VerifyQueue({ runCommand, cacheMs: 5000 });

      const first = q.verify(file, ws);
      await Promise.resolve();
      fs.writeFileSync(file, 'export const value = missingSymbol;\n');
      const second = q.verify(file, ws);
      releaseFirst();

      await Promise.all([first, second]);
      expect(runCommand).toHaveBeenCalledTimes(2);
    });

    it('缓存窗口内复用结果', async () => {
      const ws = makeTempWorkspace();
      const file = path.join(ws, 'a.ts');
      fs.writeFileSync(file, '');
      const runCommand = vi
        .fn()
        .mockResolvedValue({ stdout: '', stderr: '', exitCode: 0, timedOut: false });
      const q = new VerifyQueue({ runCommand, cacheMs: 5000 });

      await q.verify(file, ws);
      await q.verify(file, ws);
      await q.verify(file, ws);
      expect(runCommand).toHaveBeenCalledTimes(1);
    });

    it('文件内容变化时不复用 workspace 缓存', async () => {
      const ws = makeTempWorkspace();
      const file = path.join(ws, 'a.ts');
      fs.writeFileSync(file, 'export const value = 1;\n');
      const runCommand = vi
        .fn()
        .mockResolvedValue({ stdout: '', stderr: '', exitCode: 0, timedOut: false });
      const q = new VerifyQueue({ runCommand, cacheMs: 5000 });

      await q.verify(file, ws);
      fs.writeFileSync(file, 'export const value = missingSymbol;\n');
      await q.verify(file, ws);

      expect(runCommand).toHaveBeenCalledTimes(2);
    });

    it('同 workspace 的不同文件不复用缓存', async () => {
      const ws = makeTempWorkspace();
      const firstFile = path.join(ws, 'a.ts');
      const secondFile = path.join(ws, 'b.ts');
      fs.writeFileSync(firstFile, 'export const first = 1;\n');
      fs.writeFileSync(secondFile, 'export const second = 2;\n');
      const runCommand = vi
        .fn()
        .mockResolvedValue({ stdout: '', stderr: '', exitCode: 0, timedOut: false });
      const q = new VerifyQueue({ runCommand, cacheMs: 5000 });

      await q.verify(firstFile, ws);
      await q.verify(secondFile, ws);

      expect(runCommand).toHaveBeenCalledTimes(2);
    });

    it('缓存过期后重新跑', async () => {
      const ws = makeTempWorkspace();
      const file = path.join(ws, 'a.ts');
      fs.writeFileSync(file, '');
      const runCommand = vi
        .fn()
        .mockResolvedValue({ stdout: '', stderr: '', exitCode: 0, timedOut: false });
      const q = new VerifyQueue({ runCommand, cacheMs: 10 });

      await q.verify(file, ws);
      await new Promise((r) => setTimeout(r, 30));
      await q.verify(file, ws);
      expect(runCommand).toHaveBeenCalledTimes(2);
    });
  });

  describe('verify — 错误传播', () => {
    it('tsc 退出非 0 → hasErrors=true', async () => {
      const ws = makeTempWorkspace();
      const file = path.join(ws, 'a.ts');
      fs.writeFileSync(file, '');
      const runCommand = vi.fn().mockResolvedValue({
        stdout: 'src/a.ts(1,1): error TS1005: bad',
        stderr: '',
        exitCode: 1,
        timedOut: false,
      });
      const q = new VerifyQueue({ runCommand });

      const r = await q.verify(file, ws);
      expect(r?.hasErrors).toBe(true);
      expect(r?.rawOutput).toContain('TS1005');
    });

    it('超时时 hasErrors=false, timedOut=true', async () => {
      const ws = makeTempWorkspace();
      const file = path.join(ws, 'a.ts');
      fs.writeFileSync(file, '');
      const runCommand = vi.fn().mockResolvedValue({
        stdout: '',
        stderr: '',
        exitCode: 1,
        timedOut: true,
      });
      const q = new VerifyQueue({ runCommand });

      const r = await q.verify(file, ws);
      expect(r?.timedOut).toBe(true);
      expect(r?.hasErrors).toBe(false);
    });
  });

  describe('verify — workspace 解析', () => {
    it('找不到 tsconfig 返回 null (不跑 tsc)', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noconfig-'));
      const file = path.join(dir, 'a.ts');
      fs.writeFileSync(file, '');
      const runCommand = vi.fn();
      const q = new VerifyQueue({ runCommand });

      expect(await q.verify(file, dir)).toBeNull();
      expect(runCommand).not.toHaveBeenCalled();
    });

    it('monorepo: 不同包的缓存互不影响', async () => {
      const repo = makeTempWorkspace(false);
      const pkgA = path.join(repo, 'packages', 'a');
      const pkgB = path.join(repo, 'packages', 'b');
      fs.mkdirSync(pkgA, { recursive: true });
      fs.mkdirSync(pkgB, { recursive: true });
      fs.writeFileSync(path.join(pkgA, 'tsconfig.json'), '{}');
      fs.writeFileSync(path.join(pkgB, 'tsconfig.json'), '{}');
      const fileA = path.join(pkgA, 'x.ts');
      const fileB = path.join(pkgB, 'x.ts');
      fs.writeFileSync(fileA, '');
      fs.writeFileSync(fileB, '');

      const runCommand = vi
        .fn()
        .mockResolvedValue({ stdout: '', stderr: '', exitCode: 0, timedOut: false });
      const q = new VerifyQueue({ runCommand, cacheMs: 5000 });

      await q.verify(fileA, repo);
      await q.verify(fileB, repo);
      expect(runCommand).toHaveBeenCalledTimes(2); // 两个包���跑一次
      expect(runCommand.mock.calls[0][2]).toBe(pkgA); // cwd
      expect(runCommand.mock.calls[1][2]).toBe(pkgB);
    });
  });
});
