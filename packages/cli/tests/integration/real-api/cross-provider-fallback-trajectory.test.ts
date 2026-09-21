import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer, request as requestHttp } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { describe, expect, it } from 'vitest';
import type { ModelConfig } from '../../../src/config/types.js';
import type { StreamChunk } from '../../../src/services/ChatServiceInterface.js';
import { PiAIChatService } from '../../../src/services/PiAIChatService.js';
import { ProviderCircuitRegistry } from '../../../src/services/pi/providerCircuitBreaker.js';
import { ProviderRequestAdmissionScheduler } from '../../../src/services/pi/providerRequestAdmission.js';
import {
  getModelApiKeyEnvironmentVariable,
  resolveModelConfig,
} from '../../../src/services/pi/resolveModelConfig.js';
import { SessionSchema } from '../../../src/api/schemas.js';
import { reserveLoopbackPort, waitForHttp } from '../../support/asyncTestUtils.js';
import {
  startSessionEventRelay,
  withBladeWebTest,
} from '../../support/bladeWebTestHarness.js';
import {
  captureForegroundGuiLauncherIdentity,
  stopForegroundGuiLauncher,
} from '../../support/foregroundBoundedOutputWebDriver.js';
import { startRecordingProviderProxy } from '../../support/recordingProviderProxy.js';
import {
  assertNoSecrets,
  findSessionTranscript,
  inspectFinalAssistantText,
  readSessionEvents,
} from './sessionForkTrajectoryHarness.js';
import {
  buildRealApiRuntimeConfig,
  isRealApiTestEnabled,
  resolveForkQualificationModels,
} from './testConfig.js';

const models = resolveForkQualificationModels();
const claude = models.find((model) => model.id === 'claude');
const deepseek = models.find((model) => model.id === 'deepseek');
const gpt = models.find((model) => model.id === 'gpt');

