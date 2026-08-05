import { Hono } from 'hono';
import { detectGitBranch } from '../../context/storage/pathUtils.js';
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
    return c.json({
      version: getVersion(),
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      cwd,
      gitBranch: detectGitBranch(cwd),
    });
  });

  return app;
};
