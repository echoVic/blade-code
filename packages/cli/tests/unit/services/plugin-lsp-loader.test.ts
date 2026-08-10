import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PluginLoader } from '../../../src/plugins/PluginLoader.js';

describe('PluginLoader LSP resources', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))
    );
  });

  it('loads namespaced .lsp.json servers and expands the immutable plugin root', async () => {
    const pluginRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'blade-plugin-lsp-'));
    roots.push(pluginRoot);
    await fs.mkdir(path.join(pluginRoot, '.blade-plugin'), { recursive: true });
    await fs.writeFile(
      path.join(pluginRoot, '.blade-plugin', 'plugin.json'),
      JSON.stringify({
        name: 'semantic-plugin',
        description: 'Semantic tooling fixture',
        version: '1.0.0',
      })
    );
    await fs.writeFile(
      path.join(pluginRoot, '.lsp.json'),
      JSON.stringify({
        lspServers: {
          typescript: {
            command: '${BLADE_PLUGIN_ROOT}/server.mjs',
            args: ['--root', '${CLAUDE_PLUGIN_ROOT}'],
            extensionToLanguage: { ts: 'typescript' },
            env: { PLUGIN_ROOT: '${BLADE_PLUGIN_ROOT}' },
          },
        },
      })
    );

    const plugin = await new PluginLoader().loadPlugin(pluginRoot, 'user');

    expect(plugin.lspServers).toMatchObject({
      'plugin:semantic-plugin:typescript': {
        command: path.join(pluginRoot, 'server.mjs'),
        args: ['--root', pluginRoot],
        extensionToLanguage: { '.ts': 'typescript' },
        env: { PLUGIN_ROOT: pluginRoot },
      },
    });
  });
});
