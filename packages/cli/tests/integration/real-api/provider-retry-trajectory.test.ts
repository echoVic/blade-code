import { execFile } from 'node:child_process';
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SessionRuntime } from '../../../src/agent/runtime/SessionRuntime.js';
import { AgentSessionStore } from '../../../src/agent/subagents/AgentSessionStore.js';
import { BackgroundAgentManager } from '../../../src/agent/subagents/BackgroundAgentManager.js';
import { runHeadless } from '../../../src/commands/headless.js';
import { HeadlessJsonlEventSchema } from '../../../src/commands/headlessEvents.js';
import { PermissionMode, type RuntimeConfig } from '../../../src/config/types.js';
import {
  PersistentStore,
  PROCESS_RESTART_TOOL_RESULT,
} from '../../../src/context/storage/PersistentStore.js';
import { getProjectStoragePath } from '../../../src/context/storage/pathUtils.js';
import { SessionService } from '../../../src/services/SessionService.js';
import { getState } from '../../../src/store/vanilla.js';
import { runWithCwdOverride } from '../../../src/utils/cwd.js';
import {
  buildRealApiRuntimeConfig,
  expandDeepSeekModelMatrix,
  getEnabledModelConfigs,
  isRealApiTestEnabled,
} from './testConfig.js';

const execFileAsync = promisify(execFile);
const modelConfig = isRealApiTestEnabled()
  ? expandDeepSeekModelMatrix(
      getEnabledModelConfigs().filter((config) => config.id === 'deepseek')
    ).find((config) => config.model.includes('flash'))
  : undefined;
const enabled = modelConfig !== undefined;
const originalStorageRoot = process.env.BLADE_STORAGE_ROOT;
let originalConfig: RuntimeConfig | null = null;

beforeAll(() => {
  if (!enabled) return;
  originalConfig = getState().config.config;
});

afterAll(() => {
  if (originalConfig) getState().config.actions.setConfig(originalConfig);
  if (originalStorageRoot === undefined) {
    delete process.env.BLADE_STORAGE_ROOT;
  } else {
    process.env.BLADE_STORAGE_ROOT = originalStorageRoot;
  }
});

async function readRequestBody(request: import('node:http').IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function waitForValue<T>(
  read: () => Promise<T | undefined>,
  timeoutMs = 120_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

function resetBackgroundAgentState(): void {
  const existing = (
    BackgroundAgentManager as unknown as {
      instance?: BackgroundAgentManager | null;
    }
  ).instance;
  existing?.killAll();
  (
    BackgroundAgentManager as unknown as {
      instance: BackgroundAgentManager | null;
    }
  ).instance = null;
  (
    AgentSessionStore as unknown as {
      instance: AgentSessionStore | null;
    }
  ).instance = null;
}

function upstreamUrl(baseUrl: string, requestUrl: string | undefined): URL {
  const target = new URL(baseUrl);
  const incoming = new URL(requestUrl ?? '/', 'http://127.0.0.1');
  target.pathname = `${target.pathname.replace(/\/$/, '')}/${incoming.pathname.replace(
    /^\//,
    ''
  )}`;
  target.search = incoming.search;
  return target;
}

async function startTransientProxy(baseUrl: string) {
  let requestCount = 0;
  let injectedFailures = 0;
  const privateBodyMarker = 'PRIVATE_PROVIDER_RETRY_BODY_MUST_NOT_SURFACE';
  const server = createServer((request, response) => {
    void (async () => {
      const body = await readRequestBody(request);
      requestCount++;
      if (injectedFailures === 0) {
        injectedFailures++;
        response.writeHead(503, {
          'content-type': 'application/json',
          'retry-after': '0',
        });
        response.end(
          JSON.stringify({
            error: { type: 'server_error', message: privateBodyMarker },
          })
        );
        return;
      }

      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (!value || name === 'host' || name === 'content-length') continue;
        headers.set(name, Array.isArray(value) ? value.join(', ') : value);
      }
      const upstream = await fetch(upstreamUrl(baseUrl, request.url), {
        method: request.method ?? 'POST',
        headers,
        body: request.method === 'GET' || request.method === 'HEAD' ? undefined : body,
        redirect: 'manual',
      });
      const responseHeaders: Record<string, string> = {};
      upstream.headers.forEach((value, name) => {
        if (
          ![
            'connection',
            'content-encoding',
            'content-length',
            'transfer-encoding',
          ].includes(name)
        ) {
          responseHeaders[name] = value;
        }
      });
      response.writeHead(upstream.status, responseHeaders);
      if (upstream.body) {
        const reader = upstream.body.getReader();
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          response.write(Buffer.from(chunk.value));
        }
      }
      response.end();
    })().catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined);
        return;
      }
      response.writeHead(502, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { type: 'proxy_error' } }));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    baseURL: `http://127.0.0.1:${address.port}`,
    privateBodyMarker,
    requestCount: () => requestCount,
    injectedFailures: () => injectedFailures,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

async function startContextLimitProxy(baseUrl: string) {
  let requestCount = 0;
  let injectedFailures = 0;
  const forwardedBodies: string[] = [];
  const privateBodyMarker = 'PRIVATE_CONTEXT_LIMIT_BODY_MUST_NOT_SURFACE';
  const server = createServer((request, response) => {
    void (async () => {
      const body = await readRequestBody(request);
      requestCount++;
      if (injectedFailures === 0) {
        injectedFailures++;
        response.writeHead(413, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            error: {
              type: 'invalid_request_error',
              code: 'context_length_exceeded',
              message: `context_length_exceeded ${privateBodyMarker}`,
            },
          })
        );
        return;
      }
      forwardedBodies.push(body.toString('utf-8'));

      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (!value || name === 'host' || name === 'content-length') continue;
        headers.set(name, Array.isArray(value) ? value.join(', ') : value);
      }
      const upstream = await fetch(upstreamUrl(baseUrl, request.url), {
        method: request.method ?? 'POST',
        headers,
        body: request.method === 'GET' || request.method === 'HEAD' ? undefined : body,
        redirect: 'manual',
      });
      const responseHeaders: Record<string, string> = {};
      upstream.headers.forEach((value, name) => {
        if (
          ![
            'connection',
            'content-encoding',
            'content-length',
            'transfer-encoding',
          ].includes(name)
        ) {
          responseHeaders[name] = value;
        }
      });
      response.writeHead(upstream.status, responseHeaders);
      if (upstream.body) {
        const reader = upstream.body.getReader();
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          response.write(Buffer.from(chunk.value));
        }
      }
      response.end();
    })().catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined);
        return;
      }
      response.writeHead(502, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { type: 'proxy_error' } }));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    baseURL: `http://127.0.0.1:${address.port}`,
    privateBodyMarker,
    requestCount: () => requestCount,
    injectedFailures: () => injectedFailures,
    forwardedBodies: () => [...forwardedBodies],
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

function isContentFrame(frame: string): boolean {
  for (const line of frame.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice('data:'.length).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const parsed = JSON.parse(payload) as {
        choices?: Array<{ delta?: { content?: unknown } }>;
      };
      if (
        parsed.choices?.some(
          (choice) =>
            typeof choice.delta?.content === 'string' && choice.delta.content.length > 0
        )
      ) {
        return true;
      }
    } catch {
      // Non-JSON SSE metadata is forwarded unchanged.
    }
  }
  return false;
}

