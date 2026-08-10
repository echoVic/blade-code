import path from 'node:path';
import { Hono } from 'hono';
import { resolveWorkspaceAgentResources } from '../../agent/resources/WorkspaceAgentResources.js';
import { ConfigManager } from '../../config/ConfigManager.js';
import { getPluginInstaller } from '../../plugins/PluginInstaller.js';
import {
  addPluginMarketplace,
  installWorkspacePlugin,
  refreshPluginMarketplace,
  refreshWorkspacePlugins,
  removePluginMarketplace,
  setWorkspacePluginEnabled,
  setWorkspacePluginSourcePolicy,
  uninstallWorkspacePlugin,
  updateWorkspacePlugin,
} from '../../plugins/PluginLifecycle.js';
import { StringEnum, safeParseSchema, Type } from '../../schema/index.js';
import { BadRequestError, NotFoundError } from '../error.js';

const PluginStateSchema = Type.Object({
  projectPath: Type.String({ minLength: 1 }),
  enabled: Type.Boolean(),
  scope: Type.Optional(StringEnum(['local', 'project', 'global'])),
});

const PluginRefreshSchema = Type.Object({
  projectPath: Type.String({ minLength: 1 }),
});

const PluginInstallSchema = Type.Object({
  projectPath: Type.String({ minLength: 1 }),
  source: Type.String({ minLength: 1 }),
  trust: Type.Literal(true),
  ref: Type.Optional(Type.String({ minLength: 1 })),
});

const PluginUpdateSchema = Type.Object({
  projectPath: Type.String({ minLength: 1 }),
  trust: Type.Literal(true),
});

const PluginUninstallSchema = Type.Object({
  projectPath: Type.String({ minLength: 1 }),
  confirm: Type.Literal(true),
});

const MarketplaceAddSchema = Type.Object({
  projectPath: Type.String({ minLength: 1 }),
  source: Type.String({ minLength: 1 }),
  ref: Type.Optional(Type.String({ minLength: 1 })),
});

const MarketplaceActionSchema = Type.Object({
  projectPath: Type.String({ minLength: 1 }),
  confirm: Type.Optional(Type.Literal(true)),
});

const PluginSourcePolicySchema = Type.Object({
  projectPath: Type.String({ minLength: 1 }),
  scope: Type.Optional(StringEnum(['local', 'project', 'global'])),
  policy: Type.Object({
    restrictToAllowedSources: Type.Boolean(),
    requireGitCommitSha: Type.Boolean(),
    allowedGitHosts: Type.Array(Type.String()),
    allowedMarketplaces: Type.Array(Type.String()),
    allowedLocalRoots: Type.Array(Type.String()),
  }),
});

function requireProjectPath(projectPath: string | undefined): string {
  if (!projectPath || !path.isAbsolute(projectPath)) {
    throw new BadRequestError('projectPath must be absolute');
  }
  return path.resolve(projectPath);
}

async function projectPlugins(projectPath: string) {
  const [resources, settingsResolution] = await Promise.all([
    resolveWorkspaceAgentResources(projectPath),
    ConfigManager.getInstance().loadWorkspacePluginSettingsResolution(projectPath),
  ]);
  return resources.plugins.getAll().map((plugin) => ({
    name: plugin.manifest.name,
    description: plugin.manifest.description,
    version: plugin.manifest.version,
    source: plugin.source,
    enabled: plugin.status === 'active',
    status: plugin.status,
    commands: plugin.commands.length,
    skills: plugin.skills.length,
    agents: plugin.agents.length,
    hooks: plugin.hooks
      ? Object.values(plugin.hooks).reduce(
          (count, value) => count + (Array.isArray(value) ? value.length : 0),
          0
        )
      : 0,
    mcpServers: Object.keys(plugin.mcpServers ?? {}).length,
    configurable: plugin.source !== 'cli',
    managed: plugin.installation !== undefined,
    marketplace:
      plugin.installation?.source.type === 'marketplace'
        ? plugin.installation.source.marketplace
        : undefined,
    revision: plugin.installation?.revision,
    installedAt: plugin.installation?.installedAt,
    updatedAt: plugin.installation?.updatedAt,
    compatibilityIssues: plugin.compatibilityIssues ?? [],
    effectiveScope:
      plugin.source === 'cli'
        ? 'invocation'
        : (settingsResolution.settings[plugin.manifest.name]?.effectiveScope ??
          'default'),
    settingLayers:
      plugin.source === 'cli'
        ? { invocation: true }
        : (settingsResolution.settings[plugin.manifest.name]?.layers ?? {}),
  }));
}

