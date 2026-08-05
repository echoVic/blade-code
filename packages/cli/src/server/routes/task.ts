import { Hono } from 'hono';
import {
  CreateTaskRequestSchema,
  CreateTaskResponseSchema,
  SessionTaskDiffArtifactSchema,
} from '../../api/schemas.js';
import { PermissionMode } from '../../config/types.js';
import { createLogger, LogCategory } from '../../logging/Logger.js';
import { safeParseSchema } from '../../schema/index.js';
import { getCwd } from '../../utils/cwd.js';
import {
  BadRequestError,
  BladeServerError,
  ConflictError,
  InternalServerError,
  NotFoundError,
} from '../error.js';
import type { SessionRouteController } from './session.js';

const logger = createLogger(LogCategory.SERVICE);

type Variables = {
  directory: string;
};

export const TaskRoutes = (controller: SessionRouteController) => {
  const app = new Hono<{ Variables: Variables }>();

  app.onError((error, c) => {
    if (error instanceof BladeServerError) {
      return c.json(error.toObject(), error.statusCode as 400 | 404 | 409 | 500);
    }
    logger.error('[TaskRoutes] Unhandled route error:', error);
    return c.json(new InternalServerError('Failed to dispatch task').toObject(), 500);
  });

  app.post('/', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new BadRequestError('Invalid request body');
    }
    const parsed = safeParseSchema(CreateTaskRequestSchema, body);
    if (!parsed.success) {
      throw new BadRequestError('Invalid task request');
    }

    try {
      const result = await controller.dispatchTask({
        prompt: parsed.data.prompt,
        title: parsed.data.title,
        sourceProjectPath: parsed.data.projectPath || c.get('directory') || getCwd(),
        isolation: parsed.data.isolation,
        permissionMode: parsed.data.permissionMode as PermissionMode,
        attachments: parsed.data.attachments,
      });
      return c.json(CreateTaskResponseSchema.parse(result), 202);
    } catch (error) {
      if (error instanceof BadRequestError || error instanceof ConflictError) {
        throw error;
      }
      logger.error('[TaskRoutes] Failed to dispatch task:', error);
      throw new InternalServerError('Failed to dispatch task');
    }
  });

  app.get('/:sessionId/diff', async (c) => {
    try {
      const artifact = await controller.getTaskDiff(
        c.req.param('sessionId'),
        c.req.query('projectPath')
      );
      return c.json(SessionTaskDiffArtifactSchema.parse(artifact));
    } catch (error) {
      if (
        error instanceof BadRequestError ||
        error instanceof NotFoundError ||
        error instanceof ConflictError
      ) {
        throw error;
      }
      logger.error('[TaskRoutes] Failed to load task diff:', error);
      throw new InternalServerError('Failed to load task diff');
    }
  });

  return app;
};
