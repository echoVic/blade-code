import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { Bus } from '../../bus/index.js';
import { PermissionMode } from '../../config/types.js';
import { createLogger, LogCategory } from '../../logging/Logger.js';
import type { ConfirmationDetails, ConfirmationResponse } from '../../tools/types/ExecutionTypes.js';
import { BadRequestError, NotFoundError } from '../error.js';

const logger = createLogger(LogCategory.SERVICE);

interface PendingPermission {
  id: string;
  sessionId: string;
  toolName?: string;
  description?: string;
  args?: Record<string, unknown>;
  details: ConfirmationDetails;
  createdAt: Date;
  resolve: (response: ConfirmationResponse) => void;
}

const pendingPermissions = new Map<string, PendingPermission>();

const PermissionResponseSchema = z.object({
  approved: z.boolean(),
  remember: z.boolean().optional(),
  scope: z.enum(['once', 'session']).optional(),
  targetMode: z.enum(['default', 'autoEdit', 'plan', 'spec', 'yolo']).optional(),
  feedback: z.string().optional(),
  answers: z.record(z.union([z.string(), z.array(z.string())])).optional(),
});

const CreatePermissionSchema = z.object({
  sessionId: z.string(),
  toolName: z.string().optional(),
  description: z.string().optional(),
  args: z.record(z.any()).optional(),
  details: z.record(z.any()).optional(),
});

export const PermissionRoutes = () => {
  const app = new Hono();

  app.get('/', async (c) => {
    const permissions = Array.from(pendingPermissions.values()).map((p) => ({
      id: p.id,
      sessionId: p.sessionId,
      toolName: p.toolName,
      description: p.description,
      args: p.args,
      details: p.details,
      createdAt: p.createdAt.toISOString(),
    }));

    return c.json(permissions);
  });

  app.post('/', async (c) => {
    try {
      const body = await c.req.json();
      const parsed = CreatePermissionSchema.safeParse(body);

      if (!parsed.success) {
        throw new BadRequestError('Invalid permission request format. Expected { sessionId, toolName, description, args? }');
      }

      const { sessionId, toolName, description, args, details } = parsed.data;
      const confirmationDetails: ConfirmationDetails = (details as ConfirmationDetails) || {
        type: 'permission',
        title: toolName ? `Permission: ${toolName}` : 'Permission required',
        message: description || 'This action requires confirmation',
        details: description,
        toolName,
        args,
      };
      const id = nanoid(12);

      const permission: PendingPermission = {
        id,
        sessionId,
        toolName,
        description,
        args,
        details: confirmationDetails,
        createdAt: new Date(),
        resolve: () => {
          // Will be called when permission is responded to
        },
      };

      pendingPermissions.set(id, permission);

      await Bus.publish('permission.asked', {
        requestId: id,
        sessionId,
        toolName,
        description,
        args,
        details: confirmationDetails,
      });

      logger.info(`[PermissionRoutes] Permission request created: ${id} for ${toolName}`);

      return c.json({
        id,
        sessionId,
        toolName,
        description,
        args,
        details: confirmationDetails,
        createdAt: permission.createdAt.toISOString(),
      }, 201);
    } catch (error) {
      logger.error('[PermissionRoutes] Failed to create permission request:', error);
      throw error;
    }
  });

  app.get('/:permissionId', async (c) => {
    const permissionId = c.req.param('permissionId');
    const permission = pendingPermissions.get(permissionId);

    if (!permission) {
      throw new NotFoundError('Permission request', permissionId);
    }

    return c.json({
      id: permission.id,
      sessionId: permission.sessionId,
      toolName: permission.toolName,
      description: permission.description,
      args: permission.args,
      details: permission.details,
      createdAt: permission.createdAt.toISOString(),
    });
  });

  app.post('/:permissionId', async (c) => {
    const permissionId = c.req.param('permissionId');
    const permission = pendingPermissions.get(permissionId);

    if (!permission) {
      throw new NotFoundError('Permission request', permissionId);
    }

    try {
      const body = await c.req.json();
      const parsed = PermissionResponseSchema.safeParse(body);

      if (!parsed.success) {
        throw new BadRequestError('Invalid permission response format');
      }

      const { approved, remember, scope, targetMode, feedback, answers } = parsed.data;
      const response: ConfirmationResponse = {
        approved,
        reason: feedback,
        scope,
        targetMode: targetMode as PermissionMode | undefined,
        feedback,
        answers,
      };

      permission.resolve(response);
      pendingPermissions.delete(permissionId);

      await Bus.publish('permission.replied', {
        requestId: permissionId,
        sessionId: permission.sessionId,
        approved,
        remember,
        scope,
        targetMode,
        feedback,
        answers,
      });

      logger.info(`[PermissionRoutes] Permission ${permissionId} ${approved ? 'approved' : 'denied'}`);

      return c.json({ success: true, approved, remember });
    } catch (error) {
      logger.error('[PermissionRoutes] Failed to respond to permission:', error);
      throw error;
    }
  });

  app.delete('/:permissionId', async (c) => {
    const permissionId = c.req.param('permissionId');
    const permission = pendingPermissions.get(permissionId);

    if (!permission) {
      throw new NotFoundError('Permission request', permissionId);
    }

    permission.resolve({ approved: false });
    pendingPermissions.delete(permissionId);

    await Bus.publish('permission.replied', {
      requestId: permissionId,
      sessionId: permission.sessionId,
      approved: false,
    });

    logger.info(`[PermissionRoutes] Permission ${permissionId} cancelled`);

    return c.json({ success: true });
  });

  return app;
};

export async function requestConfirmation(
  sessionId: string,
  details: ConfirmationDetails
): Promise<ConfirmationResponse> {
  const id = nanoid(12);

  const resultPromise = new Promise<ConfirmationResponse>((resolve) => {
    const permission: PendingPermission = {
      id,
      sessionId,
      toolName: details.toolName,
      description: details.message,
      args: details.args,
      details,
      createdAt: new Date(),
      resolve: (response) => {
        resolve(response);
      },
    };

    pendingPermissions.set(id, permission);
  });

  try {
    logger.info(`[PermissionRoutes] Publishing permission.asked event for request ${id}`);
    await Bus.publish('permission.asked', {
      requestId: id,
      sessionId,
      toolName: details.toolName,
      description: details.message,
      args: details.args,
      details,
    });
    logger.info(`[PermissionRoutes] permission.asked event published successfully`);
  } catch (err) {
    logger.error(`[PermissionRoutes] Failed to publish permission.asked event:`, err);
  }

  logger.info(`[PermissionRoutes] Confirmation request created: ${id}`);

  return resultPromise;
}

export async function requestPermission(
  sessionId: string,
  toolName: string,
  description: string,
  args?: Record<string, unknown>
): Promise<ConfirmationResponse> {
  return requestConfirmation(sessionId, {
    type: 'permission',
    title: `Permission: ${toolName}`,
    message: description || 'This action requires confirmation',
    toolName,
    args,
  });
}

export function cancelPendingPermissions(sessionId: string): void {
  for (const [id, permission] of pendingPermissions) {
    if (permission.sessionId === sessionId) {
      permission.resolve({ approved: false });
      pendingPermissions.delete(id);
      logger.info(`[PermissionRoutes] Permission ${id} cancelled (session ${sessionId} cleanup)`);
    }
  }
}
