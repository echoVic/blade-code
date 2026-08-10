import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveMcpConfigFromCli } from '../../../../src/mcp/loadMcpConfig.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe('resolveMcpConfigFromCli', () => {
  it('parses wrapped files, single-server JSON, and later overrides', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'blade-mcp-config-'));
    roots.push(root);
    const file = path.join(root, 'mcp.json');
    await writeFile(
      file,
      JSON.stringify({
        mcpServers: {
          file: { type: 'stdio', command: 'file-server' },
          shared: { type: 'stdio', command: 'from-file' },
        },
      })
    );

    const result = await resolveMcpConfigFromCli(
      [
        file,
        JSON.stringify({
          name: 'single',
          type: 'http',
          url: 'https://mcp.example.com',
        }),
        JSON.stringify({
          shared: { type: 'stdio', command: 'from-last-argument' },
        }),
      ],
      {
        base: { type: 'stdio', command: 'base-server' },
      }
    );

    expect(result).toEqual({
      base: { type: 'stdio', command: 'base-server' },
      file: { type: 'stdio', command: 'file-server' },
      shared: { type: 'stdio', command: 'from-last-argument' },
      single: {
        type: 'http',
        url: 'https://mcp.example.com',
      },
    });
  });

  it('keeps valid sources when another explicit source is malformed', async () => {
    await expect(
      resolveMcpConfigFromCli(['{"broken":'], {
        base: { type: 'stdio', command: 'base-server' },
      })
    ).resolves.toEqual({
      base: { type: 'stdio', command: 'base-server' },
    });
  });
});
