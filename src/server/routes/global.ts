import { Hono } from 'hono';
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
    return c.json({
      version: getVersion(),
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      cwd: process.cwd(),
    });
  });

  return app;
};
