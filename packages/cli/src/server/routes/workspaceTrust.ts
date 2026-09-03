import { Hono } from 'hono';
import { StringEnum, safeParseSchema, Type } from '../../schema/index.js';
import { reloadWorkspaceTrustConfiguration } from '../../security/reloadWorkspaceTrust.js';
import { WorkspaceTrustService } from '../../security/WorkspaceTrustService.js';
import { BadRequestError } from '../error.js';
import { normalizeLocalWorkspacePath } from '../sessionRef.js';

const WorkspaceTrustActionSchema = Type.Object({
  projectPath: Type.String({ minLength: 1 }),
  action: StringEnum(['trust', 'revoke']),
});

function requireLocalProjectPath(projectPath: string): string {
  try {
    return normalizeLocalWorkspacePath(projectPath);
  } catch {
    throw new BadRequestError('projectPath must reference a local workspace');
  }
}

export const WorkspaceTrustRoutes = () => {
  const app = new Hono();

  app.get('/', async (c) => {
    const projectPath = c.req.query('projectPath');
    if (!projectPath) {
      throw new BadRequestError('projectPath query parameter is required');
    }
    const localProjectPath = requireLocalProjectPath(projectPath);
    return c.json(
      await WorkspaceTrustService.getInstance().getStatus(localProjectPath)
    );
  });

  app.post('/', async (c) => {
    const parsed = safeParseSchema(WorkspaceTrustActionSchema, await c.req.json());
    if (!parsed.success) {
      throw new BadRequestError('Invalid workspace trust request');
    }
    const { action } = parsed.data;
    const projectPath = requireLocalProjectPath(parsed.data.projectPath);
    const service = WorkspaceTrustService.getInstance();
    const status =
      action === 'trust'
        ? await service.trust(projectPath)
        : await service.revoke(projectPath);
    await reloadWorkspaceTrustConfiguration();
    return c.json({
      ...status,
      reloadRequired: status.sensitiveSources > 0,
    });
  });

  return app;
};
