import { Hono } from 'hono';
import { getSubagentRegistry } from '../../agent/subagents/SubagentRegistry.js';
import { TeamRuntime } from '../../agent/teams/TeamRuntime.js';
import {
  TeamCreateRequestSchema,
  TeamMessageRequestSchema,
  TeamTaskClaimRequestSchema,
} from '../../api/teamSchemas.js';
import { getBladeStorageRoot } from '../../context/storage/pathUtils.js';
import { createLogger, LogCategory } from '../../logging/Logger.js';
import { safeParseSchema } from '../../schema/index.js';
import { SessionService } from '../../services/SessionService.js';
import { getState } from '../../store/vanilla.js';
import {
  BadRequestError,
  BladeServerError,
  InternalServerError,
  NotFoundError,
  ServiceUnavailableError,
} from '../error.js';
import { normalizeLocalWorkspacePath, type SessionRef } from '../sessionRef.js';

const logger = createLogger(LogCategory.SERVICE);

export const TeamRoutes = () => {
  const app = new Hono();

  app.onError((error, c) => {
    if (error instanceof BladeServerError) {
      return c.json(
        error.toObject(),
        error.statusCode as 400 | 404 | 409 | 429 | 500 | 503
      );
    }
    logger.error('[TeamRoutes] Unhandled route error:', error);
    return c.json(new InternalServerError('Team operation failed').toObject(), 500);
  });

  app.get('/', async (c) => {
    assertEnabled();
    const owner = await resolveOwner(
      c.req.query('sessionId'),
      c.req.query('projectPath')
    );
    return c.json(await runtime(owner.projectPath).list(owner));
  });

  app.post('/', async (c) => {
    assertEnabled();
    const parsed = safeParseSchema(TeamCreateRequestSchema, await readJson(c.req));
    if (!parsed.success) throw new BadRequestError('Invalid team request');
    const owner = await resolveOwner(parsed.data.sessionId, parsed.data.projectPath);
    const metadata = await SessionService.findSessionMetadata(
      owner.sessionId,
      owner.projectPath
    );
    return c.json(
      await runtime(owner.projectPath).create({
        name: parsed.data.name,
        description: parsed.data.description,
        leadAgentType: parsed.data.leadAgentType,
        owner,
        modelId: metadata?.selectedModelId,
        peerMessagingEnabled: parsed.data.peerMessagingEnabled,
        members: parsed.data.members,
        tasks: parsed.data.tasks,
      }),
      201
    );
  });

  app.get('/:teamName', async (c) => {
    assertEnabled();
    const owner = await resolveOwner(
      c.req.query('sessionId'),
      c.req.query('projectPath')
    );
    return c.json(
      await runtime(owner.projectPath).getSnapshot(c.req.param('teamName'), owner)
    );
  });

  app.post('/:teamName/messages', async (c) => {
    assertEnabled();
    const parsed = safeParseSchema(TeamMessageRequestSchema, await readJson(c.req));
    if (!parsed.success) throw new BadRequestError('Invalid team message');
    const owner = await resolveOwner(parsed.data.sessionId, parsed.data.projectPath);
    const messages = await runtime(owner.projectPath).sendMessage({
      name: c.req.param('teamName'),
      to: parsed.data.to,
      body: parsed.data.message,
      owner,
    });
    return c.json({ messages });
  });

  app.post('/:teamName/tasks/claim', async (c) => {
    assertEnabled();
    const parsed = safeParseSchema(TeamTaskClaimRequestSchema, await readJson(c.req));
    if (!parsed.success) throw new BadRequestError('Invalid team task claim');
    const owner = await resolveOwner(parsed.data.sessionId, parsed.data.projectPath);
    return c.json({
      task: await runtime(owner.projectPath).claimTask(
        c.req.param('teamName'),
        parsed.data.memberId,
        owner
      ),
    });
  });

  app.delete('/:teamName', async (c) => {
    assertEnabled();
    const owner = await resolveOwner(
      c.req.query('sessionId'),
      c.req.query('projectPath')
    );
    return c.json(
      await runtime(owner.projectPath).delete(c.req.param('teamName'), {
        owner,
        killRunning: true,
      })
    );
  });

  return app;
};

function runtime(projectPath: string): TeamRuntime {
  return new TeamRuntime({
    configDir: getBladeStorageRoot(),
    subagentRegistry: getSubagentRegistry(projectPath),
  });
}

function assertEnabled(): void {
  if (getState().config.config?.agentTeamsEnabled !== true) {
    throw new ServiceUnavailableError('Agent Teams are disabled');
  }
}

async function resolveOwner(
  sessionId: string | undefined,
  projectPath: string | undefined
): Promise<SessionRef> {
  if (!sessionId || !projectPath) {
    throw new BadRequestError('sessionId and absolute projectPath are required');
  }
  let resolvedProjectPath: string;
  try {
    resolvedProjectPath = normalizeLocalWorkspacePath(projectPath);
  } catch {
    throw new BadRequestError('sessionId and local projectPath are required');
  }
  const metadata = await SessionService.findSessionMetadata(
    sessionId,
    resolvedProjectPath
  );
  if (!metadata) throw new NotFoundError(`Session not found: ${sessionId}`);
  return { sessionId, projectPath: resolvedProjectPath };
}

async function readJson(request: { json(): Promise<unknown> }): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new BadRequestError('Invalid request body');
  }
}
