import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  canRunRipgrep,
  chooseRipgrep,
  findVendoredRipgrep,
  prefersSystemRipgrep,
} from '../../../../../src/tools/builtin/search/ripgrep.js';

vi.unmock('child_process');

describe('chooseRipgrep', () => {
  const available = {
    bundled: '/pkg/vendor/rg',
    system: '/usr/bin/rg',
    vscode: '/pkg/node_modules/@vscode/ripgrep/bin/rg',
    canRun: () => true,
  };

  it('prefers the bundled binary and disables user configuration', () => {
    expect(chooseRipgrep({ ...available, preferSystem: false })).toEqual({
      command: '/pkg/vendor/rg',
      args: ['--no-config'],
      bundled: true,
    });
  });

  it('uses the system binary first when builtin ripgrep is disabled', () => {
    expect(chooseRipgrep({ ...available, preferSystem: true })).toEqual({
      command: '/usr/bin/rg',
      args: ['--no-config'],
      bundled: false,
    });
  });

  it('skips a bundled binary that cannot run', () => {
    expect(
      chooseRipgrep({ ...available, preferSystem: false, canRun: () => false })
    ).toEqual({ command: '/usr/bin/rg', args: ['--no-config'], bundled: false });
  });

  it('falls back to @vscode/ripgrep and then to nothing', () => {
    expect(
      chooseRipgrep({ ...available, bundled: null, system: null, preferSystem: false })
    ).toEqual({
      command: '/pkg/node_modules/@vscode/ripgrep/bin/rg',
      args: ['--no-config'],
      bundled: false,
    });
    expect(
      chooseRipgrep({
        bundled: null,
        system: null,
        vscode: null,
        canRun: () => true,
        preferSystem: false,
      })
    ).toBeNull();
  });
});

describe('prefersSystemRipgrep', () => {
  it.each([
    ['0', true],
    ['false', true],
    [' FALSE ', true],
    ['1', false],
    [undefined, false],
  ])('BLADE_USE_BUILTIN_RIPGREP=%s', (value, expected) => {
    expect(prefersSystemRipgrep({ BLADE_USE_BUILTIN_RIPGREP: value })).toBe(expected);
  });
});

describe('canRunRipgrep', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'blade-rg-probe-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('rejects a binary that cannot run', async () => {
    const binary = path.join(directory, 'rg');
    await writeFile(binary, 'not an executable');
    await chmod(binary, 0o755);

    expect(canRunRipgrep(binary)).toBe(false);
  });

  it('accepts an executable that answers --version', async () => {
    const binary = path.join(directory, 'rg');
    await writeFile(binary, '#!/bin/sh\necho "ripgrep 0.0.0"\n');
    await chmod(binary, 0o755);

    expect(canRunRipgrep(binary)).toBe(true);
  });
});

describe('findVendoredRipgrep', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'blade-rg-vendor-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function createPackage(packageDir: string, withBinary: boolean) {
    await mkdir(path.join(packageDir, 'dist'), { recursive: true });
    await writeFile(path.join(packageDir, 'package.json'), '{"name":"blade-code"}');
    if (withBinary) {
      await mkdir(path.join(packageDir, 'vendor/ripgrep/linux-x64'), {
        recursive: true,
      });
      await writeFile(path.join(packageDir, 'vendor/ripgrep/linux-x64/rg'), '');
    }
  }

  it('finds the binary from the bundled dist directory of an installed package', async () => {
    const packageDir = path.join(root, 'node_modules/blade-code');
    await createPackage(packageDir, true);

    expect(findVendoredRipgrep(path.join(packageDir, 'dist'), 'linux-x64/rg')).toBe(
      path.join(packageDir, 'vendor/ripgrep/linux-x64/rg')
    );
  });

  it('finds the binary from a nested source directory', async () => {
    await createPackage(root, true);
    const sourceDir = path.join(root, 'src/tools/builtin/search');
    await mkdir(sourceDir, { recursive: true });

    expect(findVendoredRipgrep(sourceDir, 'linux-x64/rg')).toBe(
      path.join(root, 'vendor/ripgrep/linux-x64/rg')
    );
  });

  it('does not look past the package root', async () => {
    await mkdir(path.join(root, 'vendor/ripgrep/linux-x64'), { recursive: true });
    await writeFile(path.join(root, 'vendor/ripgrep/linux-x64/rg'), '');
    const packageDir = path.join(root, 'node_modules/blade-code');
    await createPackage(packageDir, false);

    expect(
      findVendoredRipgrep(path.join(packageDir, 'dist'), 'linux-x64/rg')
    ).toBeNull();
  });
});
