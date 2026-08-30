import { Hono } from 'hono';
import type { BladeConfig } from '../../config/types.js';
import { createLogger, LogCategory } from '../../logging/Logger.js';
import { StringEnum, safeParseSchema, Type } from '../../schema/index.js';
import { configActions, getConfig } from '../../store/vanilla.js';
import { BadRequestError } from '../error.js';

const logger = createLogger(LogCategory.SERVICE);

const UpdateConfigSchema = Type.Object({
  updates: Type.Record(Type.String(), Type.Any()),
  options: Type.Optional(
    Type.Object({
      scope: Type.Optional(StringEnum(['local', 'project', 'global'])),
      immediate: Type.Optional(Type.Boolean()),
    })
  ),
});

export function projectPublicConfig(config: BladeConfig) {
  return {
    currentModelId: config.currentModelId,
    permissionMode: config.permissionMode,
    language: config.language,
    codeTheme: config.codeTheme,
    uiTheme: config.uiTheme,
    autoSaveSessions: config.autoSaveSessions,
    notifyBuild: config.notifyBuild,
    notifyErrors: config.notifyErrors,
    notifySounds: config.notifySounds,
    privacyTelemetry: config.privacyTelemetry,
    privacyCrash: config.privacyCrash,
    agentTeamsEnabled: config.agentTeamsEnabled === true,
    communicationStyle: config.communicationStyle,
    maxConcurrentTasks: config.maxConcurrentTasks,
    maxQueuedTasks: config.maxQueuedTasks,
    maxQueuedTaskBytes: config.maxQueuedTaskBytes,
    maxResidentSessionRuntimes: config.maxResidentSessionRuntimes,
    sessionRuntimeIdleMs: config.sessionRuntimeIdleMs,
    maxResidentSessionProjections: config.maxResidentSessionProjections,
    sessionProjectionIdleMs: config.sessionProjectionIdleMs,
  };
}

export const ConfigRoutes = () => {
  const app = new Hono();

  app.get('/', async (c) => {
    try {
      const config = getConfig();
      return c.json(config ? projectPublicConfig(config) : {});
    } catch (error) {
      logger.error('[ConfigRoutes] Failed to get config:', error);
      return c.json({});
    }
  });

  app.put('/', async (c) => {
    try {
      const body = await c.req.json();
      const parsed = safeParseSchema(UpdateConfigSchema, body);

      if (!parsed.success) {
        throw new BadRequestError('Invalid config update format');
      }

      const { updates, options } = parsed.data;
      await configActions().updateConfig(updates, options);

      return c.json({ success: true, updates });
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes('only supports scopes: global')
      ) {
        throw new BadRequestError(error.message);
      }
      logger.error('[ConfigRoutes] Failed to update config:', error);
      throw error;
    }
  });

  app.get('/permissions', async (c) => {
    try {
      const config = getConfig();
      return c.json(config?.permissions || {});
    } catch (error) {
      logger.error('[ConfigRoutes] Failed to get permissions:', error);
      return c.json({});
    }
  });

  return app;
};
