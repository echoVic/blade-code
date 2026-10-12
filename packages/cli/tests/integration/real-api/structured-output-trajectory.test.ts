import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AcpSession, createLocalAcpSessionRoots } from '../../../src/acp/Session.js';
import { runHeadless } from '../../../src/commands/headless.js';
import { PermissionMode, type RuntimeConfig } from '../../../src/config/types.js';
import { Bus } from '../../../src/server/bus.js';
import { SessionRoutes } from '../../../src/server/routes/session.js';
import type { Message } from '../../../src/services/ChatServiceInterface.js';
import { SessionService } from '../../../src/services/SessionService.js';
import { STRUCTURED_OUTPUT_TOOL_NAME } from '../../../src/services/StructuredOutputService.js';
import { getState } from '../../../src/store/vanilla.js';
import { createMockACPClient } from '../../support/mocks/mockACPClient.js';
import { assertNoSecrets } from './sessionForkTrajectoryHarness.js';
import {
  buildRealApiRuntimeConfig,
  isRealApiTestEnabled,
  resolveForkQualificationModels,
  type TestModelConfig,
} from './testConfig.js';

const models = isRealApiTestEnabled()
  ? resolveForkQualificationModels(process.env)
  : [];
const gpt = models.find((model) => model.id === 'gpt');
const claude = models.find((model) => model.id === 'claude');
const deepseek = models.find((model) => model.id === 'deepseek');
const describeReal = isRealApiTestEnabled() ? describe : describe.skip;
const originalStorageRoot = process.env.BLADE_STORAGE_ROOT;
let originalConfig: RuntimeConfig | null = null;

const outputSchema = {
  type: 'object',
  properties: {
    surface: {
      type: 'string',
      enum: ['web', 'acp', 'headless'],
    },
    ok: { type: 'boolean', const: true },
    summary: { type: 'string', minLength: 3 },
    // Optional and non-nullable: strict-sampling providers must emit it as null.
    note: { type: 'string', minLength: 1 },
  },
  required: ['surface', 'ok', 'summary'],
  additionalProperties: false,
};

const OMIT_NOTE_INSTRUCTION = ' You have no note, so leave note empty as JSON null.';

function containsNullValue(value: unknown): boolean {
  if (value === null) return true;
  if (Array.isArray(value)) return value.some(containsNullValue);
  if (typeof value === 'object') return Object.values(value).some(containsNullValue);
  return false;
}

function expectNoNullValues(output: unknown): void {
  expect(containsNullValue(output)).toBe(false);
  const note = (output as Record<string, unknown> | undefined)?.note;
  expect(note === undefined || typeof note === 'string').toBe(true);
}

function expectAcceptedOnFirstSubmission(messages: readonly Message[]): void {
  const results = messages.filter(
    (message) => message.role === 'tool' && message.name === STRUCTURED_OUTPUT_TOOL_NAME
  );
  expect(results.length).toBeGreaterThan(0);
  expect(
    results
      .map((message) => String(message.content))
      .filter((content) => content.includes('Structured output validation failed'))
  ).toEqual([]);
}

async function fixture(prefix: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  const workspace = path.join(root, 'workspace');
  const storageRoot = path.join(root, 'storage');
  await Promise.all([
    mkdir(workspace, { recursive: true }),
    mkdir(storageRoot, { recursive: true }),
  ]);
  return { root, workspace, storageRoot };
}

function configure(model: TestModelConfig, storageRoot: string) {
  process.env.BLADE_STORAGE_ROOT = storageRoot;
  const config = {
    ...buildRealApiRuntimeConfig(model),
    permissionMode: PermissionMode.YOLO,
  };
  getState().config.actions.setConfig(config);
  return config;
}

function waitForCompletion(sessionId: string, projectPath: string) {
  const events: Array<{ type: string; properties: Record<string, unknown> }> = [];
  let unsubscribe: () => void = () => undefined;
  let timeout: ReturnType<typeof setTimeout>;
  const promise = new Promise<typeof events>((resolve, reject) => {
    timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error('Timed out waiting for structured Web output'));
    }, 180_000);
    unsubscribe = Bus.subscribe((event) => {
      if (event.sessionId !== sessionId || event.projectPath !== projectPath) return;
      events.push({ type: event.type, properties: event.properties });
      if (event.type === 'session.completed') {
        clearTimeout(timeout);
        unsubscribe();
        resolve(events);
      } else if (event.type === 'session.error') {
        clearTimeout(timeout);
        unsubscribe();
        reject(new Error(String(event.properties.error ?? 'Web run failed')));
      }
    });
  });
  return { promise, cancel: () => (clearTimeout(timeout), unsubscribe()) };
}

beforeAll(() => {
  if (isRealApiTestEnabled()) originalConfig = getState().config.config;
});

afterAll(() => {
  if (originalConfig) getState().config.actions.setConfig(originalConfig);
  if (originalStorageRoot === undefined) delete process.env.BLADE_STORAGE_ROOT;
  else process.env.BLADE_STORAGE_ROOT = originalStorageRoot;
});

