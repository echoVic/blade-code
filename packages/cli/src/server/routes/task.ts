import { Hono } from 'hono';
import { MAX_INLINE_ATTACHMENT_BYTES } from '../../api/attachmentLimits.js';
import {
  CreateTaskRequestSchema,
  CreateTaskResponseSchema,
  SessionSchema,
  SessionTaskDeliveryRequestSchema,
  SessionTaskDiffArtifactSchema,
} from '../../api/schemas.js';
import {
  type CommunicationStyleSelection,
  PermissionMode,
} from '../../config/types.js';
import { createLogger, LogCategory } from '../../logging/Logger.js';
import { safeParseSchema } from '../../schema/index.js';
import type { JsonObject } from '../../store/types.js';
import { getCwd } from '../../utils/cwd.js';
import {
  BadRequestError,
  BladeServerError,
  ConflictError,
  InternalServerError,
  NotFoundError,
  TooManyRequestsError,
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
      return c.json(error.toObject(), error.statusCode as 400 | 404 | 409 | 429 | 500);
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
    const attachmentBytes = (parsed.data.attachments ?? []).reduce(
      (total, attachment) =>
        total +
        (typeof attachment.content === 'string'
          ? Buffer.byteLength(attachment.content)
          : 0),
      0
    );
    if (attachmentBytes > MAX_INLINE_ATTACHMENT_BYTES) {
      throw new BadRequestError('Task attachments exceed the 5 MiB limit');
    }

    try {
      const result = await controller.dispatchTask({
        prompt: parsed.data.prompt,
        title: parsed.data.title,
        sourceProjectPath: parsed.data.projectPath || c.get('directory') || getCwd(),
        isolation: parsed.data.isolation,
        permissionMode: parsed.data.permissionMode as PermissionMode,
        modelId: parsed.data.modelId,
        reasoningEffort: parsed.data.reasoningEffort,
        serviceTier: parsed.data.serviceTier,
        responseVerbosity: parsed.data.responseVerbosity,
        communicationStyle: parsed.data.communicationStyle as
          | CommunicationStyleSelection
          | undefined,
        attachments: parsed.data.attachments,
        outputSchema: parsed.data.outputSchema as JsonObject | undefined,
      });
      return c.json(CreateTaskResponseSchema.parse(result), 202);
    } catch (error) {
      if (
        error instanceof BadRequestError ||
        error instanceof ConflictError ||
        error instanceof TooManyRequestsError
      ) {
        throw error;
      }
      logger.error('[TaskRoutes] Failed to dispatch task:', error);
      throw new InternalServerError('Failed to dispatch task');
    }
  });

  app.post('/:sessionId/retry', async (c) => {
    try {
      const result = await controller.retryTask(
        c.req.param('sessionId'),
        c.req.query('projectPath')
      );
      return c.json(CreateTaskResponseSchema.parse(result), 202);
    } catch (error) {
      if (
        error instanceof BadRequestError ||
        error instanceof NotFoundError ||
        error instanceof ConflictError ||
        error instanceof TooManyRequestsError
      ) {
        throw error;
      }
      logger.error('[TaskRoutes] Failed to retry task:', error);
      throw new InternalServerError('Failed to retry task');
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

  app.post('/:sessionId/delivery', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new BadRequestError('Invalid request body');
    }
    const parsed = safeParseSchema(SessionTaskDeliveryRequestSchema, body);
    if (!parsed.success) {
      throw new BadRequestError('Invalid task delivery request');
    }
    try {
      const session = await controller.deliverTask(
        c.req.param('sessionId'),
        parsed.data.action,
        c.req.query('projectPath')
      );
      return c.json(SessionSchema.parse(session));
    } catch (error) {
      if (
        error instanceof BadRequestError ||
        error instanceof NotFoundError ||
        error instanceof ConflictError
      ) {
        throw error;
      }
      logger.error('[TaskRoutes] Failed to deliver task:', error);
      throw new InternalServerError('Failed to deliver task');
    }
  });

  return app;
};