describe.skipIf(!isRealApiTestEnabled())(
  'cross-provider fallback trajectory (real API)',
  () => {
    it.skipIf(!claude || !deepseek)(
      'moves a pre-output Claude timeout to an independently authenticated DeepSeek channel',
      async () => {
        if (!claude || !deepseek) {
          throw new Error('Claude and DeepSeek models are required');
        }

        const primaryId = 'real-claude-primary';
        const fallbackId = 'real-deepseek-fallback';
        const primaryCredential = getModelApiKeyEnvironmentVariable(primaryId);
        const fallbackCredential = getModelApiKeyEnvironmentVariable(fallbackId);
        const originalPrimary = process.env[primaryCredential];
        const originalFallback = process.env[fallbackCredential];
        const primary: ModelConfig = {
          id: primaryId,
          provider: claude.provider,
          model: claude.model,
          overrides: {
            baseUrl: claude.baseURL,
            maxOutputTokens: 64,
            timeout: 5_000,
            streamIdleTimeout: 3_000,
            maxRetries: 0,
          },
          fallbackModels: [
            {
              provider: deepseek.provider,
              model: deepseek.model,
              configId: fallbackId,
            },
          ],
        };
        const fallback: ModelConfig = {
          id: fallbackId,
          provider: deepseek.provider,
          model: deepseek.model,
          overrides: {
            baseUrl: deepseek.baseURL,
            maxOutputTokens: 64,
            timeout: 30_000,
            streamIdleTimeout: 30_000,
          },
        };

        try {
          process.env[primaryCredential] = claude.apiKey;
          process.env[fallbackCredential] = deepseek.apiKey;
          const resolved = resolveModelConfig(
            primary,
            {
              temperature: 0,
              timeout: 180_000,
              providerCircuitBreakerOpenMs: 0,
              models: [primary, fallback],
            },
            'off'
          );
          const service = new PiAIChatService({
            ...resolved.chat,
            providerCircuitRegistry: new ProviderCircuitRegistry({
              processSecret: new Uint8Array(32).fill(71),
            }),
            providerRequestAdmissionScheduler: new ProviderRequestAdmissionScheduler({
              processSecret: new Uint8Array(32).fill(72),
            }),
          });
          const chunks: StreamChunk[] = [];

          for await (const chunk of service.streamChat(
            [{ role: 'user', content: 'Reply with exactly FALLBACK_OK.' }],
            undefined,
            undefined,
            {
              providerRecovery: {
                mode: 'bounded_foreground',
                budgetMs: 45_000,
              },
            }
          )) {
            chunks.push(chunk);
          }

          expect(resolved.chat.fallbackModels?.[0]?.channel?.apiKey).toBe(
            deepseek.apiKey
          );
          expect(resolved.chat.fallbackModels?.[0]?.channel?.baseUrl).toBe(
            deepseek.baseURL
          );
          expect(chunks.filter((chunk) => chunk.modelFallback)).toHaveLength(1);
          expect(chunks.find((chunk) => chunk.modelFallback)?.modelFallback).toEqual({
            from: { provider: claude.provider, model: claude.model },
            to: { provider: deepseek.provider, model: deepseek.model },
            candidate: 1,
            candidateCount: 1,
            trigger: { source: 'stall', reason: 'timeout' },
          });
          expect(JSON.stringify(chunks)).not.toContain(claude.apiKey);
          expect(JSON.stringify(chunks)).not.toContain(deepseek.apiKey);
          expect(JSON.stringify(chunks)).not.toContain(claude.baseURL);
          expect(JSON.stringify(chunks)).not.toContain(deepseek.baseURL);
          expect(chunks.some((chunk) => chunk.providerRetry?.phase === 'attempt')).toBe(
            false
          );
          expect(
            chunks
              .map((chunk) => chunk.content ?? '')
              .join('')
              .replace(/\p{Cf}/gu, '')
              .trim()
          ).toBe('FALLBACK_OK');
        } finally {
          if (originalPrimary === undefined) delete process.env[primaryCredential];
          else process.env[primaryCredential] = originalPrimary;
          if (originalFallback === undefined) delete process.env[fallbackCredential];
          else process.env[fallbackCredential] = originalFallback;
        }
      },
      60_000
    );

    it.skipIf(!gpt || !deepseek)(
      'rejects text-only fallback after real vision input and preserves vision fallback',
      async () => {
        if (!gpt?.baseURL || !deepseek?.baseURL) {
          throw new Error('GPT and DeepSeek qualification channels are required');
        }
        const visionProxy = await startRecordingProviderProxy(gpt.baseURL, {
          injectFailureOnce: {
            path: '/v1/chat/completions',
            status: 503,
            retryAfterMs: 0,
          },
        });
        let textProxy:
          | Awaited<ReturnType<typeof startRecordingProviderProxy>>
          | undefined;
        let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
        let phase = 'reject-text-fallback';
        let imageHost: ReturnType<typeof createServer> | undefined;
        let imageRequests = 0;
        const closedDownloads = new Set<string>();
        let stalledRequested = false;
        try {
          textProxy = await startRecordingProviderProxy(deepseek.baseURL);
          browser = await chromium.launch({ headless: true });
          const page = await browser.newPage({ viewport: { width: 64, height: 64 } });
          await page.setContent(
            '<body style="margin:0;background:rgb(255,0,0)"></body>'
          );
          const screenshot = await page.screenshot();
          const image = `data:image/png;base64,${screenshot.toString('base64')}`;
          imageHost = createServer((request, response) => {
            const route = new URL(request.url ?? '/', 'http://image.invalid').pathname;
            if (route === '/oversized') {
              response.once('close', () => closedDownloads.add(route));
              response.writeHead(200, { 'content-type': 'image/png' });
              response.write(Buffer.alloc(4 * 1024 * 1024));
              return;
            }
            if (route === '/stalled') {
              stalledRequested = true;
              response.once('close', () => closedDownloads.add(route));
              response.writeHead(200, { 'content-type': 'image/png' });
              response.write(screenshot.subarray(0, 1));
              return;
            }
            if (route === '/forbidden') {
              response.once('close', () => closedDownloads.add(route));
              response.writeHead(403);
              response.flushHeaders();
              return;
            }
            imageRequests++;
            response.writeHead(200, { 'content-type': 'image/png' });
            response.write(screenshot.subarray(0, 1));
            response.end(screenshot.subarray(1));
          });
          const host = imageHost;
          await new Promise<void>((resolve, reject) => {
            host.once('error', reject);
            host.listen(0, '127.0.0.1', resolve);
          });
          const address = imageHost.address();
          if (!address || typeof address === 'string')
            throw new Error('Missing image host');
          const imageUrl = `http://127.0.0.1:${address.port}/image.png`;
          const config = {
            provider: gpt.provider,
            model: gpt.model,
            apiKey: gpt.apiKey,
            baseUrl: visionProxy.baseUrl,
            timeout: 60_000,
            streamIdleTimeout: 60_000,
            maxOutputTokens: 64,
            maxRetries: 0,
            providerCircuitBreakerOpenMs: 0,
            fallbackModels: [
              {
                provider: deepseek.provider,
                model: deepseek.model,
                channel: { apiKey: deepseek.apiKey, baseUrl: textProxy.baseUrl },
              },
            ],
          };
          const blocked = new PiAIChatService(config);
          const input = [
            {
              role: 'user' as const,
              content: [
                {
                  type: 'text' as const,
                  text: 'Name the solid color shown in the image. Return exactly one uppercase ASCII color word as plain text. Do not use Markdown, punctuation, or leading/trailing whitespace.',
                },
                { type: 'image_url' as const, image_url: { url: image } },
              ],
            },
          ];
          const inputWithUrl = (url: string) =>
            input.map((message) => ({
              ...message,
              content: message.content.map((part) =>
                part.type === 'image_url' ? { ...part, image_url: { url } } : part
              ),
            }));
          phase = 'download-boundaries';
          await expect(
            blocked.chat(inputWithUrl(new URL('/oversized', imageUrl).href))
          ).rejects.toThrow('Image attachments exceed the 5 MiB limit');
          await expect.poll(() => closedDownloads.has('/oversized')).toBe(true);
          await expect(
            blocked.chat(
              inputWithUrl(new URL('/forbidden?token=private', imageUrl).href)
            )
          ).rejects.toThrow('Failed to load image: HTTP 403');
          await expect.poll(() => closedDownloads.has('/forbidden')).toBe(true);
          const cancellation = new AbortController();
          const reason = new Error('image request cancelled');
          const cancelled = blocked
            .chat(
              inputWithUrl(new URL('/stalled', imageUrl).href),
              undefined,
              cancellation.signal
            )
            .catch((error: unknown) => error);
          try {
            await expect.poll(() => stalledRequested).toBe(true);
            cancellation.abort(reason);
            expect(await cancelled).toBe(reason);
            await expect.poll(() => closedDownloads.has('/stalled')).toBe(true);
          } finally {
            cancellation.abort(reason);
            await cancelled;
          }
          expect(visionProxy.requestBodies).toEqual([]);
          expect(textProxy.requestBodies).toEqual([]);
          phase = 'reject-text-fallback';
          await expect(blocked.chat(input)).rejects.toThrow(
            'does not support image input'
          );
          expect(visionProxy.injectedRequestNumbers).toEqual([1]);
          expect(visionProxy.forwardedRequestNumbers).toEqual([]);
          expect(textProxy.requestBodies).toEqual([]);

          const remoteInput = inputWithUrl(imageUrl);
          phase = 'vision-control';
          const response = await new PiAIChatService({
            ...config,
            fallbackModels: [],
          }).chat(remoteInput);
          expect(response.content?.trim()).toBe('RED');
          expect(response.usage?.totalTokens).toBeGreaterThan(0);
          expect(visionProxy.forwardedRequestNumbers).toEqual([2]);
          expect(visionProxy.requestLifecycle).toContainEqual({
            requestNumber: 2,
            phase: 'headers_received',
            statusClass: 2,
          });
          expect(visionProxy.requestBodies[1]).toContain(image);

          phase = 'vision-fallback';
          const primaryProxy = await startRecordingProviderProxy(gpt.baseURL, {
            injectFailureOnce: {
              path: '/v1/chat/completions',
              status: 503,
              retryAfterMs: 0,
            },
          });
          try {
            const compatible = new PiAIChatService({
              ...config,
              baseUrl: primaryProxy.baseUrl,
              fallbackModels: [
                {
                  provider: gpt.provider,
                  model: gpt.model,
                  channel: {
                    apiKey: gpt.apiKey,
                    baseUrl: visionProxy.baseUrl,
                    maxOutputTokens: 64,
                    timeout: 60_000,
                    streamIdleTimeout: 60_000,
                  },
                },
              ],
            });
            const result = await compatible.chat(remoteInput);
            expect(result.content?.trim()).toBe('RED');
            expect(result.usage?.totalTokens).toBeGreaterThan(0);
            expect(visionProxy.requestLifecycle).toContainEqual({
              requestNumber: 3,
              phase: 'headers_received',
              statusClass: 2,
            });
            expect(primaryProxy.injectedRequestNumbers).toEqual([1]);
            expect(primaryProxy.forwardedRequestNumbers).toEqual([]);
            expect(visionProxy.forwardedRequestNumbers).toEqual([2, 3]);
            expect(visionProxy.requestBodies[2]).toContain(image);
            expect(visionProxy.requestBodies[2]).toBe(visionProxy.requestBodies[1]);
            expect(visionProxy.requestBodies[2]).not.toContain(imageUrl);
            expect(imageRequests).toBe(2);
            expect(textProxy.requestBodies).toEqual([]);
            assertNoSecrets({ response, result }, [gpt.apiKey, deepseek.apiKey]);
          } finally {
            await primaryProxy.close();
          }
        } catch (error) {
          console.error('IMAGE_FALLBACK_DIAGNOSTIC', {
            phase,
            model: gpt.model,
            visionLifecycle: visionProxy.requestLifecycle,
            visionResponses: visionProxy.responseSummaries,
            controlMatchesFallback:
              visionProxy.requestBodies[2] !== undefined &&
              visionProxy.requestBodies[1] === visionProxy.requestBodies[2],
            textRequestCount: textProxy?.requestBodies.length ?? 0,
          });
          throw error;
        } finally {
          const host = imageHost;
          await Promise.all([
            browser?.close(),
            textProxy?.close(),
            visionProxy.close(),
            host
              ? new Promise<void>((resolve, reject) => {
                  host.closeAllConnections();
                  host.close((error) => (error ? reject(error) : resolve()));
                })
              : undefined,
          ]);
        }
      },
      180_000
    );

    for (const surface of ['production', 'development'] as const) {
      it.skipIf(!gpt || !deepseek)(
        `recovers image upload, fallback error, and cancellation in ${surface} Chromium`,
        async () => {
          if (!gpt?.baseURL || !deepseek?.baseURL)
            throw new Error('Missing image qualification channels');
          const root = await mkdtemp(path.join(os.tmpdir(), 'blade-image-web-'));
          const workspace = path.join(root, 'workspace');
          const home = path.join(root, 'home');
          const storageRoot = path.join(root, 'storage');
          let proxy:
            | Awaited<ReturnType<typeof startRecordingProviderProxy>>
            | undefined;
          let textProxy:
            | Awaited<ReturnType<typeof startRecordingProviderProxy>>
            | undefined;
          let cancelHost: ReturnType<typeof createServer> | undefined;
          let cancellationReached = false;
          let cancellationClosed = false;
          let resumeThroughProvider = false;
          let cancellationRequests = 0;
          let relay: Awaited<ReturnType<typeof startSessionEventRelay>> | undefined;
          let dev: ChildProcess | undefined;
          let devIdentity:
            | Awaited<ReturnType<typeof captureForegroundGuiLauncherIdentity>>
            | undefined;
          let phase = 'setup';
          try {
            await mkdir(workspace);
            await mkdir(path.join(home, '.blade'), { recursive: true, mode: 0o700 });
            proxy = await startRecordingProviderProxy(gpt.baseURL, {
              injectFailureOnce: {
                path: '/v1/chat/completions',
                status: 503,
                retryAfterMs: 0,
              },
            });
            textProxy = await startRecordingProviderProxy(deepseek.baseURL);
            const recordingProxy = proxy;
            cancelHost = createServer((request, response) => {
              cancellationRequests++;
              if (resumeThroughProvider) {
                const upstream = requestHttp(
                  new URL(request.url ?? '/', recordingProxy.baseUrl),
                  {
                    method: request.method,
                    headers: request.headers,
                  },
                  (source) => {
                    response.writeHead(source.statusCode ?? 502, source.headers);
                    source.once('error', () => response.destroy());
                    source.pipe(response);
                    response.once('close', () => source.destroy());
                  }
                );
                upstream.once('error', () => response.destroy());
                response.once('close', () => upstream.destroy());
                request.pipe(upstream);
                return;
              }
              request.resume();
              request.once('end', () => {
                cancellationReached = true;
                response.once('close', () => {
                  cancellationClosed = true;
                });
              });
            });
            const cancelServer = cancelHost;
            await new Promise<void>((resolve, reject) => {
              cancelServer.once('error', reject);
              cancelServer.listen(0, '127.0.0.1', resolve);
            });
            const cancelAddress = cancelServer.address();
            if (!cancelAddress || typeof cancelAddress === 'string')
              throw new Error('Missing cancellation host');
            const config = buildRealApiRuntimeConfig({
              ...gpt,
              baseURL: proxy.baseUrl,
            });
            const primary = config.models[0];
            const textModel: ModelConfig = {
              id: 'image-text-fallback',
              provider: deepseek.provider,
              model: deepseek.model,
              overrides: { baseUrl: textProxy.baseUrl, maxRetries: 0 },
            };
            const cancelModel: ModelConfig = {
              ...primary,
              id: 'image-cancel',
              displayName: 'Image cancellation gate',
              overrides: {
                ...primary.overrides,
                baseUrl: `http://127.0.0.1:${cancelAddress.port}/v1`,
                maxRetries: 0,
              },
            };
            await writeFile(
              path.join(home, '.blade', 'config.json'),
              JSON.stringify({
                ...config,
                models: [
                  {
                    ...primary,
                    displayName: 'Image vision primary',
                    overrides: { ...primary.overrides, maxRetries: 0 },
                    fallbackModels: [
                      {
                        provider: textModel.provider,
                        model: textModel.model,
                        configId: textModel.id,
                      },
                    ],
                  },
                  textModel,
                  cancelModel,
                ],
                maxTurns: 2,
                permissionMode: 'yolo',
                hooks: { enabled: false },
                disableAllHooks: true,
                mcpServers: {},
                lspServers: {},
              }),
              { mode: 0o600 }
            );
            const recording = proxy;
            const deniedChannel = textProxy;
            await withBladeWebTest(
              {
                workspace,
                home,
                storageRoot,
                env: {
                  [getModelApiKeyEnvironmentVariable(textModel.id)]: deepseek.apiKey,
                },
              },
              {
                context: { viewport: { width: 1280, height: 900 } },
                includeHttpErrors: false,
              },
              async ({ page, origin, faults, state }) => {
                let guiOrigin = origin;
                if (surface === 'development') {
                  const webRoot = path.resolve(import.meta.dirname, '../../../web');
                  const dependencyRoot = await realpath(
                    path.resolve(webRoot, '../../../node_modules')
                  );
                  const port = await reserveLoopbackPort();
                  dev = spawn(
                    process.execPath,
                    [
                      '--input-type=module',
                      '--eval',
                      'import {createServer,searchForWorkspaceRoot} from "vite";' +
                        `const server=await createServer({server:{host:"127.0.0.1",port:${port},strictPort:true,fs:{allow:[searchForWorkspaceRoot(process.cwd()),${JSON.stringify(dependencyRoot)}]}}});await server.listen();`,
                    ],
                    {
                      cwd: webRoot,
                      env: { ...process.env, VITE_API_TARGET: origin },
                      detached: true,
                      stdio: 'ignore',
                    }
                  );
                  if (!dev.pid) throw new Error('Vite did not start');
                  devIdentity = await captureForegroundGuiLauncherIdentity(dev.pid);
                  guiOrigin = `http://127.0.0.1:${port}`;
                  await waitForHttp(guiOrigin);
                }
                const created = await fetch(`${origin}/sessions`, {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({
                    projectPath: workspace,
                    title: 'Image UI qualification',
                  }),
                });
                expect(created.ok).toBe(true);
                const sessionId = SessionSchema.parse(await created.json()).sessionId;
                relay = await startSessionEventRelay({
                  origin,
                  browserOrigin: guiOrigin,
                  sessionId,
                });
                const eventRelay = relay;
                await page.route(`**/sessions/${sessionId}/events?*`, (route) => {
                  const requestUrl = new URL(route.request().url());
                  return route.continue({
                    url: `${eventRelay.origin}${requestUrl.pathname}${requestUrl.search}`,
                  });
                });
                const url = new URL(guiOrigin);
                url.searchParams.set('session', sessionId);
                url.searchParams.set('project', workspace);
                await page.goto(url.href, { waitUntil: 'domcontentloaded' });
                const composer = page.locator('textarea[data-blade-composer]');
                const submit = page.locator('[data-blade-submit]');
                const upload = page.locator('input[type="file"][accept="image/*"]');
                await composer.waitFor({ state: 'visible' });
                await upload.waitFor({ state: 'visible' });
                const prompt =
                  'Do not use tools. Name the solid color shown in the image. Return exactly one uppercase ASCII color word as plain text. Do not use Markdown, punctuation, or leading/trailing whitespace.';
                await composer.fill(prompt);
                const screenshotPage = await page.context().newPage();
                await screenshotPage.setViewportSize({ width: 64, height: 64 });
                await screenshotPage.setContent(
                  '<body style="margin:0;background:rgb(255,0,0)"></body>'
                );
                const screenshot = await screenshotPage.screenshot();
                await screenshotPage.close();
                const attachment = {
                  name: 'color.png',
                  mimeType: 'image/png',
                  buffer: screenshot,
                };
                phase = 'oversized-upload';
                await upload.setInputFiles({
                  name: 'oversized.png',
                  mimeType: 'image/png',
                  buffer: Buffer.alloc(4 * 1024 * 1024),
                });
                await page
                  .getByRole('alert')
                  .filter({ hasText: /5\.0 MiB/ })
                  .waitFor();
                expect(await composer.inputValue()).toBe(prompt);
                expect(await page.getByAltText('oversized.png').count()).toBe(0);
                expect(recording.requestBodies).toEqual([]);
                phase = 'fallback-error';
                await upload.setInputFiles(attachment);
                await page.getByAltText('color.png', { exact: true }).waitFor();
                await submit.click();
                const errorBanner = page.locator('[data-blade-session-error]');
                await errorBanner.waitFor({ timeout: 60_000 });
                expect(await errorBanner.textContent()).toMatch(
                  /不支持|does not support/
                );
                expect(recording.injectedRequestNumbers).toEqual([1]);
                expect(deniedChannel.requestBodies).toEqual([]);
                phase = 'recover-draft';
                await errorBanner
                  .getByRole('button', { name: /编辑后重发|Edit and resend/ })
                  .click();
                await expect.poll(() => composer.inputValue()).toBe(prompt);
                await page
                  .getByRole('button', {
                    name: /移除 attachment-1|Remove attachment-1/,
                  })
                  .waitFor();
                await submit.click();
                try {
                  await page
                    .locator('[data-chat-role="assistant"]')
                    .getByText('RED', { exact: true })
                    .waitFor({ timeout: 90_000 });
                } catch (error) {
                  console.error('IMAGE_WEB_VISION', {
                    surface,
                    status: await (
                      await fetch(
                        `${origin}/sessions/${sessionId}/status?projectPath=${encodeURIComponent(workspace)}`
                      )
                    ).json(),
                    final: inspectFinalAssistantText(
                      readSessionEvents(findSessionTranscript(storageRoot, sessionId))
                    ),
                    lifecycle: recording.requestLifecycle,
                    errorVisible: await errorBanner.isVisible(),
                  });
                  throw error;
                }
                await page
                  .locator('[data-turn-activity-strip]')
                  .waitFor({ state: 'detached' });
                expect(recording.forwardedRequestNumbers).toEqual([2]);
                expect(recording.requestBodies[1]).toContain(
                  screenshot.toString('base64')
                );
                const visionFinal = inspectFinalAssistantText(
                  readSessionEvents(findSessionTranscript(storageRoot, sessionId))
                );
                expect(visionFinal).toEqual({ state: 'ready', text: 'RED' });
                expect(recording.responseSummaries).toContainEqual(
                  expect.objectContaining({
                    requestNumber: 2,
                    parseStatus: 'complete',
                    contentChars: 3,
                  })
                );
                phase = 'cancel-image-turn';
                await page.getByTitle(/切换模型|Change model/).click();
                await page
                  .getByRole('button', { name: /Image cancellation gate/ })
                  .click();
                await upload.setInputFiles(attachment);
                await composer.fill(prompt);
                await submit.click();
                await expect
                  .poll(() => cancellationReached, { timeout: 30_000 })
                  .toBe(true);
                await page
                  .getByRole('button', {
                    name: /停止当前轮次|Stop active turn/,
                    exact: true,
                  })
                  .click();
                await expect
                  .poll(() => cancellationClosed, { timeout: 30_000 })
                  .toBe(true);
                await page
                  .getByRole('button', {
                    name: /停止当前轮次|Stop active turn|正在停止当前轮次|Stopping active turn/,
                    exact: true,
                  })
                  .waitFor({ state: 'detached' });
                phase = 'ordinary-follow-up';
                await page.getByTitle(/切换模型|Change model/).click();
                await page
                  .getByRole('button', {
                    name: /Image vision primary/,
                  })
                  .click();
                const followUpPrompt =
                  'The previous image task was cancelled. This is a new ordinary task; do not describe any images. Do not use tools. Reply with exactly IMAGE_UI_READY as plain text without Markdown or surrounding whitespace.';
                await composer.fill(followUpPrompt);
                const followUpSubmission = page.waitForResponse(
                  (response) =>
                    response.request().method() === 'POST' &&
                    new URL(response.url()).pathname ===
                      `/sessions/${sessionId}/message`
                );
                await submit.click();
                const submitted = await followUpSubmission;
                const submittedBody: unknown = submitted.request().postDataJSON();
                expect(submittedBody).toMatchObject({ modelId: primary.id });
                console.log('IMAGE_WEB_SUBMISSION', {
                  surface,
                  status: submitted.status(),
                  response: await submitted.json(),
                });
                expect(submitted.status()).toBe(202);
                await expect
                  .poll(() => recording.requestBodies.length, { timeout: 30_000 })
                  .toBe(3);
                const followUpRequest: unknown = JSON.parse(recording.requestBodies[2]);
                if (
                  !followUpRequest ||
                  typeof followUpRequest !== 'object' ||
                  !('messages' in followUpRequest) ||
                  !Array.isArray(followUpRequest.messages)
                )
                  throw new Error('Missing follow-up Provider messages');
                expect(followUpRequest.messages.at(-1)).toMatchObject({
                  role: 'user',
                  content: followUpPrompt,
                });
                try {
                  await page
                    .locator('[data-chat-role="assistant"]')
                    .getByText('IMAGE_UI_READY', { exact: true })
                    .waitFor({ timeout: 90_000 });
                } catch (error) {
                  const diagnosticEvents = readSessionEvents(
                    findSessionTranscript(storageRoot, sessionId)
                  );
                  console.error('IMAGE_WEB_FOLLOWUP', {
                    surface,
                    status: await (
                      await fetch(
                        `${origin}/sessions/${sessionId}/status?projectPath=${encodeURIComponent(workspace)}`
                      )
                    ).json(),
                    modelLabel: await page
                      .getByTitle(/切换模型|Change model/)
                      .textContent()
                      .catch(() => null),
                    errorVisible: await errorBanner.isVisible(),
                    final: inspectFinalAssistantText(diagnosticEvents),
                    requestUserMessages: (() => {
                      const request: unknown = JSON.parse(
                        recording.requestBodies.at(-1) ?? '{}'
                      );
                      if (
                        !request ||
                        typeof request !== 'object' ||
                        !('messages' in request) ||
                        !Array.isArray(request.messages)
                      )
                        return [];
                      return request.messages
                        .filter(
                          (message: unknown) =>
                            message &&
                            typeof message === 'object' &&
                            'role' in message &&
                            message.role === 'user'
                        )
                        .map((message: Record<string, unknown>) => ({
                          content:
                            typeof message.content === 'string'
                              ? message.content.slice(-160)
                              : Array.isArray(message.content)
                                ? message.content.filter(
                                    (part: unknown) =>
                                      part &&
                                      typeof part === 'object' &&
                                      'type' in part &&
                                      part.type === 'text'
                                  )
                                : [],
                        }));
                    })(),
                    lifecycle: diagnosticEvents
                      .filter((event) =>
                        ['turn_started', 'turn_aborted', 'turn_completed'].includes(
                          event.type
                        )
                      )
                      .map((event) => ({ type: event.type, data: event.data })),
                  });
                  throw error;
                }
                await page
                  .locator('[data-turn-activity-strip]')
                  .waitFor({ state: 'detached' });
                expect(recording.forwardedRequestNumbers).toEqual([2, 3]);
                const events = readSessionEvents(
                  findSessionTranscript(storageRoot, sessionId)
                );
                expect(
                  events.filter((event) => event.type === 'turn_completed')
                ).toHaveLength(2);
                expect(events.filter((event) => event.type === 'turn_aborted')).toEqual(
                  [
                    expect.objectContaining({
                      data: expect.objectContaining({ cause: 'failed' }),
                    }),
                    expect.objectContaining({
                      data: expect.objectContaining({ cause: 'cancelled' }),
                    }),
                  ]
                );
                phase = 'event-stream-reconnect';
                cancellationClosed = false;
                const gateBeforeReconnect = cancellationRequests;
                await page.getByTitle(/切换模型|Change model/).click();
                await page
                  .getByRole('button', { name: /Image cancellation gate/ })
                  .click();
                await composer.fill(
                  'The previous task is finished. Do not use tools. Reply with exactly SSE_RECONNECT_READY as plain text.'
                );
                await submit.click();
                await expect
                  .poll(() => cancellationRequests)
                  .toBe(gateBeforeReconnect + 1);
                expect(eventRelay.connections.at(-1)?.searchParams.get('resume')).toBe(
                  'false'
                );
                const connectionCount = eventRelay.connections.length;
                eventRelay.disconnectAndHold();
                await expect
                  .poll(() => eventRelay.heldCount, { timeout: 15_000 })
                  .toBe(1);
                const reconnectUrl = eventRelay.connections.at(-1);
                expect(eventRelay.connections).toHaveLength(connectionCount + 1);
                expect(reconnectUrl?.searchParams.has('resume')).toBe(false);
                expect(
                  Number(reconnectUrl?.searchParams.get('lastEventId'))
                ).toBeGreaterThan(0);
                const abortResponse = await fetch(
                  `${origin}/sessions/${sessionId}/abort?projectPath=${encodeURIComponent(workspace)}`,
                  { method: 'POST' }
                );
                expect(abortResponse.ok).toBe(true);
                await expect.poll(() => cancellationClosed).toBe(true);
                resumeThroughProvider = true;
                eventRelay.release();
                await page
                  .locator('[data-chat-role="assistant"]')
                  .getByText('SSE_RECONNECT_READY', { exact: true })
                  .waitFor({ timeout: 90_000 });
                await page
                  .locator('[data-turn-activity-strip]')
                  .waitFor({ state: 'detached' });
                expect(cancellationRequests).toBe(gateBeforeReconnect + 2);
                expect(recording.forwardedRequestNumbers).toEqual([2, 3, 4]);
                const recoveredEvents = readSessionEvents(
                  findSessionTranscript(storageRoot, sessionId)
                );
                expect(
                  recoveredEvents.filter((event) => event.type === 'turn_completed')
                ).toHaveLength(3);
                expect(
                  recoveredEvents.filter((event) => event.type === 'turn_aborted')
                ).toHaveLength(3);
                expect(inspectFinalAssistantText(recoveredEvents)).toEqual({
                  state: 'ready',
                  text: 'SSE_RECONNECT_READY',
                });
                expect(recording.responseSummaries).toContainEqual(
                  expect.objectContaining({ requestNumber: 4, parseStatus: 'complete' })
                );
                state.refreshing = true;
                await page.reload({ waitUntil: 'domcontentloaded' });
                state.refreshing = false;
                await page
                  .locator('[data-chat-role="assistant"]')
                  .getByText('SSE_RECONNECT_READY', { exact: true })
                  .waitFor();
                expect(faults).toEqual([]);
                assertNoSecrets(
                  { dom: await page.content(), events: recoveredEvents },
                  [gpt.apiKey, deepseek.apiKey]
                );
                console.log('IMAGE_WEB_EVIDENCE', {
                  surface,
                  requests: recording.requestBodies.length,
                  completed: 3,
                  failed: 1,
                  cancelled: 2,
                  reconnected: true,
                });
              }
            );
          } catch (error) {
            console.error('IMAGE_WEB_DIAGNOSTIC', {
              surface,
              phase,
              requestCount: proxy?.requestBodies.length,
              cancellationReached,
              cancellationClosed,
              responses: proxy?.responseSummaries,
            });
            throw error;
          } finally {
            if (dev) await stopForegroundGuiLauncher(dev, devIdentity);
            const server = cancelHost;
            await Promise.all([
              proxy?.close(),
              textProxy?.close(),
              relay?.close(),
              server
                ? new Promise<void>((resolve, reject) => {
                    server.closeAllConnections();
                    server.close((error) => (error ? reject(error) : resolve()));
                  })
                : undefined,
            ]);
            await rm(root, { recursive: true, force: true });
          }
        },
        300_000
      );
    }
  }
);
