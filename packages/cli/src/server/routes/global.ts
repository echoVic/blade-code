import { Hono } from 'hono';
import { taskRunScheduler } from '../../agent/runtime/TaskRunScheduler.js';
import { detectGitBranch } from '../../context/storage/pathUtils.js';
import { getConfig } from '../../store/vanilla.js';
import { getCwd } from '../../utils/cwd.js';
import { getVersion } from '../../utils/packageInfo.js';

type Variables = {
  directory: string;
};

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
      },
    });
  });

  return app;
};
