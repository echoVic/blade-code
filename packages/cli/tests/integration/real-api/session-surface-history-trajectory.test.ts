import { createHash } from 'node:crypto';
import { access, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Page, type Response } from 'playwright';
import { describe, expect, it, type TestContext } from 'vitest';
import { SessionSchema } from '../../../src/api/schemas.js';
import { SessionSurfaceCatalogPageSchema } from '../../../src/api/sessionSurfaceSchemas.js';
import { withSessionSurfaceGui } from '../../support/launch-session-surface-gui.js';
import {
  isRealApiTestEnabled,
  resolveRequiredDeepSeekQualificationModels,
} from './testConfig.js';

const models = isRealApiTestEnabled()
  ? resolveRequiredDeepSeekQualificationModels()
  : [];
const describeReal = models.length === 2 ? describe.sequential : describe.skip;

function frameworkRetryBudget(context: TestContext): number {
  const retry = context.task.retry;
  return typeof retry === 'number' ? retry : (retry?.count ?? 0);
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function assertNoPrivateValues(
  values: readonly string[],
  privateValues: readonly string[]
): void {
  for (const value of values) {
    for (const secret of privateValues) {
      if (secret) expect(value).not.toContain(secret);
    }
  }
}

function assertDisplayPathIsNotAuthority(
  urls: readonly string[],
  displayCwd: string
): void {
  for (const url of urls) {
    expect(decodeURIComponent(url)).not.toContain(displayCwd);
  }
}

interface ObservedRequest {
  readonly method: string;
  readonly url: string;
}

function isForbiddenHistoryOnlyRequest(request: ObservedRequest): boolean {
  const pathname = new URL(request.url).pathname.toLowerCase();
  return (
    pathname === '/terminal' ||
    pathname.startsWith('/terminal/') ||
    pathname === '/suggestions/files' ||
    pathname.startsWith('/suggestions/files/') ||
    /^\/sessions\/[^/]+\/browser(?:\/|$)/.test(pathname) ||
    /^\/sessions\/[^/]+\/review(?:\/|$)/.test(pathname) ||
    (request.method !== 'GET' && /^\/sessions\/[^/]+\/message$/.test(pathname))
  );
}

async function openRemoteRow(page: Page): Promise<void> {
  const group = page.locator('[data-remote-session-group]');
  await group.waitFor({ state: 'visible', timeout: 30_000 });
  const button = group.getByRole('button').first();
  const label = await button.innerText();
  expect(label).toContain('Remote');
  expect(label).toContain('Offline');
  expect(label).toContain('History only');
  await button.click();
}

describeReal('production Web remote Session history trajectory', () => {
  for (const model of models) {
    it(`${model.qualificationId} browses and forks offline history in Chromium`, async (context) => {
      const retry = frameworkRetryBudget(context);
      expect(retry).toBe(0);
      const fixtureRoot = await mkdtemp(
        path.join(os.tmpdir(), 'blade-session-surface-gui-')
      );
      const screenshotPath = path.join(
        os.tmpdir(),
        `blade-session-surface-${digest(model.qualificationId).slice(0, 12)}.png`
      );
      try {
        const publicEvidence = await withSessionSurfaceGui(
          { model, frameworkRetryBudget: retry, fixtureRoot },
          async ({ origin, session, localSession, getOutput }) => {
            const localTitle = localSession.title ?? 'Local qualification session';
            const localBefore = localSession;
            const localSessionUrl =
              origin +
              '/sessions/' +
              encodeURIComponent(localBefore.sessionId) +
              '?projectPath=' +
              encodeURIComponent(localBefore.projectPath);
            const browser = await chromium.launch({ headless: true });
            const page = await browser.newPage({
              viewport: { width: 1440, height: 900 },
            });
            const networkUrls: string[] = [];
            const networkRequests: ObservedRequest[] = [];
            const responseBodies: string[] = [];
            const responseBodyReads: Promise<void>[] = [];
            const browserDiagnostics: string[] = [];
            const eventSourceUrls: string[] = [];
            const webSocketUrls: string[] = [];
            page.on('request', (request) => {
              networkUrls.push(request.url());
              networkRequests.push({ method: request.method(), url: request.url() });
            });
            page.on('response', (response: Response) => {
              if (!response.url().includes('/sessions/v2/')) return;
              responseBodyReads.push(
                response
                  .text()
                  .then((body) => {
                    responseBodies.push(body.slice(0, 512 * 1024));
                  })
                  .catch(() => undefined)
              );
            });
            page.on('console', (message) => browserDiagnostics.push(message.text()));
            page.on('pageerror', (error) => browserDiagnostics.push(error.message));
            page.on('websocket', (socket) => webSocketUrls.push(socket.url()));
            await page.addInitScript(() => {
              const OriginalEventSource = window.EventSource;
              const opened: string[] = [];
              class RecordingEventSource extends OriginalEventSource {
                constructor(url: string | URL, init?: EventSourceInit) {
                  opened.push(String(url));
                  super(url, init);
                }
              }
              Object.defineProperty(window, '__bladeEventSourceUrls', {
                value: opened,
              });
              Object.defineProperty(window, 'EventSource', {
                configurable: true,
                value: RecordingEventSource,
              });
            });

            try {
              const initialCatalogResponse = page.waitForResponse((response) => {
                const url = new URL(response.url());
                return url.pathname === '/sessions/v2/catalog';
              });
              await page.goto(origin, { waitUntil: 'domcontentloaded' });
              const catalogResponse = await initialCatalogResponse;
              expect(catalogResponse.status()).toBe(200);
              const catalog = SessionSurfaceCatalogPageSchema.parse(
                await catalogResponse.json()
              );
              expect(
                catalog.sessions.map((candidate) => candidate.locator)
              ).toContainEqual({
                version: 2,
                sessionId: localBefore.sessionId,
                workspace: {
                  kind: 'local',
                  projectPath: localBefore.projectPath,
                },
              });
              expect(
                catalog.sessions.map((candidate) => candidate.locator)
              ).toContainEqual({
                version: 2,
                sessionId: session.sessionId,
                workspace: {
                  kind: 'acp-remote',
                  workspaceRef: session.workspaceRef,
                },
              });
              const remoteGroup = page.locator('[data-remote-session-group]');
              await remoteGroup.waitFor({ state: 'visible', timeout: 30_000 });
              const localProjectGroup = page.locator('[data-project-group]').filter({
                has: page.getByTitle(localBefore.projectPath, { exact: true }),
              });
              await localProjectGroup.waitFor({ state: 'visible', timeout: 30_000 });
              expect(await localProjectGroup.getAttribute('data-project-group')).toBe(
                localBefore.projectPath
              );
              const localProjectToggle = localProjectGroup.locator(
                'button[aria-expanded]'
              );
              if (
                (await localProjectToggle.getAttribute('aria-expanded')) === 'false'
              ) {
                await localProjectToggle.click();
              }
              expect(
                await localProjectGroup.getByText(localTitle, { exact: true }).count()
              ).toBe(1);
              const historyRequestStart = networkRequests.length;
              const historyWebSocketStart = webSocketUrls.length;
              const beforeActions = session.readActivityCounts();
              const sourceTranscript = await session.readTranscript();
              await openRemoteRow(page);
              const surface = page.getByRole('region', {
                name: 'Session history surface',
              });
              await surface.waitFor({ state: 'visible', timeout: 30_000 });
              const banner = page.getByRole('region', {
                name: 'History surface banner',
              });
              const bannerText = await banner.innerText();
              expect(bannerText).toContain('Remote');
              expect(bannerText).toContain('Offline');
              expect(bannerText).toContain('History only');
              expect(bannerText).toContain(session.remoteWorkspacePath);
              expect(bannerText).toContain('Prompt unavailable in history-only mode');
              expect(bannerText).toContain('Files unavailable in history-only mode');
              expect(bannerText).toContain('Terminal unavailable in history-only mode');
              expect(await page.locator('textarea[data-blade-composer]').count()).toBe(
                0
              );
              expect(
                await page.getByRole('button', { name: 'Terminal' }).isDisabled()
              ).toBe(true);
              expect(await page.getByTestId('file-preview').count()).toBe(0);
              expect(await page.locator('[data-browser-panel]').count()).toBe(0);

              await page.getByRole('button', { name: 'Load older messages' }).click();
              await page
                .getByRole('button', { name: 'Load older messages' })
                .waitFor({ state: 'visible', timeout: 30_000 });
              expect(
                await page
                  .getByRole('button', { name: 'Load older messages' })
                  .isDisabled()
              ).toBe(true);
              const search = page.getByRole('searchbox', {
                name: 'Search loaded messages',
              });
              await search.fill('Qualification history page item 001');
              expect(await surface.innerText()).toContain(
                'Qualification history page item 001'
              );
              await page.getByRole('button', { name: 'Fork history branch' }).click();
              await page
                .getByRole('button', { name: 'Fork history branch' })
                .waitFor({ state: 'visible', timeout: 30_000 });
              expect(
                await page
                  .getByRole('region', { name: 'History surface banner' })
                  .innerText()
              ).toContain('History only');
              const forkedUrl = page.url();
              expect(forkedUrl).toContain('view=history');
              expect(forkedUrl).toContain('workspaceKind=acp-remote');
              expect(forkedUrl).toContain('workspaceRef=');
              await page.reload({ waitUntil: 'domcontentloaded' });
              await page
                .getByRole('region', { name: 'Session history surface' })
                .waitFor({ state: 'visible', timeout: 30_000 });
              expect(
                await page
                  .getByRole('region', { name: 'History surface banner' })
                  .innerText()
              ).toContain('History only');
              await page.screenshot({ path: screenshotPath, fullPage: true });

              const recordedEventSources = await page.evaluate(() => {
                const candidate = Object.getOwnPropertyDescriptor(
                  window,
                  '__bladeEventSourceUrls'
                )?.value;
                return Array.isArray(candidate) &&
                  candidate.every((entry) => typeof entry === 'string')
                  ? candidate
                  : [];
              });
              eventSourceUrls.push(...recordedEventSources);
              await Promise.all(responseBodyReads);
              expect(responseBodies.length).toBeGreaterThan(0);
              const afterActions = session.readActivityCounts();
              expect(afterActions).toEqual(beforeActions);
              expect(await session.readTranscript()).toBe(sourceTranscript);
              const localAfterResponse = await fetch(localSessionUrl);
              expect(localAfterResponse.status).toBe(200);
              expect(SessionSchema.parse(await localAfterResponse.json())).toEqual(
                localBefore
              );
              expect(
                networkRequests
                  .slice(historyRequestStart)
                  .filter(isForbiddenHistoryOnlyRequest)
              ).toEqual([]);
              expect(
                webSocketUrls
                  .slice(historyWebSocketStart)
                  .map((url) => ({ method: 'GET', url }))
                  .filter(isForbiddenHistoryOnlyRequest)
              ).toEqual([]);
              assertDisplayPathIsNotAuthority(
                [page.url(), ...networkUrls, ...eventSourceUrls, ...webSocketUrls],
                session.remoteWorkspacePath
              );
              const visibleText = await page.locator('body').innerText();
              assertNoPrivateValues(
                [
                  visibleText,
                  page.url(),
                  ...networkUrls,
                  ...responseBodies,
                  ...browserDiagnostics,
                  ...eventSourceUrls,
                  ...webSocketUrls,
                  getOutput(),
                ],
                session.forbiddenSurfaceValues
              );
            } finally {
              await browser.close();
            }
            return undefined;
          }
        );
        expect(publicEvidence.evidence.frameworkRetryBudget).toBe(0);
        expect(publicEvidence.evidence.modelRetryBudget).toBe(0);
        expect(publicEvidence.evidence.providerRequestCount).toBeGreaterThan(0);
        expect(publicEvidence.evidence.acpFileReadCount).toBe(1);
        expect(publicEvidence.coordinates.sessionIdDigest).toMatch(/^[a-f0-9]{64}$/);
        await expect(access(screenshotPath)).resolves.toBeUndefined();
      } finally {
        await Promise.all([
          rm(fixtureRoot, { recursive: true, force: true }),
          rm(screenshotPath, { force: true }),
        ]);
      }
    }, 300_000);
  }
});
