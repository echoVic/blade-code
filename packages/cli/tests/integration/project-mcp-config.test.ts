import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setCwdState } from '../../src/bootstrap/state.js';
import { ConfigManager } from '../../src/config/ConfigManager.js';
import { McpClient } from '../../src/mcp/McpClient.js';
import { resolveWorkspaceMcpConfig } from '../../src/mcp/resolveWorkspaceMcpConfig.js';
import { resetWorkspaceIdentityCache } from '../../src/security/WorkspaceIdentity.js';
import { WorkspaceTrustService } from '../../src/security/WorkspaceTrustService.js';
import { getCwd } from '../../src/utils/cwd.js';

vi.unmock('child_process');
vi.unmock('node:child_process');

describe('project root .mcp.json configuration', () => {
  let root: string;
  let workspace: string;
  let previousCwd: string;
  let previousStorage: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'blade-project-mcp-'));
    workspace = path.join(root, 'workspace');
    await mkdir(workspace);
    workspace = await realpath(workspace);
    previousCwd = getCwd();
    previousStorage = process.env.BLADE_STORAGE_ROOT;
    process.env.BLADE_STORAGE_ROOT = path.join(root, 'storage');
    setCwdState(workspace);
    ConfigManager.resetInstance();
    WorkspaceTrustService.resetInstance();
    resetWorkspaceIdentityCache();
  });

  afterEach(async () => {
    setCwdState(previousCwd);
    if (previousStorage === undefined) delete process.env.BLADE_STORAGE_ROOT;
    else process.env.BLADE_STORAGE_ROOT = previousStorage;
    ConfigManager.resetInstance();
    WorkspaceTrustService.resetInstance();
    resetWorkspaceIdentityCache();
    await rm(root, { recursive: true, force: true });
  });

  const writeRoot = async (project: string, value: unknown) =>
    writeFile(path.join(project, '.mcp.json'), JSON.stringify(value));

  it('requires trust, summarizes inferred transports, and loads only MCP settings', async () => {
    await writeRoot(workspace, {
      mcpServers: {
        local: { command: 'node', args: ['server.mjs'] },
        remote: { url: 'https://mcp.example.com/rpc?token=PRIVATE_URL' },
      },
      permissionMode: 'yolo',
    });
    const trust = WorkspaceTrustService.getInstance();
    const blocked = await trust.getStatus(workspace);
    expect(blocked.state).toBe('untrusted');
    expect(blocked.sources).toContainEqual(
      expect.objectContaining({
        path: '.mcp.json',
        effects: expect.arrayContaining([
          { kind: 'mcp', name: 'local (stdio)', target: 'node server.mjs' },
          { kind: 'mcp', name: 'remote (http)', target: 'https://mcp.example.com/rpc' },
        ]),
      })
    );
    expect(JSON.stringify(blocked)).not.toContain('PRIVATE_URL');
    const blockedConfig = await ConfigManager.getInstance().initialize();
    expect(blockedConfig.mcpServers.local).toBeUndefined();

    await trust.trust(workspace);
    const config = await ConfigManager.getInstance().initialize();
    expect(config.mcpServers.local).toMatchObject({ type: 'stdio', command: 'node' });
    expect(config.mcpServers.remote.type).toBe('http');
    expect(config.permissionMode).not.toBe('yolo');
  });

  it('merges root config before Blade config and isolates another workspace', async () => {
    await writeRoot(workspace, {
      mcpServers: {
        rootOnly: { command: 'root-server' },
        shared: { command: 'from-root' },
      },
    });
    await mkdir(path.join(workspace, '.blade'));
    await writeFile(
      path.join(workspace, '.blade', 'config.json'),
      JSON.stringify({
        mcpServers: { shared: { type: 'stdio', command: 'from-blade' } },
      })
    );
    await writeFile(
      path.join(workspace, '.blade', 'settings.json'),
      JSON.stringify({
        mcpServers: { settingsOnly: { type: 'stdio', command: 'settings-server' } },
      })
    );
    await WorkspaceTrustService.getInstance().trust(workspace);
    const config = await ConfigManager.getInstance().initialize();
    expect(config.mcpServers.shared.command).toBe('from-blade');
    expect(config.mcpServers.rootOnly.command).toBe('root-server');
    expect(config.mcpServers.settingsOnly.command).toBe('settings-server');
    const second = path.join(root, 'second');
    await mkdir(second);
    await writeRoot(second, {
      mcpServers: { secondOnly: { command: 'second-server' } },
    });
    await WorkspaceTrustService.getInstance().trust(second);
    const servers = await ConfigManager.getInstance().loadWorkspaceMcpServers(
      second,
      config.mcpServers
    );
    expect(servers.secondOnly.command).toBe('second-server');
    expect(servers.rootOnly).toBeUndefined();
    expect(servers.shared?.command).not.toBe('from-blade');
  });

  it('uses existing environment interpolation for root server arguments', async () => {
    await writeRoot(workspace, {
      mcpServers: {
        interpolated: {
          command: 'node',
          args: ['${BLADE_PROJECT_MCP_ABSENT:-server.mjs}'],
        },
      },
    });
    await WorkspaceTrustService.getInstance().trust(workspace);
    const config = await ConfigManager.getInstance().initialize();
    expect(config.mcpServers.interpolated.args).toEqual(['server.mjs']);
  });

  it('keeps malformed root configuration blocked and ignores it after trust', async () => {
    await writeRoot(workspace, { mcpServers: { invalid: { command: ['bad'] } } });
    const trust = WorkspaceTrustService.getInstance();
    expect((await trust.getStatus(workspace)).state).toBe('untrusted');
    await trust.trust(workspace);
    const config = await ConfigManager.getInstance().initialize();
    expect(config.mcpServers.invalid).toBeUndefined();
  });

  it('connects an inferred stdio server with a workspace-relative cwd', async () => {
    const server = path.resolve(
      import.meta.dirname,
      '../support/fake-mcp-logging-server.mjs'
    );
    await writeRoot(workspace, {
      mcpServers: {
        local: {
          command: process.execPath,
          args: [server],
          cwd: '.',
          env: {
            MCP_LOGGING_PID_FILE: path.join(root, 'server.pid'),
            MCP_LOGGING_TRACE_FILE: path.join(root, 'trace.jsonl'),
          },
        },
      },
    });
    await WorkspaceTrustService.getInstance().trust(workspace);
    const config = await ConfigManager.getInstance().initialize();
    const servers = await resolveWorkspaceMcpConfig({
      workspaceRoot: workspace,
      storeServers: config.mcpServers,
    });
    expect(servers.local.cwd).toBe(workspace);
    const client = new McpClient(servers.local, 'local');
    try {
      await client.connect();
      expect(client.availableTools.length).toBeGreaterThan(0);
    } finally {
      await client.disconnect();
    }
  });
});
