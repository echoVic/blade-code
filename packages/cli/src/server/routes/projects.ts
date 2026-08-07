import type { ProjectDirectorySelection } from '../../api/schemas.js';
import { Hono } from 'hono';
import { safeParseSchema, Type } from '../../schema/index.js';
import { nativeDirectoryPicker } from '../../services/DirectoryPicker.js';
import { projectRegistry } from '../../services/ProjectRegistry.js';
import { getCwd } from '../../utils/cwd.js';
import { BadRequestError, BladeServerError } from '../error.js';

const BindProjectSchema = Type.Object({
  path: Type.String({ minLength: 1 }),
});

interface ProjectRoutesOptions {
  pickDirectory?: () => Promise<ProjectDirectorySelection>;
  allowDirectoryPickerRequest?: (origin: string | undefined) => boolean;
}

export function isLocalDirectoryPickerOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  if (origin === 'tauri://localhost' || origin === 'http://tauri.localhost') {
    return true;
  }
  try {
    const hostname = new URL(origin).hostname;
    return (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '::1' ||
      hostname === '[::1]'
    );
  } catch {
    return false;
  }
}

export const ProjectRoutes = (options: ProjectRoutesOptions = {}) => {
  const app = new Hono();
  const pickDirectory = options.pickDirectory ?? (() => nativeDirectoryPicker.pick());
  const allowDirectoryPickerRequest =
    options.allowDirectoryPickerRequest ?? isLocalDirectoryPickerOrigin;

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

  app.post('/pick', async (c) => {
    if (!allowDirectoryPickerRequest(c.req.header('Origin'))) {
      throw new BladeServerError(
        'LOCAL_ACCESS_REQUIRED',
        'Folder selection is only available from this machine',
        403
      );
    }
    try {
      return c.json(await pickDirectory());
    } catch (error) {
      throw new BadRequestError(
        error instanceof Error ? error.message : 'Failed to select a folder'
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
