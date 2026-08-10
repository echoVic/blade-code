import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PluginInstaller } from '../../../src/plugins/PluginInstaller.js';

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function writeMarketplace(
  root: string,
  marker: string,
  version: string
): Promise<void> {
  await writeJson(path.join(root, '.blade-plugin', 'marketplace.json'), {
    name: 'test-market',
    description: 'Test marketplace',
    plugins: [
      {
        name: 'managed-plugin',
        description: 'Managed fixture',
        version,
        source: './plugins/managed-plugin',
      },
    ],
  });
  await writeJson(
    path.join(root, 'plugins', 'managed-plugin', '.blade-plugin', 'plugin.json'),
    {
      name: 'managed-plugin',
      description: 'Managed fixture',
      version,
    }
  );
  const commandPath = path.join(
    root,
    'plugins',
    'managed-plugin',
    'commands',
    'reveal.md'
  );
  await fs.mkdir(path.dirname(commandPath), { recursive: true });
  await fs.writeFile(commandPath, marker, 'utf8');
}

async function writePlugin(
  root: string,
  name: string,
  version: string,
  dependencies: Record<string, string> = {},
  bladeVersion?: string
): Promise<void> {
  await writeJson(path.join(root, 'plugins', name, '.blade-plugin', 'plugin.json'), {
    name,
    description: `${name} fixture`,
    version,
    dependencies,
    ...(bladeVersion ? { bladeVersion } : {}),
  });
}