describeReal('turn-scoped structured output trajectory (real API)', () => {
  it.skipIf(!gpt)(
    'returns validated structured output through the Web route',
    async () => {
      if (!gpt) throw new Error('GPT qualification channel is unavailable');
      const test = await fixture('blade-structured-web-');
      const app = new Hono();
      app.route('/sessions', SessionRoutes());
      let sessionId: string | undefined;
      try {
        configure(gpt, test.storageRoot);
        const created = await app.request('/sessions', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            title: 'Structured Web Output',
            projectPath: test.workspace,
          }),
        });
        sessionId = ((await created.json()) as { sessionId: string }).sessionId;
        const completion = waitForCompletion(sessionId, test.workspace);
        const response = await app.request(`/sessions/${sessionId}/message`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            projectPath: test.workspace,
            content:
              'Return the requested structured result. Set surface to web, ok to true, ' +
              'and provide a short summary.' +
              OMIT_NOTE_INSTRUCTION,
            outputSchema,
            permissionMode: 'yolo',
          }),
        });
        if (response.status !== 202) completion.cancel();
        expect(response.status, await response.clone().text()).toBe(202);
        const events = await completion.promise;
        const structured = events.find((event) => event.type === 'structured.output');
        expect(structured?.properties.output).toMatchObject({
          surface: 'web',
          ok: true,
          summary: expect.any(String),
        });
        expectNoNullValues(structured?.properties.output);
        const messages = await SessionService.loadSession(sessionId, test.workspace);
        // StructuredOutput is hidden from client projections, so the durable
        // transcript is the host evidence that the strict-sampling null for the
        // optional note was accepted without consuming a corrective retry.
        expectAcceptedOnFirstSubmission(messages);
        expect(messages.at(-1)?.metadata).toMatchObject({
          structuredOutput: {
            output: structured?.properties.output,
            schemaDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
          },
        });
        assertNoSecrets({ events, messages }, [gpt.apiKey]);
      } finally {
        if (sessionId) {
          await app.request(
            `/sessions/${sessionId}?projectPath=${encodeURIComponent(test.workspace)}`,
            { method: 'DELETE' }
          );
        }
        await rm(test.root, { recursive: true, force: true });
      }
    },
    300_000
  );

  it.skipIf(!claude)(
    'returns validated structured output in ACP _meta',
    async () => {
      if (!claude) throw new Error('Claude qualification channel is unavailable');
      const test = await fixture('blade-structured-acp-');
      const sessionId = `structured-acp-${Date.now()}`;
      const client = createMockACPClient();
      const session = new AcpSession(
        sessionId,
        createLocalAcpSessionRoots(test.workspace),
        client as never,
        undefined,
        { permissionMode: PermissionMode.YOLO }
      );
      try {
        const config = configure(claude, test.storageRoot);
        await SessionService.createSessionMetadata(sessionId, test.workspace, {
          selectedModelId: config.currentModelId,
          permissionMode: 'yolo',
        });
        await session.initialize();
        const response = await session.prompt({
          sessionId,
          prompt: [
            {
              type: 'text',
              text:
                'Return the requested structured result. Set surface to acp, ok to ' +
                'true, and provide a short summary.' +
                OMIT_NOTE_INSTRUCTION,
            },
          ],
          _meta: { outputSchema },
        });

        expect(response._meta?.structuredOutput).toMatchObject({
          surface: 'acp',
          ok: true,
          summary: expect.any(String),
        });
        expectNoNullValues(response._meta?.structuredOutput);
        expect(response._meta?.outputSchemaDigest).toMatch(/^[a-f0-9]{64}$/);
        assertNoSecrets({ response, updates: client.sessionUpdates }, [claude.apiKey]);
      } finally {
        await session.destroy().catch(() => undefined);
        await rm(test.root, { recursive: true, force: true });
      }
    },
    300_000
  );

  it.skipIf(!deepseek)(
    'prints only the validated object from headless text mode',
    async () => {
      if (!deepseek) throw new Error('DeepSeek qualification channel is unavailable');
      const test = await fixture('blade-structured-headless-');
      const sessionId = `structured-headless-${Date.now()}`;
      const stdout: string[] = [];
      const stderr: string[] = [];
      try {
        configure(deepseek, test.storageRoot);
        const previousCwd = process.cwd();
        process.chdir(test.workspace);
        try {
          const exitCode = await runHeadless(
            {
              headless: true,
              sessionId,
              message:
                'Return the requested structured result. Set surface to headless, ' +
                'ok to true, and provide a short summary.' +
                OMIT_NOTE_INSTRUCTION,
              permissionMode: PermissionMode.YOLO,
              jsonSchema: JSON.stringify(outputSchema),
              outputFormat: 'text',
            },
            {
              stdout: {
                write: (chunk) => {
                  stdout.push(chunk);
                },
              },
              stderr: {
                write: (chunk) => {
                  stderr.push(chunk);
                },
              },
            }
          );
          expect(exitCode, stderr.join('')).toBe(0);
        } finally {
          process.chdir(previousCwd);
        }
        const output = JSON.parse(stdout.join('').trim()) as Record<string, unknown>;
        expect(output).toMatchObject({
          surface: 'headless',
          ok: true,
          summary: expect.any(String),
        });
        expectNoNullValues(output);
        // DeepSeek enforces strict tool schemas, so the optional note arrives as
        // null. Headless resolves its workspace from Blade's cwd state rather
        // than process.chdir, so locate the transcript by Session ID inside the
        // isolated storage root.
        expectAcceptedOnFirstSubmission(await SessionService.loadSession(sessionId));
        assertNoSecrets({ output: stdout, diagnostics: stderr }, [deepseek.apiKey]);
      } finally {
        await rm(test.root, { recursive: true, force: true });
      }
    },
    300_000
  );
});
