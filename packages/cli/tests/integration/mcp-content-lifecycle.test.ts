import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type McpContentCatalogChange,
  McpRegistry,
  type McpResourceUpdated,
} from '../../src/mcp/McpRegistry.js';

vi.unmock('child_process');
vi.unmock('node:child_process');

const serverEntry = path.resolve(
  import.meta.dirname,
  '../support/fake-mcp-content-server.mjs'
);

describe('MCP resources and prompts over real stdio transport', () => {
  let root: string;
  let pidFile: string;
  let traceFile: string;
  let registry: McpRegistry;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'blade-mcp-content-'));
    pidFile = path.join(root, 'server.pid');
    traceFile = path.join(root, 'trace.jsonl');
    registry = McpRegistry.createIsolated();
  });

  afterEach(async () => {
    await registry.disconnectAll();
    await rm(root, { recursive: true, force: true });
  });

  it('paginates, reads, resolves prompts, refreshes, and scopes subscriptions', async () => {
    const catalogChanges: McpContentCatalogChange[] = [];
    const resourceUpdates: McpResourceUpdated[] = [];
    registry.on('contentCatalogChanged', (change) => catalogChanges.push(change));
    registry.on('resourceUpdated', (update) => resourceUpdates.push(update));

    await registry.registerServer('content', {
      type: 'stdio',
      command: process.execPath,
      args: [serverEntry],
      env: {
        MCP_CONTENT_PID_FILE: pidFile,
        MCP_CONTENT_TRACE_FILE: traceFile,
      },
    });

    const initial = registry.getContentCatalogSnapshot();
    expect(initial.resources.map((resource) => resource.uri)).toEqual([
      'context://live',
      'context://obsolete',
      'context://binary',
    ]);
    expect(initial.resourceTemplates).toEqual([
      expect.objectContaining({
        server: 'content',
        uriTemplate: 'context://item/{id}',
      }),
    ]);
    expect(initial.prompts.map((prompt) => prompt.name)).toEqual([
      'compose_report',
      'obsolete_prompt',
    ]);
    expect(catalogChanges.map((change) => change.kind)).toEqual([
      'resources',
      'resourceTemplates',
      'prompts',
    ]);

    const live = await registry.readResource('content', 'context://live');
    expect(live.contents).toEqual([
      expect.objectContaining({ text: 'LIVE_RESOURCE_V1' }),
      expect.objectContaining({ text: '{"version":1}' }),
    ]);
    const binary = await registry.readResource('content', 'context://binary');
    expect(binary).toEqual({
      contents: [
        {
          uri: 'context://binary',
          mimeType: 'application/octet-stream',
          binary: {
            size: 15,
            sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
            omitted: true,
          },
        },
      ],
    });
    expect(JSON.stringify(binary)).not.toContain(
      Buffer.from('BINARY_RESOURCE').toString('base64')
    );

    await expect(registry.getPrompt('content', 'compose_report')).rejects.toThrow(
      'Required argument "topic" is missing'
    );
    const prompt = await registry.getPrompt('content', 'compose_report', {
      topic: 'MCP',
    });
    expect(prompt).toEqual({
      description: 'Resolved report prompt',
      messages: [
        {
          role: 'user',
          content: { type: 'text', text: 'PROMPT_OK:MCP' },
        },
        {
          role: 'assistant',
          content: {
            type: 'resource',
            resource: expect.objectContaining({ text: 'LIVE_RESOURCE_V1' }),
          },
        },
      ],
    });

    await registry.setResourceSubscription('content', 'context://live', true);
    const client = registry.getServerStatus('content')!.client;
    const update = await client.callTool('update_live_resource');
    expect(update.content[0]?.text).toBe('LIVE_RESOURCE_V2');
    await expect.poll(() => resourceUpdates.length).toBe(1);
    expect(resourceUpdates[0]).toMatchObject({
      serverName: 'content',
      uri: 'context://live',
    });
    expect(
      (await registry.readResource('content', 'context://live')).contents[0]?.text
    ).toBe('LIVE_RESOURCE_V2');

    const advance = await client.callTool('advance_content_catalog');
    expect(advance.content[0]?.text).toBe('CONTENT_CATALOG_ADVANCED');
    await client.waitForCatalogRefresh();
    const dynamic = registry.getContentCatalogSnapshot();
    expect(dynamic.resources.map((resource) => resource.uri)).toEqual([
      'context://live',
      'context://new',
      'context://binary',
    ]);
    expect(dynamic.prompts.map((item) => item.name)).toEqual([
      'compose_report',
      'new_prompt',
    ]);
    expect(catalogChanges.slice(-3)).toEqual([
      expect.objectContaining({
        kind: 'resources',
        reason: 'notification',
        added: ['context://new'],
        removed: ['context://obsolete'],
        updated: ['context://live'],
      }),
      expect.objectContaining({
        kind: 'resourceTemplates',
        reason: 'notification',
        updated: ['context://item/{id}'],
      }),
      expect.objectContaining({
        kind: 'prompts',
        reason: 'notification',
        added: ['new_prompt'],
        removed: ['obsolete_prompt'],
        updated: ['compose_report'],
      }),
    ]);

    await registry.setResourceSubscription('content', 'context://live', false);
    const trace = (await readFile(traceFile, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(trace.filter((entry) => entry.event === 'resources_list')).toHaveLength(4);
    expect(trace.filter((entry) => entry.event === 'prompts_list')).toHaveLength(4);
    expect(trace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: 'resource_subscribed' }),
        expect.objectContaining({ event: 'resource_unsubscribed' }),
        expect.objectContaining({
          event: 'prompt_get',
          args: { topic: 'MCP' },
        }),
      ])
    );

    const pid = Number(await readFile(pidFile, 'utf8'));
    await registry.disconnectAll();
    await expect
      .poll(() => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      })
      .toBe(false);
  });
});
