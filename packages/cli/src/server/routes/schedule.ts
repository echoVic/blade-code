import { Hono } from 'hono';
import type { TaskScheduler } from '../../agent/runtime/TaskScheduler.js';
import {
  CreateScheduleRequestSchema,
  ScheduleListResponseSchema,
  ScheduleSchema,
  UpdateScheduleRequestSchema,
} from '../../api/schemas.js';
import { createLogger, LogCategory } from '../../logging/Logger.js';
import { safeParseSchema } from '../../schema/index.js';
import type { ScheduleStore } from '../../services/ScheduleStore.js';
import { getCwd } from '../../utils/cwd.js';
import {
  BadRequestError,
  BladeServerError,
  InternalServerError,
  NotFoundError,
} from '../error.js';
import { normalizeLocalWorkspacePath } from '../sessionRef.js';

const logger = createLogger(LogCategory.SERVICE);

type Variables = {
  directory: string;
};

/**
 * HTTP CRUD for scheduled tasks. The scheduler (owned by `blade serve`) and
 * this router share the same `ScheduleStore`, so schedules created here are
 * picked up on the next tick. The `/run` endpoint fires immediately.
 */
export const ScheduleRoutes = (store: ScheduleStore, scheduler?: TaskScheduler) => {
  const app = new Hono<{ Variables: Variables }>();

  app.onError((error, c) => {
    if (error instanceof BladeServerError) {
      return c.json(error.toObject(), error.statusCode as 400 | 404 | 409 | 429 | 500);
    }
    logger.error('[ScheduleRoutes] Unhandled route error:', error);
    return c.json(new InternalServerError('Schedule request failed').toObject(), 500);
  });

  app.get('/', async (c) => {
    const schedules = await store.list();
    return c.json(ScheduleListResponseSchema.parse({ schedules }));
  });

  app.post('/', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new BadRequestError('Invalid request body');
    }
    const parsed = safeParseSchema(CreateScheduleRequestSchema, body);
    if (!parsed.success) {
      throw new BadRequestError('Invalid schedule request');
    }
    let projectPath: string;
    try {
      projectPath = normalizeLocalWorkspacePath(
        parsed.data.projectPath || c.get('directory') || getCwd()
      );
    } catch {
      throw new BadRequestError('projectPath must reference a local workspace');
    }
    try {
      const schedule = await store.create({ ...parsed.data, projectPath });
      return c.json(ScheduleSchema.parse(schedule), 201);
    } catch (error) {
      throw new BadRequestError(
        error instanceof Error ? error.message : 'Failed to create schedule'
      );
    }
  });

  app.get('/:id', async (c) => {
    const schedule = await store.get(c.req.param('id'));
    if (!schedule) throw new NotFoundError('Schedule not found');
    return c.json(ScheduleSchema.parse(schedule));
  });

  app.patch('/:id', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new BadRequestError('Invalid request body');
    }
    const parsed = safeParseSchema(UpdateScheduleRequestSchema, body);
    if (!parsed.success) {
      throw new BadRequestError('Invalid schedule update');
    }
    const {
      modelId,
      reasoningEffort,
      serviceTier,
      responseVerbosity,
      communicationStyle,
      isolation,
      permissionMode,
      ...rest
    } = parsed.data;
    const dispatchPatch = {
      ...(modelId !== undefined ? { modelId } : {}),
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
      ...(serviceTier !== undefined ? { serviceTier } : {}),
      ...(responseVerbosity !== undefined ? { responseVerbosity } : {}),
      ...(communicationStyle !== undefined ? { communicationStyle } : {}),
      ...(isolation !== undefined ? { isolation } : {}),
      ...(permissionMode !== undefined ? { permissionMode } : {}),
    };
    try {
      const updated = await store.update(c.req.param('id'), {
        ...rest,
        ...(Object.keys(dispatchPatch).length > 0 ? { dispatch: dispatchPatch } : {}),
      });
      if (!updated) throw new NotFoundError('Schedule not found');
      return c.json(ScheduleSchema.parse(updated));
    } catch (error) {
      if (error instanceof BladeServerError) throw error;
      throw new BadRequestError(
        error instanceof Error ? error.message : 'Failed to update schedule'
      );
    }
  });

  app.delete('/:id', async (c) => {
    const removed = await store.remove(c.req.param('id'));
    if (!removed) throw new NotFoundError('Schedule not found');
    return c.json({ ok: true });
  });

  app.post('/:id/enable', async (c) => {
    const updated = await store.setEnabled(c.req.param('id'), true);
    if (!updated) throw new NotFoundError('Schedule not found');
    return c.json(ScheduleSchema.parse(updated));
  });

  app.post('/:id/disable', async (c) => {
    const updated = await store.setEnabled(c.req.param('id'), false);
    if (!updated) throw new NotFoundError('Schedule not found');
    return c.json(ScheduleSchema.parse(updated));
  });

  app.post('/:id/run', async (c) => {
    const schedule = await store.get(c.req.param('id'));
    if (!schedule) throw new NotFoundError('Schedule not found');
    if (!scheduler) {
      throw new InternalServerError('Scheduler is not running in this process');
    }
    await scheduler.fire(schedule, new Date(), { manual: true });
    const updated = await store.get(schedule.id);
    return c.json(ScheduleSchema.parse(updated ?? schedule), 202);
  });

  return app;
};
