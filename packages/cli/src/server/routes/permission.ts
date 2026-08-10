import { Hono } from 'hono';
import { PermissionMode } from '../../config/types.js';
import { createLogger, LogCategory } from '../../logging/Logger.js';
import { StringEnum, safeParseSchema, Type } from '../../schema/index.js';
import type { ConfirmationResponse } from '../../tools/types/ExecutionTypes.js';
import {
  AmbiguousSessionError,
  BadRequestError,
  BladeServerError,
  NotFoundError,
} from '../error.js';
import { resolveSessionRef, respondToPermission } from './session.js';

const logger = createLogger(LogCategory.SERVICE);

const PermissionResponseSchema = Type.Object({
  approved: Type.Boolean(),
  remember: Type.Optional(Type.Boolean()),
  scope: Type.Optional(StringEnum(['once', 'session', 'project'])),
  targetMode: Type.Optional(StringEnum(['default', 'autoEdit', 'plan', 'yolo'])),
  feedback: Type.Optional(Type.String()),
  answers: Type.Optional(
    Type.Record(Type.String(), Type.Union([Type.String(), Type.Array(Type.String())]))
  ),
  elicitation: Type.Optional(
    Type.Object({
      action: StringEnum(['accept', 'decline', 'cancel']),
      content: Type.Optional(
        Type.Record(
          Type.String(),
          Type.Union([
            Type.String({ maxLength: 4_000 }),
            Type.Number(),
            Type.Boolean(),
            Type.Array(Type.String({ maxLength: 1_000 }), { maxItems: 100 }),
          ]),
          { maxProperties: 32 }
        )
      ),
    })
  ),
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
      const parsed = safeParseSchema(PermissionResponseSchema, body);

      if (!parsed.success) {
        throw new BadRequestError('Invalid permission response format');
      }

      const { approved, remember, scope, targetMode, feedback, answers, elicitation } =
        parsed.data;

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
        elicitation,
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