async function marketplaceCatalog() {
  const installer = getPluginInstaller();
  const [catalogs, installed] = await Promise.all([
    installer.listCatalogs(),
    installer.listInstallationRecords(),
  ]);
  const installedByName = new Map(installed.map((plugin) => [plugin.name, plugin]));
  return catalogs.map(({ marketplace, manifest }) => ({
    name: marketplace.name,
    description: manifest.description ?? manifest.metadata?.description ?? '',
    sourceType: marketplace.source.type,
    revision: marketplace.revision,
    updatedAt: marketplace.updatedAt,
    plugins: manifest.plugins.map((plugin) => {
      const installation = installedByName.get(plugin.name);
      return {
        name: plugin.name,
        description: plugin.description ?? '',
        version: plugin.version,
        category: plugin.category,
        tags: plugin.tags ?? [],
        installed: installation !== undefined,
        installedVersion: installation?.version,
      };
    }),
  }));
}

function requireSuccess(
  result: { success: boolean; error?: string },
  fallback: string
): void {
  if (!result.success) {
    throw new BadRequestError(result.error ?? fallback);
  }
}

export const PluginRoutes = () => {
  const app = new Hono();

  app.get('/', async (c) => {
    const projectPath = requireProjectPath(c.req.query('projectPath'));
    return c.json(await projectPlugins(projectPath));
  });

  app.post('/refresh', async (c) => {
    const parsed = safeParseSchema(PluginRefreshSchema, await c.req.json());
    if (!parsed.success) throw new BadRequestError('Invalid plugin refresh request');
    const projectPath = requireProjectPath(parsed.data.projectPath);
    const result = await refreshWorkspacePlugins(projectPath);
    return c.json({
      plugins: await projectPlugins(projectPath),
      errors: result.discovery.errors.map((error) => ({
        code: error.code ?? 'LOAD_ERROR',
        error: error.error,
      })),
    });
  });

  app.get('/catalog', async (c) => {
    requireProjectPath(c.req.query('projectPath'));
    return c.json(await marketplaceCatalog());
  });

  app.get('/policy', async (c) => {
    const projectPath = requireProjectPath(c.req.query('projectPath'));
    const policy =
      await ConfigManager.getInstance().loadWorkspacePluginSourcePolicy(projectPath);
    return c.json({
      policy,
      environmentRequiresSha:
        process.env.BLADE_PLUGIN_REQUIRE_SHA === '1' ||
        process.env.BLADE_PLUGIN_REQUIRE_SHA === 'true',
    });
  });

  app.post('/policy', async (c) => {
    const parsed = safeParseSchema(PluginSourcePolicySchema, await c.req.json());
    if (!parsed.success) {
      throw new BadRequestError('Invalid plugin source policy request');
    }
    const projectPath = requireProjectPath(parsed.data.projectPath);
    const policy = await setWorkspacePluginSourcePolicy(
      projectPath,
      parsed.data.policy,
      parsed.data.scope ?? 'global'
    );
    return c.json({ policy });
  });

  app.post('/install', async (c) => {
    const parsed = safeParseSchema(PluginInstallSchema, await c.req.json());
    if (!parsed.success) {
      throw new BadRequestError(
        'Invalid plugin install request; explicit source trust is required'
      );
    }
    const projectPath = requireProjectPath(parsed.data.projectPath);
    const { result } = await installWorkspacePlugin(projectPath, parsed.data.source, {
      trusted: parsed.data.trust,
      ref: parsed.data.ref,
    });
    requireSuccess(result, 'Plugin installation failed');
    return c.json({
      name: result.pluginName,
      version: result.manifest?.version,
      revision: result.installation?.revision,
      changed: result.changed,
      installedDependencies: result.installedDependencies ?? [],
    });
  });

  app.post('/marketplaces', async (c) => {
    const parsed = safeParseSchema(MarketplaceAddSchema, await c.req.json());
    if (!parsed.success) {
      throw new BadRequestError('Invalid marketplace add request');
    }
    const projectPath = requireProjectPath(parsed.data.projectPath);
    const result = await addPluginMarketplace(
      projectPath,
      parsed.data.source,
      parsed.data.ref
    );
    requireSuccess(result, 'Marketplace installation failed');
    return c.json({
      name: result.marketplace?.name,
      plugins: result.manifest?.plugins.length ?? 0,
      revision: result.marketplace?.revision,
      changed: result.changed,
    });
  });

  app.post('/marketplaces/:name/refresh', async (c) => {
    const parsed = safeParseSchema(MarketplaceActionSchema, await c.req.json());
    if (!parsed.success) {
      throw new BadRequestError('Invalid marketplace refresh request');
    }
    const result = await refreshPluginMarketplace(
      requireProjectPath(parsed.data.projectPath),
      c.req.param('name')
    );
    requireSuccess(result, 'Marketplace refresh failed');
    return c.json({
      name: result.marketplace?.name,
      plugins: result.manifest?.plugins.length ?? 0,
      revision: result.marketplace?.revision,
      changed: result.changed,
    });
  });

  app.post('/marketplaces/:name/remove', async (c) => {
    const parsed = safeParseSchema(MarketplaceActionSchema, await c.req.json());
    if (!parsed.success || parsed.data.confirm !== true) {
      throw new BadRequestError(
        'Invalid marketplace removal request; explicit confirmation is required'
      );
    }
    requireProjectPath(parsed.data.projectPath);
    const result = await removePluginMarketplace(c.req.param('name'), true);
    requireSuccess(result, 'Marketplace removal failed');
    return c.json({ name: result.marketplace?.name, removed: true });
  });

  app.post('/:name/update', async (c) => {
    const parsed = safeParseSchema(PluginUpdateSchema, await c.req.json());
    if (!parsed.success) {
      throw new BadRequestError(
        'Invalid plugin update request; explicit source trust is required'
      );
    }
    const projectPath = requireProjectPath(parsed.data.projectPath);
    const { result } = await updateWorkspacePlugin(projectPath, c.req.param('name'), {
      trusted: parsed.data.trust,
    });
    requireSuccess(result, 'Plugin update failed');
    return c.json({
      name: result.pluginName,
      version: result.manifest?.version,
      revision: result.installation?.revision,
      changed: result.changed,
      updatedDependencies: result.updatedDependencies ?? [],
    });
  });

  app.post('/:name/uninstall', async (c) => {
    const parsed = safeParseSchema(PluginUninstallSchema, await c.req.json());
    if (!parsed.success) {
      throw new BadRequestError(
        'Invalid plugin uninstall request; explicit confirmation is required'
      );
    }
    const projectPath = requireProjectPath(parsed.data.projectPath);
    const { result } = await uninstallWorkspacePlugin(
      projectPath,
      c.req.param('name'),
      parsed.data.confirm
    );
    requireSuccess(result, 'Plugin uninstall failed');
    return c.json({ name: result.pluginName, removed: true });
  });

  app.post('/:name/state', async (c) => {
    const parsed = safeParseSchema(PluginStateSchema, await c.req.json());
    if (!parsed.success) throw new BadRequestError('Invalid plugin state request');
    const projectPath = requireProjectPath(parsed.data.projectPath);
    const name = c.req.param('name');
    const resources = await resolveWorkspaceAgentResources(projectPath);
    const plugin = resources.plugins.get(name);
    if (!plugin) throw new NotFoundError('Plugin', name);
    if (plugin.source === 'cli') {
      throw new BadRequestError(
        `Plugin "${name}" was loaded with --plugin-dir and is invocation-scoped`
      );
    }
    const change = await setWorkspacePluginEnabled(
      projectPath,
      name,
      parsed.data.enabled,
      parsed.data.scope ?? 'local'
    );
    return c.json(change);
  });

  return app;
};
