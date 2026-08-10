import path from 'node:path';
import { Hono } from 'hono';
import { StringEnum, safeParseSchema, Type } from '../../schema/index.js';
import { reloadWorkspaceTrustConfiguration } from '../../security/reloadWorkspaceTrust.js';
import { WorkspaceTrustService } from '../../security/WorkspaceTrustService.js';
import { BadRequestError } from '../error.js';

const WorkspaceTrustActionSchema = Type.Object({
  projectPath: Type.String({ minLength: 1 }),
  action: StringEnum(['trust', 'revoke']),
});

function assertAbsoluteProjectPath(projectPath: string): void {
  if (!path.isAbsolute(projectPath)) {
    throw new BadRequestError('projectPath must be absolute');
  }
}

export const WorkspaceTrustRoutes = () => {
  const app = new Hono();

  app.get('/', async (c) => {
    const projectPath = c.req.query('projectPath');
    if (!projectPath) {
      throw new BadRequestError('projectPath query parameter is required');
    }
    assertAbsoluteProjectPath(projectPath);
    return c.json(await WorkspaceTrustService.getInstance().getStatus(projectPath));
  });

  app.post('/', async (c) => {
    const parsed = safeParseSchema(WorkspaceTrustActionSchema, await c.req.json());
    if (!parsed.success) {
      throw new BadRequestError('Invalid workspace trust request');
    }
    const { projectPath, action } = parsed.data;
    assertAbsoluteProjectPath(projectPath);
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
