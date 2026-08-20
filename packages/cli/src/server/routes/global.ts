import { Hono } from 'hono';
import { taskRunScheduler } from '../../agent/runtime/TaskRunScheduler.js';
import { detectGitBranch } from '../../context/storage/pathUtils.js';
import { safeParseSchema, Type } from '../../schema/index.js';
import { getConfig } from '../../store/vanilla.js';
import { getCwd } from '../../utils/cwd.js';
import { getVersion } from '../../utils/packageInfo.js';
import { BadRequestError } from '../error.js';

type Variables = {
  directory: string;
};

const TaskAdmissionControlSchema = Type.Object({
  paused: Type.Boolean(),
});

export const GlobalRoutes = (): Hono<{ Variables: Variables }> => {
  const app = new Hono<{ Variables: Variables }>();

  app.get('/health', (c) => {
    return c.json({
      healthy: true,
      version: getVersion(),
    });
  });

  app.get('/info', (c) => {
    const cwd = getCwd();
    const config = getConfig();
    if (config) {
      taskRunScheduler.configure(
        config.maxConcurrentTasks,
        config.maxQueuedTasks,
        config.maxQueuedTaskBytes
      );
    }
    const taskAdmission = taskRunScheduler.getStats();
    return c.json({
      version: getVersion(),
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      cwd,
      gitBranch: detectGitBranch(cwd),
      taskAdmission: {
        inFlight: taskAdmission.inFlight,
        queued: taskAdmission.queued,
        maxConcurrent: taskAdmission.maxConcurrent,
        maxQueued: taskAdmission.maxQueued,
        paused: taskAdmission.paused,
      },
    });
  });

  app.put('/task-admission', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new BadRequestError('Invalid request body');
    }
    const parsed = safeParseSchema(TaskAdmissionControlSchema, body);
    if (!parsed.success) {
      throw new BadRequestError('Invalid task admission control request');
    }
    taskRunScheduler.setPaused(parsed.data.paused);
    const taskAdmission = taskRunScheduler.getStats();
    return c.json({
      inFlight: taskAdmission.inFlight,
      queued: taskAdmission.queued,
      maxConcurrent: taskAdmission.maxConcurrent,
      maxQueued: taskAdmission.maxQueued,
      paused: taskAdmission.paused,
    });
  });

  return app;
};
