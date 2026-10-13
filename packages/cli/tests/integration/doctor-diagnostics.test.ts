import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { collectDoctorDiagnostics } from '../../src/commands/doctor/diagnostics.js';
import { checkDoctorMcpServers } from '../../src/commands/doctor/mcp.js';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import { AutoMemoryManager } from '../../src/memory/AutoMemoryManager.js';
import { resetWorkspaceIdentityCache } from '../../src/security/WorkspaceIdentity.js';
import { WorkspaceTrustService } from '../../src/security/WorkspaceTrustService.js';

vi.unmock('child_process');
vi.unmock('node:child_process');

describe('doctor with real project files and MCP transport', () => {
  let root: string;
  let previousStorageRoot: string | undefined;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'blade-doctor-'));
    previousStorageRoot = process.env.BLADE_STORAGE_ROOT;
    process.env.BLADE_STORAGE_ROOT = path.join(root, 'storage');
    WorkspaceTrustService.resetInstance();
    resetWorkspaceIdentityCache();
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    if (previousStorageRoot === undefined) delete process.env.BLADE_STORAGE_ROOT;
    else process.env.BLADE_STORAGE_ROOT = previousStorageRoot;
    WorkspaceTrustService.resetInstance();
    resetWorkspaceIdentityCache();
  });

  it('reports trust, oversized instructions and truncated Auto Memory', async () => {
    await writeFile(path.join(root, 'AGENTS.md'), 'x'.repeat(33 * 1024));
    const memoryDir = new AutoMemoryManager(root).getMemoryDir();
    await mkdir(memoryDir, { recursive: true });
    await writeFile(
      path.join(memoryDir, 'MEMORY.md'),
      Array(210).fill('topic').join('\n')
    );
    const results = await collectDoctorDiagnostics(
      {
        ...DEFAULT_CONFIG,
        models: [],
        mcpServers: {},
        permissions: { allow: [], ask: [], deny: [] },
      },
      root
    );
    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Workspace Trust', level: 'warn' }),
        expect.objectContaining({
          name: 'Project instructions',
          level: 'warn',
          message: expect.stringContaining('AGENTS.md'),
        }),
        expect.objectContaining({
          name: 'Auto Memory',
          level: 'warn',
          message: expect.stringContaining('210 lines'),
        }),
      ])
    );
  });

  it('reports an omitted static rule when trusted instructions exceed the budget', async () => {
    await writeFile(path.join(root, 'AGENTS.md'), 'x'.repeat(30 * 1024));
    await writeFile(path.join(root, 'BLADE.md'), 'y'.repeat(30 * 1024));
    await WorkspaceTrustService.getInstance().trust(root);
    const results = await collectDoctorDiagnostics(
      {
        ...DEFAULT_CONFIG,
        mcpServers: {},
        permissions: { allow: [], ask: [], deny: [] },
      },
      root
    );
    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'Project instructions',
          level: 'warn',
          message: expect.stringContaining('static files omitted'),
        }),
      ])
    );
  });

  it('counts real MCP tools and terminates its owned stdio server', async () => {
    const pidFile = path.join(root, 'server.pid');
    const results = await checkDoctorMcpServers(
      {
        fixture: {
          type: 'stdio',
          command: process.execPath,
          args: [
            path.resolve(
              import.meta.dirname,
              '../support/fake-mcp-lifecycle-server.mjs'
            ),
          ],
          env: { MCP_LIFECYCLE_PID_FILE: pidFile },
        },
      },
      root
    );
    expect(results[0]).toMatchObject({
      name: 'MCP fixture',
      level: 'ok',
      message: expect.stringMatching(/\d+ tools; \d+ declaration bytes/),
    });
    const pid = Number((await readFile(pidFile, 'utf8')).trim());
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it('times out and terminates a server that never initializes', async () => {
    const pidFile = path.join(root, 'silent.pid');
    const started = Date.now();
    const results = await checkDoctorMcpServers(
      {
        silent: {
          type: 'stdio',
          command: process.execPath,
          args: [
            '-e',
            "require('fs').writeFileSync(process.env.DOCTOR_PID, String(process.pid)); setInterval(() => {}, 1000);",
          ],
          env: { DOCTOR_PID: pidFile },
        },
      },
      root
    );
    expect(results[0]).toMatchObject({
      level: 'warn',
      message: expect.stringContaining('timed out'),
    });
    expect(Date.now() - started).toBeLessThan(15_000);
    const pid = Number((await readFile(pidFile, 'utf8')).trim());
    expect(() => process.kill(pid, 0)).toThrow();
  }, 20_000);
});