describe('PluginInstaller package store', () => {
  let root: string;
  let marketplaceRoot: string;
  let installer: PluginInstaller;
  let stateRoot: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'blade-plugin-package-'));
    marketplaceRoot = path.join(root, 'marketplace');
    stateRoot = path.join(root, 'state');
    installer = new PluginInstaller(path.join(root, 'legacy-plugins'), stateRoot);
    await writeMarketplace(marketplaceRoot, 'VERSION_ONE', '1.0.0');
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('requires explicit trust before materializing executable plugin resources', async () => {
    const marketplace = await installer.addMarketplace(marketplaceRoot);
    expect(marketplace.success).toBe(true);

    await expect(
      installer.install('managed-plugin@test-market')
    ).resolves.toMatchObject({
      success: false,
      code: 'SOURCE_TRUST_REQUIRED',
    });
    await expect(installer.listInstalled()).resolves.toEqual([]);
  });

  it('atomically publishes immutable updates and keeps old package roots alive', async () => {
    const marketplace = await installer.addMarketplace(marketplaceRoot);
    expect(marketplace.success).toBe(true);
    await expect(installer.listMarketplaces()).resolves.toHaveLength(1);

    const installed = await installer.install('managed-plugin@test-market', {
      trusted: true,
    });
    expect(installed, JSON.stringify(installed)).toMatchObject({
      success: true,
      pluginName: 'managed-plugin',
      manifest: { version: '1.0.0' },
      changed: true,
    });
    const firstPath = installed.pluginPath!;
    expect(
      await fs.readFile(path.join(firstPath, 'commands', 'reveal.md'), 'utf8')
    ).toBe('VERSION_ONE');
    expect((await fs.stat(path.join(stateRoot, 'state.json'))).mode & 0o777).toBe(
      0o600
    );

    await writeMarketplace(marketplaceRoot, 'BROKEN_UPDATE', '1.1.0');
    await writeJson(
      path.join(
        marketplaceRoot,
        'plugins',
        'managed-plugin',
        '.blade-plugin',
        'plugin.json'
      ),
      {
        name: 'renamed-plugin',
        description: 'Invalid update identity',
        version: '1.1.0',
      }
    );
    await installer.refreshMarketplace('test-market');
    await expect(
      installer.update('managed-plugin', { trusted: true })
    ).resolves.toMatchObject({
      success: false,
      code: 'PLUGIN_IDENTITY_MISMATCH',
    });
    await expect(installer.getInstallation('managed-plugin')).resolves.toMatchObject({
      installPath: firstPath,
      version: '1.0.0',
    });

    await writeMarketplace(marketplaceRoot, 'VERSION_TWO', '2.0.0');
    const refreshed = await installer.refreshMarketplace('test-market');
    expect(refreshed).toMatchObject({ success: true, changed: true });
    const updated = await installer.update('managed-plugin', { trusted: true });
    expect(updated).toMatchObject({
      success: true,
      manifest: { version: '2.0.0' },
      changed: true,
    });
    expect(updated.pluginPath).not.toBe(firstPath);
    expect(
      await fs.readFile(path.join(updated.pluginPath!, 'commands', 'reveal.md'), 'utf8')
    ).toBe('VERSION_TWO');
    expect(
      await fs.readFile(path.join(firstPath, 'commands', 'reveal.md'), 'utf8')
    ).toBe('VERSION_ONE');

    await expect(installer.uninstall('managed-plugin')).resolves.toMatchObject({
      success: false,
      code: 'CONFIRMATION_REQUIRED',
    });
    await expect(installer.uninstall('managed-plugin', true)).resolves.toMatchObject({
      success: true,
    });
    await expect(installer.listInstalled()).resolves.toEqual([]);
    await expect(fs.access(firstPath)).resolves.toBeUndefined();
    await expect(fs.access(updated.pluginPath!)).resolves.toBeUndefined();
  });

  it('fails closed when immutable package contents are modified after install', async () => {
    await installer.addMarketplace(marketplaceRoot);
    const installed = await installer.install('managed-plugin@test-market', {
      trusted: true,
    });
    const installation = installed.installation!;
    await installer.verifyInstallation(installation);

    await fs.writeFile(
      path.join(installation.installPath, 'commands', 'reveal.md'),
      'TAMPERED',
      'utf8'
    );
    await expect(installer.verifyInstallation(installation)).rejects.toThrow(
      'failed content verification'
    );
  });

  it('protects marketplace deletion while managed plugins depend on it', async () => {
    await installer.addMarketplace(marketplaceRoot);
    await installer.install('managed-plugin@test-market', { trusted: true });

    await expect(
      installer.removeMarketplace('test-market', true)
    ).resolves.toMatchObject({
      success: false,
      code: 'MARKETPLACE_IN_USE',
    });

    await installer.uninstall('managed-plugin', true);
    await expect(
      installer.removeMarketplace('test-market', true)
    ).resolves.toMatchObject({
      success: true,
    });
  });

  it('installs a same-Marketplace dependency closure in one ledger transaction', async () => {
    await writeJson(path.join(marketplaceRoot, '.blade-plugin', 'marketplace.json'), {
      name: 'test-market',
      plugins: [
        { name: 'managed-plugin', source: './plugins/managed-plugin' },
        { name: 'dependency-plugin', source: './plugins/dependency-plugin' },
      ],
    });
    await writePlugin(marketplaceRoot, 'managed-plugin', '1.0.0', {
      'dependency-plugin': '^2.0.0',
    });
    await writePlugin(marketplaceRoot, 'dependency-plugin', '2.4.0');
    await installer.addMarketplace(marketplaceRoot);

    const installed = await installer.install('managed-plugin@test-market', {
      trusted: true,
    });

    expect(installed).toMatchObject({
      success: true,
      installedDependencies: ['dependency-plugin'],
    });
    await expect(installer.listInstalled()).resolves.toEqual([
      'dependency-plugin',
      'managed-plugin',
    ]);
  });

  it('rejects dependency cycles and incompatible Blade versions without partial state', async () => {
    await writeJson(path.join(marketplaceRoot, '.blade-plugin', 'marketplace.json'), {
      name: 'test-market',
      plugins: [
        { name: 'managed-plugin', source: './plugins/managed-plugin' },
        { name: 'dependency-plugin', source: './plugins/dependency-plugin' },
      ],
    });
    await writePlugin(marketplaceRoot, 'managed-plugin', '1.0.0', {
      'dependency-plugin': '^1.0.0',
    });
    await writePlugin(marketplaceRoot, 'dependency-plugin', '1.0.0', {
      'managed-plugin': '^1.0.0',
    });
    await installer.addMarketplace(marketplaceRoot);
    await expect(
      installer.install('managed-plugin@test-market', { trusted: true })
    ).resolves.toMatchObject({
      success: false,
      code: 'DEPENDENCY_CYCLE',
    });
    await expect(installer.listInstalled()).resolves.toEqual([]);

    await writePlugin(marketplaceRoot, 'managed-plugin', '1.0.0', {}, '>=99.0.0');
    await installer.refreshMarketplace('test-market');
    await expect(
      installer.install('managed-plugin@test-market', { trusted: true })
    ).resolves.toMatchObject({
      success: false,
      code: 'VERSION_INCOMPATIBLE',
    });
    await expect(installer.listInstalled()).resolves.toEqual([]);
  });

  it('atomically adds new dependencies during a managed update', async () => {
    await installer.addMarketplace(marketplaceRoot);
    await installer.install('managed-plugin@test-market', { trusted: true });

    await writeJson(path.join(marketplaceRoot, '.blade-plugin', 'marketplace.json'), {
      name: 'test-market',
      plugins: [
        { name: 'managed-plugin', source: './plugins/managed-plugin' },
        { name: 'dependency-plugin', source: './plugins/dependency-plugin' },
      ],
    });
    await writePlugin(marketplaceRoot, 'managed-plugin', '2.0.0', {
      'dependency-plugin': '^1.0.0',
    });
    await writePlugin(marketplaceRoot, 'dependency-plugin', '1.2.0');
    await installer.refreshMarketplace('test-market');

    await expect(
      installer.update('managed-plugin', { trusted: true })
    ).resolves.toMatchObject({
      success: true,
      manifest: { version: '2.0.0' },
      updatedDependencies: ['dependency-plugin'],
    });
    await expect(installer.listInstalled()).resolves.toEqual([
      'dependency-plugin',
      'managed-plugin',
    ]);
  });

  it('serializes package ledger mutations across independent manager instances', async () => {
    await writeJson(path.join(marketplaceRoot, '.blade-plugin', 'marketplace.json'), {
      name: 'test-market',
      plugins: [
        {
          name: 'managed-plugin',
          source: './plugins/managed-plugin',
        },
        {
          name: 'second-plugin',
          source: './plugins/second-plugin',
        },
      ],
    });
    await writeJson(
      path.join(
        marketplaceRoot,
        'plugins',
        'second-plugin',
        '.blade-plugin',
        'plugin.json'
      ),
      {
        name: 'second-plugin',
        description: 'Second fixture',
        version: '1.0.0',
      }
    );
    await installer.addMarketplace(marketplaceRoot);
    const secondManager = new PluginInstaller(
      path.join(root, 'legacy-plugins'),
      stateRoot
    );

    const [first, second] = await Promise.all([
      installer.install('managed-plugin@test-market', { trusted: true }),
      secondManager.install('second-plugin@test-market', { trusted: true }),
    ]);
    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    await expect(installer.listInstalled()).resolves.toEqual([
      'managed-plugin',
      'second-plugin',
    ]);
  });

  it('fails closed on unknown package-state fields', async () => {
    await installer.addMarketplace(marketplaceRoot);
    const statePath = path.join(stateRoot, 'state.json');
    const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
    state.unreviewed = true;
    await fs.writeFile(statePath, `${JSON.stringify(state)}\n`, 'utf8');

    await expect(installer.listMarketplaces()).rejects.toThrow(
      'Plugin package state schema is invalid'
    );
  });

  it('rejects path escapes, symlinks, unsafe protocols, and URL credentials', async () => {
    await writeJson(path.join(marketplaceRoot, '.blade-plugin', 'marketplace.json'), {
      name: 'test-market',
      plugins: [
        {
          name: 'managed-plugin',
          source: '../outside',
        },
      ],
    });
    await fs.mkdir(path.join(root, 'outside'), { recursive: true });
    await writeJson(path.join(root, 'outside', '.blade-plugin', 'plugin.json'), {
      name: 'managed-plugin',
      description: 'Outside fixture',
      version: '1.0.0',
    });
    await installer.addMarketplace(marketplaceRoot);
    await expect(
      installer.install('managed-plugin@test-market', { trusted: true })
    ).resolves.toMatchObject({
      success: false,
      code: 'MARKETPLACE_PATH_ESCAPE',
    });

    await expect(
      installer.install('file:///tmp/plugin', { trusted: true })
    ).resolves.toMatchObject({
      success: false,
      code: 'UNSAFE_GIT_PROTOCOL',
    });
    await expect(
      installer.install('https://user:secret@example.com/plugin.git', {
        trusted: true,
      })
    ).resolves.toMatchObject({
      success: false,
      code: 'GIT_CREDENTIALS_IN_URL',
    });

    const symlinkPlugin = path.join(root, 'symlink-plugin');
    await writeJson(path.join(symlinkPlugin, '.blade-plugin', 'plugin.json'), {
      name: 'symlink-plugin',
      description: 'Symlink fixture',
      version: '1.0.0',
    });
    await fs.symlink('/tmp', path.join(symlinkPlugin, 'escape'));
    await expect(
      installer.install(symlinkPlugin, { trusted: true })
    ).resolves.toMatchObject({
      success: false,
      code: 'PACKAGE_SYMLINK_FORBIDDEN',
    });
  });
});
