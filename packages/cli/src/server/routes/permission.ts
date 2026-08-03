import { Hono } from 'hono';
import { z } from 'zod';
import { PermissionMode } from '../../config/types.js';
import { createLogger, LogCategory } from '../../logging/Logger.js';
import type { ConfirmationResponse } from '../../tools/types/ExecutionTypes.js';
import {
  AmbiguousSessionError,
  BadRequestError,
  BladeServerError,
  NotFoundError,
} from '../error.js';
import { resolveSessionRef, respondToPermission } from './session.js';

const logger = createLogger(LogCategory.SERVICE);

const PermissionResponseSchema = z.object({
  approved: z.boolean(),
  remember: z.boolean().optional(),
  scope: z.enum(['once', 'session']).optional(),
  targetMode: z.enum(['default', 'autoEdit', 'plan', 'yolo']).optional(),
  feedback: z.string().optional(),
  answers: z.record(z.union([z.string(), z.array(z.string())])).optional(),
});

export const PermissionRoutes = () => {
  const app = new Hono();

  app.post('/:permissionId', async (c) => {
    const permissionId = c.req.param('permissionId');
    const sessionId = c.req.query('sessionId');
    const requestedProjectPath = c.req.query('projectPath');

    logger.info(
      `[PermissionRoutes] Received permission response: permissionId=${permissionId}, sessionId=${sessionId}`
    );

    try {
      const body = await c.req.json();
      const parsed = PermissionResponseSchema.safeParse(body);

      if (!parsed.success) {
        throw new BadRequestError('Invalid permission response format');
      }

      const { approved, remember, scope, targetMode, feedback, answers } = parsed.data;

      if (!sessionId) {
        throw new BadRequestError('sessionId query parameter is required');
      }
      const ref = await resolveSessionRef(sessionId, requestedProjectPath);

      const response: ConfirmationResponse = {
        approved,
        reason: feedback,
        scope,
        targetMode: targetMode as PermissionMode | undefined,
        feedback,
        answers,
      };

      const success = respondToPermission(ref, permissionId, response);

      if (!success) {
        throw new NotFoundError('Permission request', permissionId);
      }

      logger.info(
        `[PermissionRoutes] Permission ${permissionId} ${approved ? 'approved' : 'denied'}`
      );

      return c.json({ success: true, approved, remember });
    } catch (error) {
      logger.error('[PermissionRoutes] Failed to respond to permission:', error);
      if (
        error instanceof BadRequestError ||
        error instanceof AmbiguousSessionError ||
        error instanceof NotFoundError ||
        error instanceof BladeServerError
      ) {
        throw error;
      }
      throw error;
    }
  });

  return app;
};
