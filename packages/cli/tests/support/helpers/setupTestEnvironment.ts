import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';

export interface TestEnvironment {
  tempDir: string;
  homeDir: string;
  projectDir: string;
  cleanup: () => void;
  createFile: (relativePath: string, content: string) => string;
  createDir: (relativePath: string) => string;
  getPath: (relativePath: string) => string;
}

export interface SetupOptions {
  withBladeConfig?: boolean;
  withGit?: boolean;
  withPackageJson?: boolean;
  customFiles?: Record<string, string>;
}

export const setupTestEnvironment = (options: SetupOptions = {}): TestEnvironment => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'blade-test-'));
  const homeDir = path.join(tempDir, 'home');
  const projectDir = path.join(tempDir, 'project');

  mkdirSync(homeDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });

  const originalCwd = process.cwd();

  process.chdir(projectDir);
  vi.spyOn(os, 'homedir').mockReturnValue(homeDir);

  if (options.withBladeConfig) {
    const bladeDir = path.join(homeDir, '.blade');
    mkdirSync(bladeDir, { recursive: true });
    writeFileSync(
      path.join(bladeDir, 'config.json'),
      JSON.stringify({
        currentModelId: 'test-model',
        models: [
          {
            id: 'test-model',
            name: 'Test Model',
            provider: 'openai-compatible',
            apiKey: 'test-key',
            baseUrl: 'https://api.test.com',
            model: 'gpt-4',
          },
        ],
        codeTheme: 'GitHub',
        language: 'en',
      }),
      'utf-8'
    );
  }

  if (options.withGit) {
    const gitDir = path.join(projectDir, '.git');
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(path.join(gitDir, 'HEAD'), 'ref: refs/heads/main\n', 'utf-8');
    writeFileSync(
      path.join(gitDir, 'config'),
      '[core]\n\trepositoryformatversion = 0\n',
      'utf-8'
    );
  }

  if (options.withPackageJson) {
    writeFileSync(
      path.join(projectDir, 'package.json'),
      JSON.stringify({
        name: 'test-project',
        version: '1.0.0',
        type: 'module',
      }),
      'utf-8'
    );
  }

  if (options.customFiles) {
    for (const [relativePath, content] of Object.entries(options.customFiles)) {
      const fullPath = path.join(projectDir, relativePath);
      mkdirSync(path.dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, content, 'utf-8');
    }
  }

  const cleanup = () => {
    process.chdir(originalCwd);
    vi.spyOn(os, 'homedir').mockRestore();
    rmSync(tempDir, { recursive: true, force: true });
  };

  const createFile = (relativePath: string, content: string): string => {
    const fullPath = path.join(projectDir, relativePath);
    mkdirSync(path.dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content, 'utf-8');
    return fullPath;
  };

  const createDir = (relativePath: string): string => {
    const fullPath = path.join(projectDir, relativePath);
    mkdirSync(fullPath, { recursive: true });
    return fullPath;
  };

  const getPath = (relativePath: string): string => {
    return path.join(projectDir, relativePath);
  };

  return {
    tempDir,
    homeDir,
    projectDir,
    cleanup,
    createFile,
    createDir,
    getPath,
  };
};

export const withTestEnvironment = (
  options: SetupOptions,
  testFn: (env: TestEnvironment) => Promise<void> | void
) => {
  return async () => {
    const env = setupTestEnvironment(options);
    try {
      await testFn(env);
    } finally {
      env.cleanup();
    }
  };
};

export const createTempFile = (content: string, extension = '.txt'): string => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'blade-temp-'));
  const filePath = path.join(tempDir, `temp${extension}`);
  writeFileSync(filePath, content, 'utf-8');
  return filePath;
};

export const createTempDir = (): string => {
  return mkdtempSync(path.join(os.tmpdir(), 'blade-temp-'));
};
