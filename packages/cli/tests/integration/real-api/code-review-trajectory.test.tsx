// @vitest-environment jsdom

import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { act } from 'react';
import ReactDOM from 'react-dom/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AcpSession } from '../../../src/acp/Session.js';
import { PermissionMode, type RuntimeConfig } from '../../../src/config/types.js';
import { Bus } from '../../../src/server/bus.js';
import { SessionRoutes } from '../../../src/server/routes/session.js';
import { CodeReviewService } from '../../../src/services/CodeReviewService.js';
import { SessionService } from '../../../src/services/SessionService.js';
import { getState } from '../../../src/store/vanilla.js';
import { useAgent } from '../../../src/ui/hooks/useAgent.js';
import { removeTestDirectory } from '../../support/helpers/removeTestDirectory.js';
import { createMockACPClient } from '../../support/mocks/mockACPClient.js';
import { assertNoSecrets } from './sessionForkTrajectoryHarness.js';
import {
  buildRealApiRuntimeConfig,
  isRealApiTestEnabled,
  resolveForkQualificationModels,
} from './testConfig.js';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const gpt = isRealApiTestEnabled()
  ? resolveForkQualificationModels(process.env).find((model) => model.id === 'gpt')
  : undefined;
const describeReal = gpt ? describe.sequential : describe.skip;
const originalStorageRoot = process.env.BLADE_STORAGE_ROOT;
let originalConfig: RuntimeConfig | null = null;

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function createReviewFixture(prefix: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  const workspace = path.join(root, 'workspace');
  const storageRoot = path.join(root, 'storage');
  await mkdir(workspace, { recursive: true });
  git(workspace, ['init', '-q']);
  git(workspace, ['config', 'user.email', 'review@example.com']);
  git(workspace, ['config', 'user.name', 'Review Fixture']);
  const filePath = path.join(workspace, 'authorization.ts');
  await writeFile(
    filePath,
    [
      'export interface User {',
      '  id: string;',
      '  isAdmin: boolean;',
      '}',
      '',
      'export function isAuthorized(user: User, resourceOwnerId: string) {',
      '  if (user.isAdmin) return true;',
      '  return user.id === resourceOwnerId;',
      '}',
      '',
    ].join('\n')
  );
  git(workspace, ['add', 'authorization.ts']);
  git(workspace, ['commit', '-qm', 'baseline']);
  await writeFile(
    filePath,
    [
      'export interface User {',
      '  id: string;',
      '  isAdmin: boolean;',
      '}',
      '',
      'export function isAuthorized(user: User, resourceOwnerId: string) {',
      '  if (user.isAdmin) return true;',
      '  return (user.id = resourceOwnerId);',
      '}',
      '',
    ].join('\n')
  );
  return {
    root,
    workspace,
    storageRoot,
    filePath,
    beforeContent: await readFile(filePath, 'utf8'),
    beforeStatus: git(workspace, ['status', '--porcelain=v1']),
  };
}

function expectActionableReview(
  reviews: Awaited<ReturnType<typeof CodeReviewService.list>>
) {
  const review = reviews.at(-1);
  expect(review?.completion?.status, JSON.stringify(review)).toBe('completed');
  expect(review?.completion?.findings.length).toBeGreaterThanOrEqual(1);
  expect(review?.completion?.findings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        codeLocation: expect.objectContaining({
          path: 'authorization.ts',
          lineStart: 8,
          lineEnd: 8,
        }),
      }),
    ])
  );
  return review;
}

async function assertWorkspaceUnchanged(
  fixture: Awaited<ReturnType<typeof createReviewFixture>>
) {
  expect(await readFile(fixture.filePath, 'utf8')).toBe(fixture.beforeContent);
  expect(git(fixture.workspace, ['status', '--porcelain=v1'])).toBe(
    fixture.beforeStatus
  );
}

function waitForWebReview(sessionId: string, projectPath: string) {
  let unsubscribe: () => void = () => undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<void>((resolve, reject) => {
    timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error('Timed out waiting for Web code review'));
    }, 180_000);
    unsubscribe = Bus.subscribe((event) => {
      if (event.sessionId !== sessionId || event.projectPath !== projectPath) {
        return;
      }
      if (event.type === 'review.completed') {
        clearTimeout(timeout);
        unsubscribe();
        resolve();
      }
    });
  });
  return {
    promise,
    cancel() {
      if (timeout) clearTimeout(timeout);
      unsubscribe();
    },
  };
}

beforeAll(() => {
  if (gpt) originalConfig = getState().config.config;
});

afterAll(() => {
  if (originalConfig) getState().config.actions.setConfig(originalConfig);
  if (originalStorageRoot === undefined) delete process.env.BLADE_STORAGE_ROOT;
  else process.env.BLADE_STORAGE_ROOT = originalStorageRoot;
});