async function startMidStreamStallProxy(baseUrl: string, delayMs: number) {
  let requestCount = 0;
  let injectedStalls = 0;
  const server = createServer((request, response) => {
    void (async () => {
      const body = await readRequestBody(request);
      requestCount++;
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (!value || name === 'host' || name === 'content-length') continue;
        headers.set(name, Array.isArray(value) ? value.join(', ') : value);
      }
      const upstream = await fetch(upstreamUrl(baseUrl, request.url), {
        method: request.method ?? 'POST',
        headers,
        body: request.method === 'GET' || request.method === 'HEAD' ? undefined : body,
        redirect: 'manual',
      });
      const responseHeaders: Record<string, string> = {};
      upstream.headers.forEach((value, name) => {
        if (
          ![
            'connection',
            'content-encoding',
            'content-length',
            'transfer-encoding',
          ].includes(name)
        ) {
          responseHeaders[name] = value;
        }
      });
      response.writeHead(upstream.status, responseHeaders);
      if (!upstream.body) {
        response.end();
        return;
      }

      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      let buffered = '';
      for (;;) {
        const chunk = await reader.read();
        buffered += decoder.decode(chunk.value, { stream: !chunk.done });
        let boundary = buffered.indexOf('\n\n');
        while (boundary >= 0) {
          const frame = buffered.slice(0, boundary);
          buffered = buffered.slice(boundary + 2);
          response.write(`${frame}\n\n`);
          if (injectedStalls === 0 && isContentFrame(frame)) {
            injectedStalls++;
            await new Promise((resolve) => setTimeout(resolve, delayMs));
          }
          boundary = buffered.indexOf('\n\n');
        }
        if (chunk.done) break;
      }
      if (buffered) response.write(buffered);
      response.end();
    })().catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined);
        return;
      }
      response.writeHead(502, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { type: 'proxy_error' } }));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    baseURL: `http://127.0.0.1:${address.port}`,
    requestCount: () => requestCount,
    injectedStalls: () => injectedStalls,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

