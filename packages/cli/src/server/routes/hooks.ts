import path from 'node:path';
import { Hono } from 'hono';
import { resolveWorkspaceAgentResources } from '../../agent/resources/WorkspaceAgentResources.js';
import { ConfigManager } from '../../config/ConfigManager.js';
import { DEFAULT_CONFIG } from '../../config/defaults.js';
import { HookManager } from '../../hooks/HookManager.js';
import { HookTrustDigestMismatchError } from '../../hooks/HookTrustService.js';
import {
  clearAllPluginResources,
  integrateAllPlugins,
} from '../../plugins/PluginIntegrator.js';
import { StringEnum, safeParseSchema, Type } from '../../schema/index.js';
import { getConfig } from '../../store/vanilla.js';
import { BadRequestError, ConflictError } from '../error.js';

const HookTrustActionSchema = Type.Object({
  projectPath: Type.String({ minLength: 1 }),
  action: StringEnum(['trust', 'revoke']),
  expectedDigest: Type.Optional(Type.String()),
});

async function loadProjectHookConfig(projectPath: string) {
  if (!path.isAbsolute(projectPath)) {
    throw new BadRequestError('projectPath must be absolute');
  }
  const base = getConfig()?.hooks ?? DEFAULT_CONFIG.hooks;
  const hooks = await ConfigManager.getInstance().loadWorkspaceHooks(
    projectPath,
    base,
    { includeBaseForCurrentWorkspace: false }
  );
  await resolveWorkspaceAgentResources(projectPath);
  clearAllPluginResources(projectPath);
  const manager = HookManager.getInstance();
  manager.loadConfig(hooks, projectPath);
  await integrateAllPlugins(projectPath);
  return manager.getConfig(projectPath);
}

export const HookRoutes = () => {
  const app = new Hono();

  app.get('/trust', async (c) => {
    const projectPath = c.req.query('projectPath');
    if (!projectPath) {
      throw new BadRequestError('projectPath query parameter is required');
    }
    await loadProjectHookConfig(projectPath);
    return c.json(await HookManager.getInstance().getTrustStatus(projectPath));
  });

  app.post('/trust', async (c) => {
    const parsed = safeParseSchema(HookTrustActionSchema, await c.req.json());
    if (!parsed.success) {
      throw new BadRequestError('Invalid hook trust request');
    }
    const { projectPath, action, expectedDigest } = parsed.data;
    await loadProjectHookConfig(projectPath);
    const manager = HookManager.getInstance();
    let status;
    try {
      status =
        action === 'trust'
          ? await manager.trustProject(projectPath, expectedDigest)
          : await manager.revokeProjectTrust(projectPath);
    } catch (error) {
      if (error instanceof HookTrustDigestMismatchError) {
        throw new ConflictError(error.message);
      }
      throw error;
    }
    return c.json(status);
  });

  return app;
};
