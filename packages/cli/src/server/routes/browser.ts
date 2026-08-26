import { Hono } from 'hono';
import {
  WebBrowserInteractRequestSchema,
  WebBrowserNavigateRequestSchema,
} from '../../api/browserSchemas.js';
import type { SessionBrowserRuntime } from '../../browser/SessionBrowserRuntime.js';
import { BrowserRuntimeError } from '../../browser/types.js';
import { safeParseSchema } from '../../schema/index.js';
import { BadRequestError, BladeServerError, InternalServerError } from '../error.js';
import type { SessionRef } from '../sessionRef.js';

export interface WebBrowserRouteDependencies {
  withAdmission<T>(operation: () => Promise<T>): Promise<T>;
  resolveSessionRef(sessionId: string, projectPath?: string): Promise<SessionRef>;
  getRuntime(ref: SessionRef): SessionBrowserRuntime;
  resetRuntime(ref: SessionRef): Promise<void>;
}

function optionalInteger(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new BadRequestError(`${label} must be an integer`);
  }
  return parsed;
}

function optionalBoolean(
  value: string | undefined,
  label: string
): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new BadRequestError(`${label} must be true or false`);
}

function browserServerError(error: BrowserRuntimeError): BladeServerError {
  const status =
    error.code === 'browser_not_installed' ||
    error.code === 'browser_disconnected' ||
    error.code === 'browser_disposed'
      ? 503
      : error.code === 'browser_capacity'
        ? 429
        : error.code === 'browser_unsupported'
          ? 400
          : 409;
  return new BladeServerError(
    error.code.toUpperCase(),
    error.message,
    status,
    error.details
  );
}

export function BrowserRoutes(dependencies: WebBrowserRouteDependencies) {
  const app = new Hono();

  app.use('*', (_c, next) => dependencies.withAdmission(next));

  app.onError((error, c) => {
    const serverError =
      error instanceof BrowserRuntimeError
        ? browserServerError(error)
        : error instanceof BladeServerError
          ? error
          : new InternalServerError();
    return c.json(
      serverError.toObject(),
      serverError.statusCode as 400 | 404 | 409 | 429 | 500 | 503
    );
  });

  const resolve = (sessionId: string, projectPath?: string) =>
    dependencies.resolveSessionRef(sessionId, projectPath);

  app.post('/:sessionId/browser/navigate', async (c) => {
    const body = await c.req.json().catch(() => undefined);
    const parsed = safeParseSchema(WebBrowserNavigateRequestSchema, body);
    if (!parsed.success) {
      throw new BadRequestError('Invalid browser navigation request');
    }
    const ref = await resolve(c.req.param('sessionId'), c.req.query('projectPath'));
    return c.json(await dependencies.getRuntime(ref).navigate(parsed.data));
  });

  app.post('/:sessionId/browser/interact', async (c) => {
    const body = await c.req.json().catch(() => undefined);
    const parsed = safeParseSchema(WebBrowserInteractRequestSchema, body);
    if (!parsed.success) {
      throw new BadRequestError('Invalid browser interaction request');
    }
    const ref = await resolve(c.req.param('sessionId'), c.req.query('projectPath'));
    return c.json(await dependencies.getRuntime(ref).interact(parsed.data));
  });

  app.get('/:sessionId/browser/snapshot', async (c) => {
    const ref = await resolve(c.req.param('sessionId'), c.req.query('projectPath'));
    const depth = optionalInteger(c.req.query('depth'), 'depth');
    const includeBoxes = optionalBoolean(c.req.query('includeBoxes'), 'includeBoxes');
    return c.json(
      await dependencies.getRuntime(ref).snapshot({
        ...(c.req.query('pageId') ? { pageId: c.req.query('pageId') } : {}),
        ...(depth === undefined ? {} : { depth }),
        ...(includeBoxes === undefined ? {} : { includeBoxes }),
      })
    );
  });

  app.get('/:sessionId/browser/inspect', async (c) => {
    const ref = await resolve(c.req.param('sessionId'), c.req.query('projectPath'));
    const runtime = dependencies.getRuntime(ref);
    const target = c.req.query('target');
    const pageId = c.req.query('pageId');
    const expectedOrigin = c.req.query('expectedOrigin');
    if (target === 'screenshot') {
      const bytes = await runtime.screenshot({
        ...(pageId ? { pageId } : {}),
        ...(expectedOrigin ? { expectedOrigin } : {}),
      });
      return new Response(new Uint8Array(bytes), {
        headers: {
          'Content-Type': 'image/png',
          'Content-Length': String(bytes.length),
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    }

    const limit = optionalInteger(c.req.query('limit'), 'limit');
    const common = {
      ...(pageId ? { pageId } : {}),
      ...(expectedOrigin ? { expectedOrigin } : {}),
    };
    if (target === 'find') {
      const text = c.req.query('text');
      if (!text) throw new BadRequestError('text is required for browser find');
      return c.json(
        await runtime.inspect({
          ...common,
          target: { kind: 'find', text, ...(limit === undefined ? {} : { limit }) },
        })
      );
    }
    if (target !== 'console' && target !== 'page-errors' && target !== 'network') {
      throw new BadRequestError('Unsupported browser inspection target');
    }
    return c.json(
      await runtime.inspect({
        ...common,
        target: { kind: target, ...(limit === undefined ? {} : { limit }) },
      })
    );
  });

  app.post('/:sessionId/browser/reset', async (c) => {
    const ref = await resolve(c.req.param('sessionId'), c.req.query('projectPath'));
    await dependencies.resetRuntime(ref);
    return c.json({ success: true });
  });

  return app;
}
