import { Hono } from 'hono';
import { safeParseSchema, Type } from '../../schema/index.js';
import { projectRegistry } from '../../services/ProjectRegistry.js';
import { getCwd } from '../../utils/cwd.js';
import { BadRequestError } from '../error.js';

const BindProjectSchema = Type.Object({
  path: Type.String({ minLength: 1 }),
});

export const ProjectRoutes = () => {
  const app = new Hono();

  app.get('/', async (c) => {
    return c.json(await projectRegistry.list(getCwd()));
  });

  app.post('/', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new BadRequestError('A valid JSON body is required');
    }
    const parsed = safeParseSchema(BindProjectSchema, body);
    if (!parsed.success) {
      throw new BadRequestError('A project path is required');
    }
    try {
      const project = await projectRegistry.bind(parsed.data.path, getCwd());
      return c.json(project, 201);
    } catch (error) {
      throw new BadRequestError(
        error instanceof Error ? error.message : 'Failed to bind project'
      );
    }
  });

  app.delete('/', async (c) => {
    const projectPath = c.req.query('path');
    if (!projectPath) {
      throw new BadRequestError('A project path is required');
    }
    try {
      const removed = await projectRegistry.unbind(projectPath);
      return c.json({ success: true, removed });
    } catch (error) {
      throw new BadRequestError(
        error instanceof Error ? error.message : 'Failed to unbind project'
      );
    }
  });

  return app;
};
