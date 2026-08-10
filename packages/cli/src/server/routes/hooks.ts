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
import { assertValidSessionId } from '../../context/storage/pathUtils.js';
import { StringEnum, safeParseSchema, Type } from '../../schema/index.js';
import { getConfig } from '../../store/vanilla.js';
import { BadRequestError, ConflictError } from '../error.js';

const HookTrustActionSchema = Type.Object({
  projectPath: Type.String({ minLength: 1 }),
  action: StringEnum(['trust', 'revoke']),
  expectedDigest: Type.Optional(Type.String()),
});

const HookSessionActionSchema = Type.Object({
  projectPath: Type.String({ minLength: 1 }),
  sessionId: Type.String({ minLength: 1 }),
  enabled: Type.Boolean(),
});

function requireProjectPath(projectPath: string | undefined): string {
  if (!projectPath || !path.isAbsolute(projectPath)) {
    throw new BadRequestError('projectPath must be absolute');
  }
  return path.resolve(projectPath);
}

function requireSessionId(sessionId: string | undefined): string {
  if (!sessionId) {
    throw new BadRequestError('sessionId is required');
  }
  try {
    assertValidSessionId(sessionId);
  } catch (error) {
    throw new BadRequestError(
      error instanceof Error ? error.message : 'sessionId is invalid'
    );
  }
  return sessionId;
}

async function loadProjectHookConfig(projectPath: string) {
  const root = requireProjectPath(projectPath);
  const base = getConfig()?.hooks ?? DEFAULT_CONFIG.hooks;
  const hooks = await ConfigManager.getInstance().loadWorkspaceHooks(root, base, {
    includeBaseForCurrentWorkspace: false,
  });
  await resolveWorkspaceAgentResources(root);
  clearAllPluginResources(root);
  const manager = HookManager.getInstance();
  manager.loadConfig(hooks, root);
  await integrateAllPlugins(root);
  return manager.getConfig(root);
}

function sessionStatus(sessionId: string, projectPath: string) {
  const manager = HookManager.getInstance();
  const configEnabled = manager.getConfig(projectPath).enabled;
  const paused = manager.isSessionPaused(sessionId, projectPath);
  return {
    sessionId,
    projectPath,
    enabled: manager.isSessionEnabled(sessionId, projectPath),
    paused,
    configEnabled,
  };
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

  app.get('/session', async (c) => {
    const projectPath = requireProjectPath(c.req.query('projectPath'));
    const sessionId = requireSessionId(c.req.query('sessionId'));
    await loadProjectHookConfig(projectPath);
    return c.json(sessionStatus(sessionId, projectPath));
  });

  app.post('/session', async (c) => {
    const parsed = safeParseSchema(HookSessionActionSchema, await c.req.json());
    if (!parsed.success) {
      throw new BadRequestError('Invalid hook session request');
    }
    const projectPath = requireProjectPath(parsed.data.projectPath);
    const sessionId = requireSessionId(parsed.data.sessionId);
    await loadProjectHookConfig(projectPath);
    const manager = HookManager.getInstance();
    if (parsed.data.enabled) {
      manager.enableSession(sessionId, projectPath);
    } else {
      manager.disableSession(sessionId, projectPath);
    }
    return c.json(sessionStatus(sessionId, projectPath));
  });

  return app;
};