describe.skipIf(!enabled)('Provider retry trajectory (real API)', () => {
  it.skipIf(process.platform === 'win32')(
    'reaps a real-API background shell after its Blade owner hard-exits',
    async () => {
      if (!modelConfig) throw new Error('DeepSeek Flash configuration is required');
      const childProcess =
        await vi.importActual<typeof import('node:child_process')>(
          'node:child_process'
        );
      const workspace = await mkdtemp(
        path.join(os.tmpdir(), 'blade-real-api-orphan-shell-')
      );
      const storageRoot = path.join(workspace, '.blade-storage');
      const sessionId = `real-api-orphan-shell-${Date.now()}`;
      const fixture = path.join(
        import.meta.dirname,
        '..',
        '..',
        'fixtures',
        'run-real-api-background-shell.ts'
      );
      let stdout = '';
      let stderr = '';
      let rootPid: number | undefined;
      let runtime: SessionRuntime | undefined;
      const previousStorageRoot = process.env.BLADE_STORAGE_ROOT;
      const runtimeConfig = buildRealApiRuntimeConfig(modelConfig);
      process.env.BLADE_STORAGE_ROOT = storageRoot;
      getState().config.actions.setConfig({
        ...runtimeConfig,
        permissionMode: PermissionMode.YOLO,
      });
      const child = childProcess.spawn(
        process.env.BUN_EXEC_PATH ?? 'bun',
        [fixture, workspace, storageRoot, sessionId, modelConfig.qualificationId],
        {
          cwd: workspace,
          env: {
            ...process.env,
            BLADE_STORAGE_ROOT: storageRoot,
            BLADE_TELEMETRY_DISABLED: '1',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      );
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
      });
      const childClosed = new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      });

      try {
        const leaseRoot = path.join(
          getProjectStoragePath(workspace),
          '.background-shells'
        );
        const launched = await Promise.race([
          waitForValue(async () => {
            try {
              const value = Number.parseInt(
                await readFile(path.join(workspace, 'orphan-root.pid'), 'utf8'),
                10
              );
              const leaseNames = await readdir(leaseRoot, { recursive: true });
              const leaseName = leaseNames.find((name) => name.endsWith('.json'));
              return Number.isSafeInteger(value) && value > 1 && leaseName
                ? { rootPid: value, leaseName }
                : undefined;
            } catch {
              return undefined;
            }
          }),
          childClosed.then((status) => {
            throw new Error(
              `Real API shell owner exited before launch (${status}): ${stderr}`
            );
          }),
        ]);
        rootPid = launched.rootPid;

        expect(child.kill('SIGKILL')).toBe(true);
        await childClosed;
        expect(() => process.kill(rootPid!, 0)).not.toThrow();
        expect(stdout).toContain('"tool_name":"Bash"');

        const leaseContents = await readFile(
          path.join(leaseRoot, launched.leaseName),
          'utf8'
        );
        expect(leaseContents).not.toContain('orphan-root.pid');
        expect(leaseContents).not.toContain('DEEPSEEK_API_KEY');
        expect(leaseContents).not.toContain(modelConfig.apiKey);

        runtime = await runWithCwdOverride(workspace, () =>
          SessionRuntime.create({
            sessionId,
            workspaceRoot: workspace,
            modelId: runtimeConfig.currentModelId,
            permissionMode: PermissionMode.YOLO,
          })
        );
        await waitForValue(async () => {
          try {
            process.kill(rootPid!, 0);
            return undefined;
          } catch {
            return true;
          }
        }, 10_000);
        expect(`${stdout}\n${stderr}`).not.toContain(modelConfig.apiKey);
      } finally {
        child.kill('SIGKILL');
        await runtime?.dispose().catch(() => undefined);
        if (rootPid) {
          try {
            process.kill(-rootPid, 'SIGKILL');
          } catch {
            // The durable orphan reaper already terminated the process group.
          }
        }
        if (previousStorageRoot === undefined) delete process.env.BLADE_STORAGE_ROOT;
        else process.env.BLADE_STORAGE_ROOT = previousStorageRoot;
        await rm(workspace, { recursive: true, force: true });
      }
    },
    180_000
  );

  it.skipIf(process.platform === 'win32')(
    'stops a real-API leaderless foreground group before its delayed side effect',
    async () => {
      if (!modelConfig) throw new Error('DeepSeek Flash configuration is required');
      const childProcess =
        await vi.importActual<typeof import('node:child_process')>(
          'node:child_process'
        );
      const workspace = await mkdtemp(
        path.join(os.tmpdir(), 'blade-real-api-foreground-shell-')
      );
      const storageRoot = path.join(workspace, '.blade-storage');
      const sessionId = `real-api-foreground-shell-${Date.now()}`;
      const fixture = path.join(
        import.meta.dirname,
        '..',
        '..',
        'fixtures',
        'run-real-api-foreground-shell.ts'
      );
      const previousStorageRoot = process.env.BLADE_STORAGE_ROOT;
      const runtimeConfig = buildRealApiRuntimeConfig(modelConfig);
      let stdout = '';
      let stderr = '';
      let commandPid: number | undefined;
      let gatePid: number | undefined;
      let runtime: SessionRuntime | undefined;
      process.env.BLADE_STORAGE_ROOT = storageRoot;
      getState().config.actions.setConfig({
        ...runtimeConfig,
        permissionMode: PermissionMode.YOLO,
      });
      const child = childProcess.spawn(
        process.env.BUN_EXEC_PATH ?? 'bun',
        [fixture, workspace, storageRoot, sessionId, modelConfig.qualificationId],
        {
          cwd: workspace,
          env: {
            ...process.env,
            BLADE_STORAGE_ROOT: storageRoot,
            BLADE_TELEMETRY_DISABLED: '1',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      );
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
      });
      const childClosed = new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      });

      try {
        const leaseRoot = path.join(
          getProjectStoragePath(workspace),
          '.foreground-processes'
        );
        const launched = await Promise.race([
          waitForValue(async () => {
            try {
              const value = Number.parseInt(
                await readFile(path.join(workspace, 'foreground-root.pid'), 'utf8'),
                10
              );
              const leaseNames = await readdir(leaseRoot, { recursive: true });
              const leaseName = leaseNames.find((name) => name.endsWith('.json'));
              if (!Number.isSafeInteger(value) || value <= 1 || !leaseName) {
                return undefined;
              }
              const leaseContents = await readFile(
                path.join(leaseRoot, leaseName),
                'utf8'
              );
              const lease = JSON.parse(leaseContents) as { rootPid: number };
              return {
                commandPid: value,
                gatePid: lease.rootPid,
                leaseContents,
              };
            } catch {
              return undefined;
            }
          }),
          childClosed.then((status) => {
            const output = `${stdout}\n${stderr}`
              .replaceAll(modelConfig.apiKey, '[redacted]')
              .slice(-4_000);
            throw new Error(
              `Real API foreground owner exited before launch (${status}): ${output}`
            );
          }),
        ]);
        const commandStartedAt = Date.now();
        commandPid = launched.commandPid;
        gatePid = launched.gatePid;
        expect(launched.leaseContents).not.toContain('foreground-root.pid');
        expect(launched.leaseContents).not.toContain('forbidden-late-effect');
        expect(launched.leaseContents).not.toContain('DEEPSEEK_API_KEY');
        expect(launched.leaseContents).not.toContain(modelConfig.apiKey);
        expect(stdout).toContain('"tool_name":"Bash"');
        await writeFile(
          path.join(workspace, 'foreground-gate.release'),
          'release',
          'utf8'
        );
        await waitForValue(async () => {
          try {
            process.kill(gatePid!, 0);
            return undefined;
          } catch {
            return true;
          }
        }, 10_000);
        expect(() => process.kill(commandPid!, 0)).not.toThrow();

        expect(child.kill('SIGKILL')).toBe(true);
        await childClosed;
        runtime = await runWithCwdOverride(workspace, () =>
          SessionRuntime.create({
            sessionId,
            workspaceRoot: workspace,
            modelId: runtimeConfig.currentModelId,
            permissionMode: PermissionMode.YOLO,
          })
        );
        await waitForValue(async () => {
          try {
            process.kill(commandPid!, 0);
            return undefined;
          } catch {
            return true;
          }
        }, 10_000);

        const remainingDelay = 5_500 - (Date.now() - commandStartedAt);
        if (remainingDelay > 0) {
          await new Promise((resolve) => setTimeout(resolve, remainingDelay));
        }
        await expect(
          access(path.join(workspace, 'forbidden-late-effect.txt'))
        ).rejects.toMatchObject({ code: 'ENOENT' });

        const store = new PersistentStore(workspace);
        await store.initialize();
        const events = await store.loadEvents(sessionId);
        const bashCall = events?.find(
          (event) =>
            event.type === 'part_created' &&
            event.data.partType === 'tool_call' &&
            event.data.payload !== null &&
            typeof event.data.payload === 'object' &&
            !Array.isArray(event.data.payload) &&
            event.data.payload.toolName === 'Bash'
        );
        expect(bashCall?.type).toBe('part_created');
        expect(
          events?.some(
            (event) =>
              event.type === 'part_created' &&
              event.data.partType === 'tool_result' &&
              event.data.partId ===
                (bashCall?.type === 'part_created'
                  ? bashCall.data.partId
                  : undefined) &&
              event.data.payload !== null &&
              typeof event.data.payload === 'object' &&
              !Array.isArray(event.data.payload) &&
              event.data.payload.error === PROCESS_RESTART_TOOL_RESULT
          )
        ).toBe(true);
        expect(`${stdout}\n${stderr}`).not.toContain(modelConfig.apiKey);
      } finally {
        child.kill('SIGKILL');
        await runtime?.dispose().catch(() => undefined);
        for (const pid of [gatePid, commandPid]) {
          if (!pid) continue;
          try {
            process.kill(-pid, 'SIGKILL');
          } catch {
            try {
              process.kill(pid, 'SIGKILL');
            } catch {
              // The durable orphan reaper already terminated the process.
            }
          }
        }
        if (previousStorageRoot === undefined) delete process.env.BLADE_STORAGE_ROOT;
        else process.env.BLADE_STORAGE_ROOT = previousStorageRoot;
        await rm(workspace, { recursive: true, force: true });
      }
    },
    180_000
  );

  it.skipIf(process.platform === 'win32')(
    'reaps a hard-killed real-API subagent foreground shell',
    async () => {
      if (!modelConfig) throw new Error('DeepSeek Flash configuration is required');
      const childProcess =
        await vi.importActual<typeof import('node:child_process')>(
          'node:child_process'
        );
      const workspace = await mkdtemp(
        path.join(os.tmpdir(), 'blade-real-api-subagent-shell-')
      );
      const storageRoot = path.join(workspace, '.blade-storage');
      const parentSessionId = `subagent-shell-parent-${Date.now()}`;
      const sourceAgentId = `agent-subagent-shell-${Date.now()}`;
      const fixture = path.join(
        import.meta.dirname,
        '..',
        '..',
        'fixtures',
        'run-real-api-crashing-subagent-shell.ts'
      );
      const runtimeConfig = buildRealApiRuntimeConfig(modelConfig);
      const previousStorageRoot = process.env.BLADE_STORAGE_ROOT;
      let stdout = '';
      let stderr = '';
      let commandPid: number | undefined;
      let gatePid: number | undefined;
      let runtime: SessionRuntime | undefined;
      let child: import('node:child_process').ChildProcess | undefined;

      try {
        process.env.BLADE_STORAGE_ROOT = storageRoot;
        resetBackgroundAgentState();
        getState().config.actions.setConfig({
          ...runtimeConfig,
          permissionMode: PermissionMode.YOLO,
        });
        child = childProcess.spawn(
          process.env.BUN_EXEC_PATH ?? 'bun',
          [
            fixture,
            workspace,
            storageRoot,
            parentSessionId,
            sourceAgentId,
            modelConfig.qualificationId,
          ],
          {
            cwd: workspace,
            env: {
              ...process.env,
              BLADE_STORAGE_ROOT: storageRoot,
              BLADE_TELEMETRY_DISABLED: '1',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
          }
        );
        child.stdout?.setEncoding('utf8');
        child.stderr?.setEncoding('utf8');
        child.stdout?.on('data', (chunk: string) => {
          stdout += chunk;
        });
        child.stderr?.on('data', (chunk: string) => {
          stderr += chunk;
        });
        const childClosed = new Promise<number | null>((resolve, reject) => {
          child?.once('error', reject);
          child?.once('close', resolve);
        });
        const launched = await Promise.race([
          waitForValue(async () => {
            for (const line of stdout.split('\n')) {
              try {
                const value = JSON.parse(line) as {
                  commandPid?: unknown;
                  leaseName?: unknown;
                };
                if (
                  Number.isSafeInteger(value.commandPid) &&
                  Number(value.commandPid) > 1 &&
                  typeof value.leaseName === 'string'
                ) {
                  return {
                    commandPid: Number(value.commandPid),
                    leaseName: value.leaseName,
                  };
                }
              } catch {
                // Ignore non-JSON progress lines.
              }
            }
            return undefined;
          }),
          childClosed.then((status) => {
            throw new Error(
              `Real API subagent shell owner exited before launch (${status}): ` +
                stderr
            );
          }),
        ]);
        const commandStartedAt = Date.now();
        commandPid = launched.commandPid;
        const leasePath = path.join(
          getProjectStoragePath(workspace),
          '.foreground-processes',
          launched.leaseName
        );
        const leaseContents = await readFile(leasePath, 'utf8');
        gatePid = (JSON.parse(leaseContents) as { rootPid: number }).rootPid;
        expect(leaseContents).not.toContain('child-foreground.pid');
        expect(leaseContents).not.toContain('forbidden-child-late-effect');
        expect(leaseContents).not.toContain(modelConfig.apiKey);

        expect(child.kill('SIGKILL')).toBe(true);
        await childClosed;
        resetBackgroundAgentState();
        runtime = await runWithCwdOverride(workspace, () =>
          SessionRuntime.create({
            sessionId: parentSessionId,
            workspaceRoot: workspace,
            modelId: runtimeConfig.currentModelId,
            permissionMode: PermissionMode.YOLO,
          })
        );
        await waitForValue(async () => {
          try {
            process.kill(commandPid!, 0);
            return undefined;
          } catch {
            return true;
          }
        }, 10_000);
        const remainingDelay = 5_500 - (Date.now() - commandStartedAt);
        if (remainingDelay > 0) {
          await new Promise((resolve) => setTimeout(resolve, remainingDelay));
        }
        await expect(
          access(path.join(workspace, 'forbidden-child-late-effect.txt'))
        ).rejects.toMatchObject({ code: 'ENOENT' });
        expect(
          AgentSessionStore.getInstance().loadSession(sourceAgentId)
        ).toMatchObject({
          status: 'failed',
          restartRecovery: { outcome: 'interrupted' },
        });

        const store = new PersistentStore(workspace);
        await store.initialize();
        const events = await store.loadEvents(sourceAgentId);
        expect(
          events?.some(
            (event) =>
              event.type === 'part_created' &&
              event.data.partType === 'tool_result' &&
              event.data.payload !== null &&
              typeof event.data.payload === 'object' &&
              !Array.isArray(event.data.payload) &&
              event.data.payload.error === PROCESS_RESTART_TOOL_RESULT
          )
        ).toBe(true);
        expect(`${stdout}\n${stderr}`).not.toContain(modelConfig.apiKey);
      } finally {
        child?.kill('SIGKILL');
        await runtime?.dispose().catch(() => undefined);
        resetBackgroundAgentState();
        for (const pid of [gatePid, commandPid]) {
          if (!pid) continue;
          try {
            process.kill(-pid, 'SIGKILL');
          } catch {
            try {
              process.kill(pid, 'SIGKILL');
            } catch {
              // The child reconciliation already terminated the process.
            }
          }
        }
        if (previousStorageRoot === undefined) delete process.env.BLADE_STORAGE_ROOT;
        else process.env.BLADE_STORAGE_ROOT = previousStorageRoot;
        await rm(workspace, { recursive: true, force: true });
      }
    },
    180_000
  );

  it.skipIf(process.platform === 'win32')(
    'recovers a hard-killed real-API subagent transcript before immutable resume',
    async () => {
      if (!modelConfig) throw new Error('DeepSeek Flash configuration is required');
      const childProcess =
        await vi.importActual<typeof import('node:child_process')>(
          'node:child_process'
        );
      const workspace = await mkdtemp(
        path.join(os.tmpdir(), 'blade-real-api-subagent-crash-')
      );
      const storageRoot = path.join(workspace, '.blade-storage');
      const parentSessionId = `subagent-crash-parent-${Date.now()}`;
      const sourceAgentId = `agent-subagent-crash-${Date.now()}`;
      const token = `crash-module-${Date.now()}`;
      const fixture = path.join(
        import.meta.dirname,
        '..',
        '..',
        'fixtures',
        'run-real-api-crashing-subagent.ts'
      );
      const proxy = await startMidStreamStallProxy(
        modelConfig.baseURL ?? 'https://api.deepseek.com',
        10_000
      );
      const runtimeConfig = buildRealApiRuntimeConfig(modelConfig);
      const previousStorageRoot = process.env.BLADE_STORAGE_ROOT;
      let stdout = '';
      let stderr = '';
      let runtime: SessionRuntime | undefined;
      let child: import('node:child_process').ChildProcess | undefined;

      try {
        process.env.BLADE_STORAGE_ROOT = storageRoot;
        resetBackgroundAgentState();
        getState().config.actions.setConfig({
          ...runtimeConfig,
          permissionMode: PermissionMode.YOLO,
        });
        child = childProcess.spawn(
          process.env.BUN_EXEC_PATH ?? 'bun',
          [
            fixture,
            workspace,
            storageRoot,
            parentSessionId,
            sourceAgentId,
            modelConfig.qualificationId,
            token,
            proxy.baseURL,
          ],
          {
            cwd: workspace,
            env: {
              ...process.env,
              BLADE_STORAGE_ROOT: storageRoot,
              BLADE_TELEMETRY_DISABLED: '1',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
          }
        );
        child.stdout?.setEncoding('utf8');
        child.stderr?.setEncoding('utf8');
        child.stdout?.on('data', (chunk: string) => {
          stdout += chunk;
        });
        child.stderr?.on('data', (chunk: string) => {
          stderr += chunk;
        });
        const childClosed = new Promise<number | null>((resolve, reject) => {
          child?.once('error', reject);
          child?.once('close', resolve);
        });
        await Promise.race([
          waitForValue(async () =>
            stdout.includes('SUBAGENT_STREAM_STARTED') ? true : undefined
          ),
          childClosed.then((status) => {
            throw new Error(
              `Real API subagent owner exited before streaming (${status}): ${stderr}`
            );
          }),
        ]);
        expect(child.kill('SIGKILL')).toBe(true);
        await childClosed;
        expect(proxy.injectedStalls()).toBe(1);

        resetBackgroundAgentState();
        runtime = await runWithCwdOverride(workspace, () =>
          SessionRuntime.create({
            sessionId: parentSessionId,
            workspaceRoot: workspace,
            modelId: runtimeConfig.currentModelId,
            permissionMode: PermissionMode.YOLO,
          })
        );
        const source = AgentSessionStore.getInstance().loadSession(sourceAgentId);
        expect(source).toMatchObject({
          status: 'failed',
          restartRecovery: { outcome: 'interrupted' },
        });
        expect(JSON.stringify(source?.messages)).toContain(token);

        const resumed = runtime.resumeSubagent({
          agentId: sourceAgentId,
          prompt:
            'What private module codename did I ask you to remember? ' +
            'Reply with the codename only and do not use tools.',
        });
        const completed = await BackgroundAgentManager.getInstance().waitForCompletion(
          resumed.session.id,
          180_000,
          {
            sessionId: parentSessionId,
            projectPath: workspace,
          }
        );
        expect(completed).toMatchObject({
          status: 'completed',
          resumedFrom: sourceAgentId,
          rootAgentId: sourceAgentId,
          resumeDepth: 1,
        });
        expect(completed?.id).not.toBe(sourceAgentId);
        expect(completed?.result?.message).toContain(token);
        expect(`${stdout}\n${stderr}\n${JSON.stringify(completed)}`).not.toContain(
          modelConfig.apiKey
        );
      } finally {
        child?.kill('SIGKILL');
        await runtime?.dispose().catch(() => undefined);
        resetBackgroundAgentState();
        await proxy.close();
        if (previousStorageRoot === undefined) delete process.env.BLADE_STORAGE_ROOT;
        else process.env.BLADE_STORAGE_ROOT = previousStorageRoot;
        await rm(workspace, { recursive: true, force: true });
      }
    },
    240_000
  );

  it('recovers one coding turn from an injected pre-stream 503', async () => {
    if (!modelConfig) throw new Error('DeepSeek Flash configuration is required');
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'blade-provider-retry-'));
    const proxy = await startTransientProxy(
      modelConfig.baseURL ?? 'https://api.deepseek.com'
    );
    let output = '';
    let errorOutput = '';

    try {
      process.env.BLADE_STORAGE_ROOT = path.join(workspace, '.blade-storage');
      getState().config.actions.setConfig({
        ...buildRealApiRuntimeConfig({ ...modelConfig, baseURL: proxy.baseURL }),
        permissionMode: PermissionMode.YOLO,
      });
      await mkdir(path.join(workspace, 'src'), { recursive: true });
      await mkdir(path.join(workspace, 'test'), { recursive: true });
      await writeFile(
        path.join(workspace, 'package.json'),
        `${JSON.stringify({
          name: 'blade-provider-retry-fixture',
          private: true,
          type: 'module',
          scripts: { test: 'node --test' },
        })}\n`
      );
      await writeFile(
        path.join(workspace, 'src', 'add.js'),
        'export function add(left, right) {\n  return left - right;\n}\n'
      );
      await writeFile(
        path.join(workspace, 'test', 'add.test.js'),
        [
          "import assert from 'node:assert/strict';",
          "import test from 'node:test';",
          "import { add } from '../src/add.js';",
          '',
          "test('adds two numbers', () => {",
          '  assert.equal(add(4, 3), 7);',
          '});',
          '',
        ].join('\n')
      );

      const exitCode = await runWithCwdOverride(workspace, () =>
        runHeadless(
          {
            headless: true,
            outputFormat: 'jsonl',
            maxTurns: 12,
            allowedTools: ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash'],
            appendSystemPrompt:
              'After editing the source, call Bash with exactly "npm test".',
            message:
              'Read src/add.js and test/add.test.js. Fix only src/add.js so ' +
              'add(4, 3) returns 7, then call Bash with exactly "npm test".',
          },
          {
            stdout: {
              write(chunk: string) {
                output += chunk;
                return true;
              },
            },
            stderr: {
              write(chunk: string) {
                errorOutput += chunk;
                return true;
              },
            },
          }
        )
      );
      const events = output
        .split('\n')
        .filter(Boolean)
        .map((line) => HeadlessJsonlEventSchema.parse(JSON.parse(line)));
      const retryEvents = events.filter((event) => event.type === 'provider_retry');
      const mutationStarts = events.filter(
        (event) =>
          event.type === 'tool_start' &&
          (event.tool_name === 'Edit' || event.tool_name === 'Write')
      );

      expect(exitCode, errorOutput.replaceAll(modelConfig.apiKey, '[redacted]')).toBe(
        0
      );
      expect(proxy.injectedFailures()).toBe(1);
      expect(proxy.requestCount()).toBeGreaterThanOrEqual(2);
      expect(retryEvents.slice(0, 3).map((event) => event.phase)).toEqual([
        'scheduled',
        'attempt',
        'recovered',
      ]);
      expect(retryEvents[0]).toMatchObject({
        attempt: 1,
        max_retries: 12,
        reason: 'server_error',
        status_code: 503,
        delay_ms: 0,
        mode: 'bounded_foreground',
        recovery_budget_ms: 600_000,
      });
      expect(mutationStarts).toHaveLength(1);
      expect(
        events.filter(
          (event) => event.type === 'tool_start' && event.tool_name === 'Bash'
        )
      ).toHaveLength(1);
      expect(await readFile(path.join(workspace, 'src', 'add.js'), 'utf8')).toContain(
        'return left + right;'
      );
      const verification = await execFileAsync(process.execPath, ['--test'], {
        cwd: workspace,
        timeout: 30_000,
      });
      expect(verification.stdout).toContain('pass 1');
      expect(`${output}\n${errorOutput}`).not.toContain(proxy.privateBodyMarker);
      expect(`${output}\n${errorOutput}`).not.toContain(modelConfig.apiKey);
    } finally {
      await proxy.close();
      await rm(workspace, { recursive: true, force: true });
    }
  }, 180_000);

  it('durably recovers a context-limit turn and resumes from its checkpoint', async () => {
    if (!modelConfig) throw new Error('DeepSeek Flash configuration is required');
    const workspace = await mkdtemp(
      path.join(os.tmpdir(), 'blade-reactive-compaction-')
    );
    const proxy = await startContextLimitProxy(
      modelConfig.baseURL ?? 'https://api.deepseek.com'
    );
    const sessionId = `real-reactive-compaction-${Date.now()}`;
    const durableMarker = `DURABLE_CONTEXT_MARKER_${process.pid}_${Date.now()}`;
    const acknowledgement = 'REACTIVE_CONTEXT_ACK';
    const resumeInstruction =
      'Return the durable checkpoint marker whose value begins with ' +
      'DURABLE_CONTEXT_MARKER_. Do not return the prior one-time acknowledgement ' +
      `${acknowledgement}. Output only the complete remembered marker.`;
    let output = '';
    let resumeOutput = '';
    let errorOutput = '';

    try {
      process.env.BLADE_STORAGE_ROOT = path.join(workspace, '.blade-storage');
      getState().config.actions.setConfig({
        ...buildRealApiRuntimeConfig({ ...modelConfig, baseURL: proxy.baseURL }),
        permissionMode: PermissionMode.YOLO,
      });

      const exitCode = await runWithCwdOverride(workspace, () =>
        runHeadless(
          {
            headless: true,
            outputFormat: 'jsonl',
            sessionId,
            maxTurns: 1,
            message:
              `The durable checkpoint marker is ${durableMarker}. Preserve that ` +
              'exact value across compaction. It is distinct from the one-time ' +
              `acknowledgement ${acknowledgement}. For this first turn only, reply ` +
              `with exactly ${acknowledgement}. If asked for the durable marker ` +
              'later, never return the acknowledgement.',
          },
          {
            stdout: {
              write(chunk: string) {
                output += chunk;
                return true;
              },
            },
            stderr: {
              write(chunk: string) {
                errorOutput += chunk;
                return true;
              },
            },
          }
        )
      );
      const events = output
        .split('\n')
        .filter(Boolean)
        .map((line) => HeadlessJsonlEventSchema.parse(JSON.parse(line)));
      const compactionEvents = events.filter((event) => event.type === 'compacting');
      const content = events
        .filter((event) => event.type === 'content_delta')
        .map((event) => event.delta)
        .join('');

      expect(exitCode, errorOutput.replaceAll(modelConfig.apiKey, '[redacted]')).toBe(
        0
      );
      expect(proxy.injectedFailures()).toBe(1);
      expect(compactionEvents).toEqual([
        expect.objectContaining({
          state: 'started',
          reason: 'context_limit',
        }),
        expect.objectContaining({
          state: 'completed',
          reason: 'context_limit',
          strategy: 'llm',
          outcome: 'completed',
          pre_tokens: expect.any(Number),
          post_tokens: expect.any(Number),
        }),
      ]);
      expect(events.filter((event) => event.type === 'provider_retry')).toHaveLength(0);
      expect(content.trim()).toBe(acknowledgement);

      const recoveredContext = await SessionService.loadSessionModelContext(
        sessionId,
        workspace
      );
      expect(
        recoveredContext.some(
          (message) =>
            message.metadata !== null &&
            typeof message.metadata === 'object' &&
            !Array.isArray(message.metadata) &&
            message.metadata.isCompactSummary === true
        )
      ).toBe(true);
      expect(JSON.stringify(recoveredContext)).toContain(durableMarker);

      const resumeExitCode = await runWithCwdOverride(workspace, () =>
        runHeadless(
          {
            headless: true,
            outputFormat: 'jsonl',
            resume: sessionId,
            maxTurns: 1,
            message: resumeInstruction,
          },
          {
            stdout: {
              write(chunk: string) {
                resumeOutput += chunk;
                return true;
              },
            },
            stderr: {
              write(chunk: string) {
                errorOutput += chunk;
                return true;
              },
            },
          }
        )
      );
      const resumeEvents = resumeOutput
        .split('\n')
        .filter(Boolean)
        .map((line) => HeadlessJsonlEventSchema.parse(JSON.parse(line)));
      const resumedContent = resumeEvents
        .filter((event) => event.type === 'content_delta')
        .map((event) => event.delta)
        .join('');

      expect(
        resumeExitCode,
        errorOutput.replaceAll(modelConfig.apiKey, '[redacted]')
      ).toBe(0);
      expect(resumedContent.trim()).toBe(durableMarker);
      expect(proxy.requestCount()).toBeGreaterThanOrEqual(4);
      const resumeRequestBody = proxy
        .forwardedBodies()
        .find((body) => body.includes(resumeInstruction));
      expect(resumeRequestBody).toBeDefined();
      expect(resumeRequestBody).toContain(durableMarker);
      expect(`${output}\n${resumeOutput}\n${errorOutput}`).not.toContain(
        proxy.privateBodyMarker
      );
      expect(`${output}\n${resumeOutput}\n${errorOutput}`).not.toContain(
        modelConfig.apiKey
      );
    } finally {
      await proxy.close();
      await rm(workspace, { recursive: true, force: true });
    }
  }, 180_000);

  it('closes an uncertain tool crash receipt before real API resume', async () => {
    if (!modelConfig) throw new Error('DeepSeek Flash configuration is required');
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'blade-tool-crash-'));
    const sessionId = `real-tool-crash-${Date.now()}`;
    const markerPath = path.join(workspace, 'crash-marker.txt');
    let failedOutput = '';
    let output = '';
    let errorOutput = '';

    try {
      process.env.BLADE_STORAGE_ROOT = path.join(workspace, '.blade-storage');
      getState().config.actions.setConfig({
        ...buildRealApiRuntimeConfig(modelConfig),
        permissionMode: PermissionMode.YOLO,
      });
      const store = new PersistentStore(workspace);
      await store.initialize();
      const resultPersistence = vi
        .spyOn(PersistentStore.prototype, 'saveToolResult')
        .mockRejectedValueOnce(new Error('injected durable result fsync failure'));
      let failedExitCode: number;
      try {
        failedExitCode = await runWithCwdOverride(workspace, () =>
          runHeadless(
            {
              headless: true,
              outputFormat: 'jsonl',
              sessionId,
              maxTurns: 2,
              allowedTools: ['Write'],
              appendSystemPrompt:
                'You must call Write exactly once before responding. Do not use plain text first.',
              message:
                `Call Write exactly once with file_path "${markerPath}" and content ` +
                '"SIDE_EFFECT_ALREADY_APPLIED\\n". If this durable prompt is resumed ' +
                'after a process-restart receipt says the Write side effects are ' +
                'uncertain, inspect crash-marker.txt without modifying it, do not ' +
                'call Write again, and reply exactly TOOL_CRASH_RECEIPT_OK.',
            },
            {
              stdout: {
                write(chunk: string) {
                  failedOutput += chunk;
                  return true;
                },
              },
              stderr: {
                write(chunk: string) {
                  errorOutput += chunk;
                  return true;
                },
              },
            }
          )
        );
      } finally {
        resultPersistence.mockRestore();
      }

      const failedEvents = failedOutput
        .split('\n')
        .filter(Boolean)
        .map((line) => HeadlessJsonlEventSchema.parse(JSON.parse(line)));
      expect(failedExitCode).not.toBe(0);
      expect(
        failedEvents.filter(
          (event) => event.type === 'tool_start' && event.tool_name === 'Write'
        )
      ).toHaveLength(1);
      expect(failedEvents.filter((event) => event.type === 'tool_result')).toHaveLength(
        0
      );
      expect(await readFile(markerPath, 'utf8')).toBe('SIDE_EFFECT_ALREADY_APPLIED\n');

      const interruptedEvents = await store.loadEvents(sessionId);
      const toolCallEvent = interruptedEvents?.find((event) => {
        if (event.type !== 'part_created' || event.data.partType !== 'tool_call') {
          return false;
        }
        const payload = event.data.payload;
        return (
          payload !== null &&
          typeof payload === 'object' &&
          !Array.isArray(payload) &&
          payload.toolName === 'Write'
        );
      });
      if (!toolCallEvent || toolCallEvent.type !== 'part_created') {
        throw new Error('Durable Write call was not committed before execution');
      }
      const toolCallId = toolCallEvent.data.partId;
      expect(
        interruptedEvents?.some(
          (event) =>
            event.type === 'part_created' &&
            event.data.partType === 'tool_result' &&
            event.data.partId === toolCallId
        )
      ).toBe(false);

      const exitCode = await runWithCwdOverride(workspace, () =>
        runHeadless(
          {
            headless: true,
            outputFormat: 'jsonl',
            resume: sessionId,
            maxTurns: 2,
            allowedTools: ['Read', 'Write'],
          },
          {
            stdout: {
              write(chunk: string) {
                output += chunk;
                return true;
              },
            },
            stderr: {
              write(chunk: string) {
                errorOutput += chunk;
                return true;
              },
            },
          },
          { stdin: Readable.from([]) as NodeJS.ReadStream }
        )
      );
      const events = output
        .split('\n')
        .filter(Boolean)
        .map((line) => HeadlessJsonlEventSchema.parse(JSON.parse(line)));
      const content = events
        .filter((event) => event.type === 'content_delta')
        .map((event) => event.delta)
        .join('');

      expect(exitCode, errorOutput.replaceAll(modelConfig.apiKey, '[redacted]')).toBe(
        0
      );
      expect(content).toContain('TOOL_CRASH_RECEIPT_OK');
      expect(await readFile(markerPath, 'utf8')).toBe('SIDE_EFFECT_ALREADY_APPLIED\n');
      expect(
        events.filter(
          (event) =>
            event.type === 'tool_start' &&
            ['Write', 'Edit'].includes(event.tool_name ?? '')
        )
      ).toHaveLength(0);
      expect(`${output}\n${errorOutput}`).not.toContain(modelConfig.apiKey);

      const recoveredEvents = await store.loadEvents(sessionId);
      if (!recoveredEvents) {
        throw new Error('Recovered tool crash transcript is missing');
      }
      const receiptIndex = recoveredEvents.findIndex(
        (event) =>
          event.type === 'part_created' &&
          event.data.partType === 'tool_result' &&
          event.data.partId === toolCallId
      );
      const abortIndex = recoveredEvents.findIndex(
        (event) => event.type === 'turn_aborted'
      );
      expect(abortIndex).toBeGreaterThanOrEqual(0);
      expect(receiptIndex).toBeGreaterThan(abortIndex);
      expect(recoveredEvents[receiptIndex]).toMatchObject({
        data: {
          payload: {
            toolCallId,
            toolName: 'Write',
            error: PROCESS_RESTART_TOOL_RESULT,
            metadata: {
              processRestartRecovery: true,
              sideEffectsUncertain: true,
            },
          },
        },
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }, 180_000);

  it('fails closed when a real final response cannot be committed', async () => {
    if (!modelConfig) throw new Error('DeepSeek Flash configuration is required');
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'blade-response-commit-'));
    const sessionId = `real-response-commit-${Date.now()}`;
    const responseMarker = 'RESPONSE_COMMIT_RETRY_OK';
    let failedOutput = '';
    let recoveredOutput = '';
    let errorOutput = '';

    try {
      process.env.BLADE_STORAGE_ROOT = path.join(workspace, '.blade-storage');
      getState().config.actions.setConfig({
        ...buildRealApiRuntimeConfig(modelConfig),
        permissionMode: PermissionMode.YOLO,
      });
      const originalSaveMessage = PersistentStore.prototype.saveMessage;
      let injectedFailures = 0;
      const responsePersistence = vi
        .spyOn(PersistentStore.prototype, 'saveMessage')
        .mockImplementation(async function (
          this: PersistentStore,
          ...args: Parameters<PersistentStore['saveMessage']>
        ) {
          if (args[1] === 'assistant' && injectedFailures === 0) {
            injectedFailures++;
            throw new Error('injected assistant commit failure');
          }
          return originalSaveMessage.apply(this, args);
        });

      let failedExitCode: number;
      try {
        failedExitCode = await runWithCwdOverride(workspace, () =>
          runHeadless(
            {
              headless: true,
              outputFormat: 'jsonl',
              sessionId,
              maxTurns: 1,
              message: `Reply with exactly ${responseMarker} and nothing else.`,
            },
            {
              stdout: {
                write(chunk: string) {
                  failedOutput += chunk;
                  return true;
                },
              },
              stderr: {
                write(chunk: string) {
                  errorOutput += chunk;
                  return true;
                },
              },
            }
          )
        );
      } finally {
        responsePersistence.mockRestore();
      }

      const failedEvents = failedOutput
        .split('\n')
        .filter(Boolean)
        .map((line) => HeadlessJsonlEventSchema.parse(JSON.parse(line)));
      const failedContent = failedEvents
        .filter((event) => event.type === 'content_delta')
        .map((event) => event.delta)
        .join('');
      expect(failedExitCode).not.toBe(0);
      expect(injectedFailures).toBe(1);
      expect(failedContent).toContain(responseMarker);

      const store = new PersistentStore(workspace);
      await store.initialize();
      const failedTranscript = await store.loadEvents(sessionId);
      expect(failedTranscript?.some((event) => event.type === 'turn_aborted')).toBe(
        true
      );
      expect(failedTranscript?.some((event) => event.type === 'turn_completed')).toBe(
        false
      );
      const failedContext = await SessionService.loadSessionModelContext(
        sessionId,
        workspace
      );
      expect(
        JSON.stringify(failedContext.filter((message) => message.role === 'assistant'))
      ).not.toContain(responseMarker);

      const recoveredExitCode = await runWithCwdOverride(workspace, () =>
        runHeadless(
          {
            headless: true,
            outputFormat: 'jsonl',
            resume: sessionId,
            maxTurns: 1,
            message: 'Resume the durable unfinished input before this follow-up.',
          },
          {
            stdout: {
              write(chunk: string) {
                recoveredOutput += chunk;
                return true;
              },
            },
            stderr: {
              write(chunk: string) {
                errorOutput += chunk;
                return true;
              },
            },
          }
        )
      );
      const recoveredEvents = recoveredOutput
        .split('\n')
        .filter(Boolean)
        .map((line) => HeadlessJsonlEventSchema.parse(JSON.parse(line)));
      const recoveredContent = recoveredEvents
        .filter((event) => event.type === 'content_delta')
        .map((event) => event.delta)
        .join('');

      expect(
        recoveredExitCode,
        errorOutput.replaceAll(modelConfig.apiKey, '[redacted]')
      ).toBe(0);
      expect(recoveredContent.trim()).toBe(responseMarker);
      const recoveredContext = await SessionService.loadSessionModelContext(
        sessionId,
        workspace
      );
      const recoveredAssistantContext = JSON.stringify(
        recoveredContext.filter((message) => message.role === 'assistant')
      );
      expect(recoveredAssistantContext).toContain(responseMarker);
      const recoveredTranscript = await store.loadEvents(sessionId);
      expect(
        recoveredTranscript?.filter((event) => event.type === 'turn_completed')
      ).toHaveLength(1);
      expect(`${failedOutput}\n${recoveredOutput}\n${errorOutput}`).not.toContain(
        modelConfig.apiKey
      );
      expect(`${failedOutput}\n${recoveredOutput}\n${errorOutput}`).not.toContain(
        'injected assistant commit failure'
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }, 180_000);

  it('recovers a committed final response without replaying its input', async () => {
    if (!modelConfig) throw new Error('DeepSeek Flash configuration is required');
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'blade-turn-final-'));
    const sessionId = `real-turn-final-${Date.now()}`;
    const firstMarker = 'TURN_FINAL_RECEIPT_COMMITTED';
    const nextMarker = 'TURN_FINAL_NEXT_INPUT_OK';
    let firstOutput = '';
    let nextOutput = '';
    let errorOutput = '';

    try {
      process.env.BLADE_STORAGE_ROOT = path.join(workspace, '.blade-storage');
      getState().config.actions.setConfig({
        ...buildRealApiRuntimeConfig(modelConfig),
        permissionMode: PermissionMode.YOLO,
      });
      const finalizationCrash = vi
        .spyOn(SessionRuntime.prototype, 'finishTurn')
        .mockRejectedValue(new Error('injected crash before turn terminal'));
      let firstExitCode = 1;
      try {
        firstExitCode = await runWithCwdOverride(workspace, () =>
          runHeadless(
            {
              headless: true,
              outputFormat: 'jsonl',
              sessionId,
              maxTurns: 1,
              message: `Reply with exactly ${firstMarker} and nothing else.`,
            },
            {
              stdout: {
                write(chunk: string) {
                  firstOutput += chunk;
                  return true;
                },
              },
              stderr: {
                write(chunk: string) {
                  errorOutput += chunk;
                  return true;
                },
              },
            }
          )
        );
      } catch {
        firstExitCode = 1;
      } finally {
        finalizationCrash.mockRestore();
      }

      const firstEvents = firstOutput
        .split('\n')
        .filter(Boolean)
        .map((line) => HeadlessJsonlEventSchema.parse(JSON.parse(line)));
      const firstContent = firstEvents
        .filter((event) => event.type === 'content_delta')
        .map((event) => event.delta)
        .join('');
      expect(firstExitCode).not.toBe(0);
      expect(firstContent.trim()).toBe(firstMarker);

      const store = new PersistentStore(workspace);
      await store.initialize();
      const interruptedEvents = await store.loadEvents(sessionId);
      expect(
        interruptedEvents?.filter((event) => event.type === 'turn_started')
      ).toHaveLength(1);
      expect(
        interruptedEvents?.some(
          (event) =>
            event.type === 'message_created' &&
            event.data.role === 'assistant' &&
            event.data.metadata !== null &&
            typeof event.data.metadata === 'object' &&
            !Array.isArray(event.data.metadata) &&
            event.data.metadata.turnFinalization !== undefined
        )
      ).toBe(true);
      expect(
        interruptedEvents?.some(
          (event) =>
            event.type === 'turn_completed' ||
            event.type === 'turn_aborted' ||
            event.type === 'inbox_acknowledged'
        )
      ).toBe(false);

      const nextExitCode = await runWithCwdOverride(workspace, () =>
        runHeadless(
          {
            headless: true,
            outputFormat: 'jsonl',
            resume: sessionId,
            maxTurns: 1,
            message: `Reply with exactly ${nextMarker} and nothing else.`,
          },
          {
            stdout: {
              write(chunk: string) {
                nextOutput += chunk;
                return true;
              },
            },
            stderr: {
              write(chunk: string) {
                errorOutput += chunk;
                return true;
              },
            },
          }
        )
      );
      const nextEvents = nextOutput
        .split('\n')
        .filter(Boolean)
        .map((line) => HeadlessJsonlEventSchema.parse(JSON.parse(line)));
      const nextContent = nextEvents
        .filter((event) => event.type === 'content_delta')
        .map((event) => event.delta)
        .join('');

      expect(
        nextExitCode,
        errorOutput.replaceAll(modelConfig.apiKey, '[redacted]')
      ).toBe(0);
      expect(nextContent.trim()).toBe(nextMarker);
      const recoveredEvents = await store.loadEvents(sessionId);
      expect(
        recoveredEvents?.filter((event) => event.type === 'turn_completed')
      ).toHaveLength(2);
      expect(
        recoveredEvents?.filter((event) => event.type === 'turn_aborted')
      ).toHaveLength(0);
      expect(
        nextEvents.filter(
          (event) => event.type === 'content_delta' && event.delta.includes(firstMarker)
        )
      ).toHaveLength(0);
      expect(`${firstOutput}\n${nextOutput}\n${errorOutput}`).not.toContain(
        modelConfig.apiKey
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }, 180_000);

  it('recovers a real mid-stream stall without replaying the request', async () => {
    if (!modelConfig) throw new Error('DeepSeek Flash configuration is required');
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'blade-provider-stall-'));
    const proxy = await startMidStreamStallProxy(
      modelConfig.baseURL ?? 'https://api.deepseek.com',
      7_000
    );
    let output = '';
    let errorOutput = '';

    try {
      process.env.BLADE_STORAGE_ROOT = path.join(workspace, '.blade-storage');
      const runtimeConfig = buildRealApiRuntimeConfig({
        ...modelConfig,
        baseURL: proxy.baseURL,
      });
      getState().config.actions.setConfig({
        ...runtimeConfig,
        permissionMode: PermissionMode.YOLO,
        models: runtimeConfig.models.map((model) => ({
          ...model,
          overrides: {
            ...model.overrides,
            streamIdleTimeout: 12_000,
          },
        })),
      });

      const exitCode = await runWithCwdOverride(workspace, () =>
        runHeadless(
          {
            headless: true,
            outputFormat: 'jsonl',
            maxTurns: 1,
            message: 'Reply with exactly STALL_REAL_API_OK and nothing else.',
          },
          {
            stdout: {
              write(chunk: string) {
                output += chunk;
                return true;
              },
            },
            stderr: {
              write(chunk: string) {
                errorOutput += chunk;
                return true;
              },
            },
          }
        )
      );
      const events = output
        .split('\n')
        .filter(Boolean)
        .map((line) => HeadlessJsonlEventSchema.parse(JSON.parse(line)));
      const stallEvents = events
        .filter((event) => event.type === 'provider_stall')
        .filter((event) => event.output_started);

      expect(exitCode, errorOutput.replaceAll(modelConfig.apiKey, '[redacted]')).toBe(
        0
      );
      expect(proxy.injectedStalls()).toBe(1);
      expect(proxy.requestCount()).toBe(1);
      expect(stallEvents.map((event) => event.phase)).toEqual([
        'detected',
        'recovered',
      ]);
      expect(stallEvents[0]).toMatchObject({
        stall_count: expect.any(Number),
        duration_ms: 6_000,
        warning_after_ms: 6_000,
        timeout_ms: 12_000,
        output_started: true,
      });
      expect(events.filter((event) => event.type === 'provider_retry')).toHaveLength(0);
      expect(
        events
          .filter((event) => event.type === 'content_delta')
          .map((event) => event.delta)
          .join('')
      ).toBe('STALL_REAL_API_OK');
      expect(`${output}\n${errorOutput}`).not.toContain(modelConfig.apiKey);
    } finally {
      await proxy.close();
      await rm(workspace, { recursive: true, force: true });
    }
  }, 180_000);
});