describeReal('native read-only code review trajectory (real API)', () => {
  it('runs a structured review through the production Web route', async () => {
    if (!gpt) throw new Error('GPT qualification channel is unavailable');
    const fixture = await createReviewFixture('blade-review-web-');
    const app = new Hono();
    app.route('/sessions', SessionRoutes());
    const config = {
      ...buildRealApiRuntimeConfig(gpt),
      permissionMode: PermissionMode.DEFAULT,
    };
    let sessionId: string | undefined;

    try {
      process.env.BLADE_STORAGE_ROOT = fixture.storageRoot;
      getState().config.actions.setConfig(config);
      const created = await app.request('/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: 'Real Web Code Review',
          projectPath: fixture.workspace,
        }),
      });
      expect(created.status).toBe(200);
      sessionId = ((await created.json()) as { sessionId: string }).sessionId;
      const completion = waitForWebReview(sessionId, fixture.workspace);
      const response = await app.request(`/sessions/${sessionId}/review`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          projectPath: fixture.workspace,
          kind: 'uncommitted',
        }),
      });
      if (response.status !== 202) completion.cancel();
      expect(response.status, await response.clone().text()).toBe(202);
      await completion.promise;

      const reviews = await CodeReviewService.list(fixture.workspace, sessionId);
      if (reviews.at(-1)?.completion?.status !== 'completed') {
        const reviewerSessionId = reviews.at(-1)?.start.reviewerSessionId;
        const child = reviewerSessionId
          ? await SessionService.loadSession(reviewerSessionId, fixture.workspace)
          : [];
        throw new Error(
          `Review failed: ${JSON.stringify({ review: reviews.at(-1), child })}`
        );
      }
      const review = expectActionableReview(reviews);
      await assertWorkspaceUnchanged(fixture);
      assertNoSecrets(review, [gpt.apiKey]);
    } finally {
      if (sessionId) {
        await app.request(
          `/sessions/${sessionId}?projectPath=${encodeURIComponent(fixture.workspace)}`,
          { method: 'DELETE' }
        );
      }
      if (originalConfig) getState().config.actions.setConfig(originalConfig);
      await removeTestDirectory(fixture.root);
    }
  }, 300_000);

  it('runs the same reviewer through ACP /review', async () => {
    if (!gpt) throw new Error('GPT qualification channel is unavailable');
    const fixture = await createReviewFixture('blade-review-acp-');
    const sessionId = `review-acp-${Date.now()}`;
    const client = createMockACPClient();
    const config = {
      ...buildRealApiRuntimeConfig(gpt),
      permissionMode: PermissionMode.DEFAULT,
    };
    const session = new AcpSession(
      sessionId,
      fixture.workspace,
      client as never,
      undefined,
      { permissionMode: PermissionMode.DEFAULT }
    );

    try {
      process.env.BLADE_STORAGE_ROOT = fixture.storageRoot;
      getState().config.actions.setConfig(config);
      await SessionService.createSessionMetadata(sessionId, fixture.workspace, {
        taskStatus: 'completed',
        selectedModelId: config.currentModelId,
        permissionMode: 'default',
      });
      await session.initialize();
      const response = await session.prompt({
        sessionId,
        prompt: [{ type: 'text', text: '/review uncommitted' }],
      });

      const reviews = await CodeReviewService.list(fixture.workspace, sessionId);
      expect(response.stopReason, JSON.stringify(reviews)).toBe('end_turn');
      const review = expectActionableReview(reviews);
      await assertWorkspaceUnchanged(fixture);
      assertNoSecrets({ review, updates: client.sessionUpdates }, [gpt.apiKey]);
    } finally {
      await session.destroy().catch(() => undefined);
      if (originalConfig) getState().config.actions.setConfig(originalConfig);
      await removeTestDirectory(fixture.root);
    }
  }, 300_000);

  it('runs the same reviewer through the TUI runtime hook', async () => {
    if (!gpt) throw new Error('GPT qualification channel is unavailable');
    const fixture = await createReviewFixture('blade-review-tui-');
    const sessionId = `review-tui-${Date.now()}`;
    const config = {
      ...buildRealApiRuntimeConfig(gpt),
      permissionMode: PermissionMode.DEFAULT,
    };
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = ReactDOM.createRoot(container);
    let hook: ReturnType<typeof useAgent> | undefined;

    function Harness() {
      hook = useAgent({
        sessionId,
        workspaceRoot: fixture.workspace,
        permissionMode: PermissionMode.DEFAULT,
      });
      return null;
    }

    try {
      process.env.BLADE_STORAGE_ROOT = fixture.storageRoot;
      getState().config.actions.setConfig(config);
      await SessionService.createSessionMetadata(sessionId, fixture.workspace, {
        taskStatus: 'completed',
        selectedModelId: config.currentModelId,
        permissionMode: 'default',
      });
      await act(async () => {
        root.render(<Harness />);
        await Promise.resolve();
      });
      const result = await hook?.runCodeReview({ kind: 'uncommitted' });

      expect(result).toMatchObject({
        status: 'completed',
        findings: expect.any(Number),
      });
      expect(result?.findings).toBeGreaterThanOrEqual(1);
      const review = expectActionableReview(
        await CodeReviewService.list(fixture.workspace, sessionId)
      );
      await assertWorkspaceUnchanged(fixture);
      assertNoSecrets(review, [gpt.apiKey]);
    } finally {
      await hook?.cleanupAgent().catch(() => undefined);
      await act(async () => {
        root.unmount();
        await Promise.resolve();
      });
      container.remove();
      if (originalConfig) getState().config.actions.setConfig(originalConfig);
      await removeTestDirectory(fixture.root);
    }
  }, 300_000);
});
