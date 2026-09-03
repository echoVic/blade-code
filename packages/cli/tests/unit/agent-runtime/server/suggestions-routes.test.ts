import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAcpRemotePathProfile } from '../../../../src/acp/AcpRemotePath.js';
import {
  createAcpRemoteWorkspaceDescriptor,
  deriveAcpRemoteHostStateRoot,
} from '../../../../src/acp/AcpRemoteWorkspace.js';
import { BladeServerError } from '../../../../src/server/error.js';
import { SuggestionsRoutes } from '../../../../src/server/routes/suggestions.js';

const mocks = vi.hoisted(() => ({
  resolveWorkspaceAgentResources: vi.fn(),
  fastGlob: vi.fn(),
  readdir: vi.fn(),
  execSync: vi.fn(),
  stat: vi.fn(),
  readTextFile: vi.fn(),
  getFuzzyCommandSuggestions: vi.fn(),
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('fast-glob', () => ({
  default: mocks.fastGlob,
}));

vi.mock('node:fs/promises', async () => {
  const actual =
    await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    readdir: mocks.readdir,
  };
});

vi.mock('node:child_process', () => ({
  execSync: mocks.execSync,
}));

vi.mock('../../../../src/agent/resources/WorkspaceAgentResources.js', () => ({
  resolveWorkspaceAgentResources: mocks.resolveWorkspaceAgentResources,
}));

vi.mock('../../../../src/services/FileSystemService.js', () => ({
  getFileSystemService: () => ({
    stat: mocks.stat,
    readTextFile: mocks.readTextFile,
  }),
}));

vi.mock('../../../../src/slash-commands/index.js', () => ({
  getFuzzyCommandSuggestions: mocks.getFuzzyCommandSuggestions,
}));

vi.mock('../../../../src/logging/Logger.js', () => ({
  LogCategory: {
    SERVICE: 'service',
  },
  createLogger: vi.fn(() => mocks.logger),
}));

type Variables = {
  directory: string;
};

function createSuggestionsApp() {
  const app = new Hono<{ Variables: Variables }>();
  app.onError((error, context) => {
    if (error instanceof BladeServerError) {
      return context.json(
        error.toObject(),
        error.statusCode as 400 | 401 | 403 | 404 | 409 | 429 | 500 | 503
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    return context.json(
      {
        error: {
          code: 'INTERNAL_ERROR',
          message,
        },
      },
      500
    );
  });
  app.use('*', async (context, next) => {
    const directory =
      context.req.query('directory') ??
      context.req.header('x-blade-directory') ??
      '/fallback/workspace';
    context.set('directory', directory);
    return next();
  });
  app.route('/suggestions', SuggestionsRoutes());
  return app;
}

function createProtectedHostStateRoot(storageRoot: string): string {
  const descriptor = createAcpRemoteWorkspaceDescriptor(
    createAcpRemotePathProfile('/remote/workspace')
  );
  return deriveAcpRemoteHostStateRoot(descriptor.collisionIdentity, storageRoot);
}

describe('SuggestionsRoutes local path guard', () => {
  let previousStorageRoot: string | undefined;
  let storageRoot: string;
  let protectedRoot: string;
  const localDirectory = '/tmp/blade-local-workspace';

  beforeEach(async () => {
    previousStorageRoot = process.env.BLADE_STORAGE_ROOT;
    storageRoot = await mkdtemp(
      path.join(os.tmpdir(), 'blade-suggestions-route-storage-')
    );
    process.env.BLADE_STORAGE_ROOT = storageRoot;
    protectedRoot = createProtectedHostStateRoot(storageRoot);

    mocks.resolveWorkspaceAgentResources.mockReset();
    mocks.fastGlob.mockReset();
    mocks.readdir.mockReset();
    mocks.execSync.mockReset();
    mocks.stat.mockReset();
    mocks.readTextFile.mockReset();
    mocks.getFuzzyCommandSuggestions.mockReset();
    mocks.logger.debug.mockReset();
    mocks.logger.info.mockReset();
    mocks.logger.warn.mockReset();
    mocks.logger.error.mockReset();

    mocks.resolveWorkspaceAgentResources.mockResolvedValue({
      commands: [],
      slashCommandProviders: [],
    });
    mocks.fastGlob.mockResolvedValue(['src/index.ts', 'README.md']);
    mocks.readdir.mockResolvedValue([
      {
        name: 'src',
        isDirectory: () => true,
        isFile: () => false,
      },
      {
        name: 'README.md',
        isDirectory: () => false,
        isFile: () => true,
      },
    ]);
    mocks.execSync.mockReturnValue('main\n');
    mocks.stat.mockResolvedValue({
      isFile: true,
      size: 12,
    });
    mocks.readTextFile.mockResolvedValue('hello world');
    mocks.getFuzzyCommandSuggestions.mockReturnValue([
      {
        command: '/help',
        description: 'Help',
      },
    ]);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (previousStorageRoot === undefined) {
      delete process.env.BLADE_STORAGE_ROOT;
    } else {
      process.env.BLADE_STORAGE_ROOT = previousStorageRoot;
    }
    await rm(storageRoot, { recursive: true, force: true });
  });

  it('rejects a protected ACP host-state root before suggestions side effects', async () => {
    const app = createSuggestionsApp();

    const commandsResponse = await app.request('/suggestions/commands?q=he', {
      headers: { 'x-blade-directory': protectedRoot },
    });
    expect(commandsResponse.status).toBe(400);
    await expect(commandsResponse.json()).resolves.toMatchObject({
      error: { code: 'BAD_REQUEST' },
    });
    expect(mocks.resolveWorkspaceAgentResources).not.toHaveBeenCalled();

    const filesResponse = await app.request(
      `/suggestions/files?q=src&directory=${encodeURIComponent(protectedRoot)}`
    );
    expect(filesResponse.status).toBe(400);
    await expect(filesResponse.json()).resolves.toMatchObject({
      error: { code: 'BAD_REQUEST' },
    });
    expect(mocks.fastGlob).not.toHaveBeenCalled();

    const treeResponse = await app.request('/suggestions/files/tree', {
      headers: { 'x-blade-directory': protectedRoot },
    });
    expect(treeResponse.status).toBe(400);
    await expect(treeResponse.json()).resolves.toMatchObject({
      error: { code: 'BAD_REQUEST' },
    });
    expect(mocks.readdir).not.toHaveBeenCalled();

    const contentResponse = await app.request(
      `/suggestions/files/content?path=${encodeURIComponent('README.md')}&directory=${encodeURIComponent(protectedRoot)}`
    );
    expect(contentResponse.status).toBe(400);
    await expect(contentResponse.json()).resolves.toMatchObject({
      error: { code: 'BAD_REQUEST' },
    });
    expect(mocks.stat).not.toHaveBeenCalled();
    expect(mocks.readTextFile).not.toHaveBeenCalled();

    const gitInfoResponse = await app.request('/suggestions/git-info', {
      headers: { 'x-blade-directory': protectedRoot },
    });
    expect(gitInfoResponse.status).toBe(400);
    await expect(gitInfoResponse.json()).resolves.toMatchObject({
      error: { code: 'BAD_REQUEST' },
    });
    expect(mocks.execSync).not.toHaveBeenCalled();
  });

  it('rejects file tree subpaths that escape the local workspace', async () => {
    const app = createSuggestionsApp();

    const response = await app.request(
      `/suggestions/files/tree?path=${encodeURIComponent('../outside')}`,
      {
        headers: { 'x-blade-directory': localDirectory },
      }
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'Invalid file path' });
    expect(mocks.readdir).not.toHaveBeenCalled();
  });

  it('keeps local file tree directories whose names begin with two dots', async () => {
    const app = createSuggestionsApp();

    const response = await app.request(
      `/suggestions/files/tree?path=${encodeURIComponent('..notes')}`,
      {
        headers: { 'x-blade-directory': localDirectory },
      }
    );

    expect(response.status).toBe(200);
    expect(mocks.readdir).toHaveBeenCalledWith(
      path.resolve(localDirectory, '..notes'),
      { withFileTypes: true }
    );
  });

  it('keeps ordinary local absolute paths working for suggestions routes', async () => {
    const app = createSuggestionsApp();

    const commandsResponse = await app.request('/suggestions/commands?q=he', {
      headers: { 'x-blade-directory': localDirectory },
    });
    expect(commandsResponse.status).toBe(200);
    await expect(commandsResponse.json()).resolves.toEqual([
      { command: '/help', description: 'Help' },
    ]);
    expect(mocks.resolveWorkspaceAgentResources).toHaveBeenCalledWith(localDirectory);

    const filesResponse = await app.request(
      '/suggestions/files?directory=/tmp/blade-local-workspace'
    );
    expect(filesResponse.status).toBe(200);
    await expect(filesResponse.json()).resolves.toEqual(['src/index.ts', 'README.md']);
    expect(mocks.fastGlob).toHaveBeenCalledWith(
      '**/*',
      expect.objectContaining({ cwd: localDirectory })
    );

    const treeResponse = await app.request('/suggestions/files/tree', {
      headers: { 'x-blade-directory': localDirectory },
    });
    expect(treeResponse.status).toBe(200);
    await expect(treeResponse.json()).resolves.toEqual([
      { name: 'src', path: 'src', type: 'dir' },
      { name: 'README.md', path: 'README.md', type: 'file' },
    ]);
    expect(mocks.readdir).toHaveBeenCalledWith(localDirectory, {
      withFileTypes: true,
    });

    const contentResponse = await app.request(
      '/suggestions/files/content?path=README.md',
      {
        headers: { 'x-blade-directory': localDirectory },
      }
    );
    expect(contentResponse.status).toBe(200);
    await expect(contentResponse.json()).resolves.toEqual({
      path: 'README.md',
      content: 'hello world',
      truncated: false,
      size: 12,
    });
    expect(mocks.stat).toHaveBeenCalledWith(path.resolve(localDirectory, 'README.md'));
    expect(mocks.readTextFile).toHaveBeenCalledWith(
      path.resolve(localDirectory, 'README.md')
    );

    const gitInfoResponse = await app.request('/suggestions/git-info', {
      headers: { 'x-blade-directory': localDirectory },
    });
    expect(gitInfoResponse.status).toBe(200);
    await expect(gitInfoResponse.json()).resolves.toEqual({ branch: 'main' });
    expect(mocks.execSync).toHaveBeenCalledWith(
      'git rev-parse --abbrev-ref HEAD',
      expect.objectContaining({ cwd: localDirectory })
    );
  });
});
