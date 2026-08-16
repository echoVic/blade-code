import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { HeadlessJsonlEventSchema } from '../../../src/commands/headlessEvents.js';
import {
  captureProcessIdentity,
  type ProcessIdentity,
  processIdentityMatches,
} from '../../../src/utils/process/ProcessIdentity.js';
import { startRecordingProviderProxy } from '../../support/recordingProviderProxy.js';
import { findSessionTranscript } from './sessionForkTrajectoryHarness.js';
import {
  buildRealApiRuntimeConfig,
  expandDeepSeekModelMatrix,
  getEnabledModelConfigs,
  isRealApiTestEnabled,
} from './testConfig.js';

const execFileAsync = promisify(execFile);
const models = isRealApiTestEnabled()
  ? expandDeepSeekModelMatrix(
      getEnabledModelConfigs().filter((config) => config.id === 'deepseek')
    )
  : [];
const surfaces = ['headless', 'pty'] as const;
const controls = models.flatMap((model) =>
  surfaces.map((surface) => ({ model, surface }))
);
const cliEntry = path.resolve(import.meta.dirname, '../../../dist/blade.js');
const ptyRunner = path.resolve(
  import.meta.dirname,
  '../../support/sessionRuntimeResidencyPtyRunner.ts'
);

interface ControlEvidence {
  output: string;
  pid: number;
  identity?: ProcessIdentity;
}

function safeSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function childEnvironment(home: string, storageRoot: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: home,
    BLADE_STORAGE_ROOT: storageRoot,
    BLADE_AUTO_MEMORY: '0',
    BLADE_TELEMETRY_DISABLED: '1',
    TERM: 'xterm-256color',
  };
}

function waitForChildExit(
  child: ChildProcess,
  timeoutMs: number
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Session residency Headless process did not exit'));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      child.off('error', onError);
      child.off('exit', onExit);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      resolve({ code, signal });
    };
    child.once('error', onError);
    child.once('exit', onExit);
  });
}

async function runHeadless(input: {
  workspace: string;
  home: string;
  storageRoot: string;
  sessionId: string;
  prompt: string;
  marker: string;
  resultPath: string;
  secret: string;
}): Promise<ControlEvidence> {
  const child = spawn(
    process.execPath,
    [
      cliEntry,
      '--headless',
      '--output-format',
      'jsonl',
      '--trust-workspace',
      '--permission-mode',
      'yolo',
      '--max-turns',
      '6',
      '--session-id',
      input.sessionId,
      '--allowed-tools',
      'Read,Write',
      '--no-verification-agent',
      input.prompt,
    ],
    {
      cwd: input.workspace,
      env: childEnvironment(input.home, input.storageRoot),
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  const identity = captureProcessIdentity(child.pid ?? -1) ?? undefined;
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk) => {
    stdout = `${stdout}${chunk.toString()}`.slice(-512_000);
  });
  child.stderr?.on('data', (chunk) => {
    stderr = `${stderr}${chunk.toString()}`.slice(-128_000);
  });
  try {
    const exit = await waitForChildExit(child, 180_000);
    const output = `${stdout}\n${stderr}`;
    if (exit.signal || exit.code !== 0) {
      throw new Error(
        `Session residency Headless exited ${
          exit.code ?? exit.signal
        }: ${output.replaceAll(input.secret, '[redacted]')}`
      );
    }
    const events = stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => HeadlessJsonlEventSchema.parse(JSON.parse(line)));
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'phase',
          phase: 'completed',
          status: 'done',
        }),
      ])
    );
    expect(
      events
        .flatMap((event) =>
          event.type === 'content_delta'
            ? [event.delta]
            : event.type === 'content'
              ? [event.content]
              : []
        )
        .join('')
    ).toContain(input.marker);
    expect((await readFile(input.resultPath, 'utf8')).trim()).toBe(input.marker);
    const transcript = await readFile(
      findSessionTranscript(input.storageRoot, input.sessionId),
      'utf8'
    );
    expect(transcript).toContain('"type":"turn_completed"');
    expect(output).not.toContain('Session runtime capacity is full');
    expect(output).not.toContain('resident_runtimes');
    expect(transcript).not.toContain('Session runtime capacity is full');
    expect(transcript).not.toContain('resident_runtimes');
    expect(output).not.toContain(input.secret);
    if (identity) {
      expect(processIdentityMatches(child.pid ?? -1, identity)).toBe(false);
    }
    return { output, pid: child.pid ?? -1, identity };
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await waitForChildExit(child, 10_000).catch(() => undefined);
    }
  }
}

async function runPty(input: {
  workspace: string;
  home: string;
  storageRoot: string;
  sessionId: string;
  prompt: string;
  marker: string;
  resultPath: string;
  secret: string;
}): Promise<ControlEvidence> {
  const encoded = Buffer.from(JSON.stringify({ cliEntry, ...input }), 'utf8').toString(
    'base64'
  );
  try {
    const result = await execFileAsync('bun', [ptyRunner], {
      cwd: path.resolve(import.meta.dirname, '../../..'),
      env: {
        ...process.env,
        BLADE_SESSION_RESIDENCY_PTY_INPUT: encoded,
      },
      timeout: 240_000,
      maxBuffer: 1024 * 1024,
      killSignal: 'SIGKILL',
    });
    const evidence = JSON.parse(result.stdout.trim()) as ControlEvidence & {
      success?: unknown;
      error?: unknown;
    };
    expect(
      evidence.success,
      `${String(evidence.error)}\n${result.stderr.replaceAll(input.secret, '[redacted]')}`
    ).toBe(true);
    return evidence;
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string };
    throw new Error(
      `Session residency PTY runner failed: ${failure.message}\n${
        failure.stdout?.slice(-8_000) ?? ''
      }\n${failure.stderr ?? ''}`.replaceAll(input.secret, '[redacted]'),
      { cause: error }
    );
  }
}

describe
  .skipIf(!isRealApiTestEnabled())
  .sequential('Session Runtime residency single-Runtime controls', () => {
    it.each(
      controls
    )('$model.model completes through $surface at resident limit one', async ({
      model,
      surface,
    }) => {
      if (!model.baseURL) {
        throw new Error(`Missing Provider base URL for ${model.model}`);
      }
      const root = await mkdtemp(
        path.join(
          os.tmpdir(),
          `blade-session-residency-${surface}-${safeSlug(model.model)}-`
        )
      );
      const home = path.join(root, 'home');
      const storageRoot = path.join(root, 'storage');
      const workspace = path.join(root, 'workspace');
      const resultPath = path.join(workspace, 'residency-control.txt');
      const proxy = await startRecordingProviderProxy(model.baseURL);
      const config = buildRealApiRuntimeConfig({
        ...model,
        baseURL: proxy.baseUrl,
      });
      const marker = `SESSION_RESIDENCY_${surface.toUpperCase()}_${safeSlug(
        model.model
      ).toUpperCase()}_${Date.now()}`;
      const sessionId = `residency-${surface}-${safeSlug(model.model)}-${Date.now()}`;
      const prompt =
        `Use the Write tool to create residency-control.txt containing exactly ` +
        `${marker} and a trailing newline. Then reply with exactly ${marker}.`;
      try {
        await Promise.all([
          mkdir(path.join(home, '.blade'), { recursive: true }),
          mkdir(storageRoot, { recursive: true }),
          mkdir(workspace, { recursive: true }),
        ]);
        await writeFile(
          path.join(home, '.blade', 'config.json'),
          `${JSON.stringify(
            {
              currentModelId: config.currentModelId,
              models: config.models,
              modelProviders: config.modelProviders,
              permissionMode: 'yolo',
              maxResidentSessionRuntimes: 1,
              sessionRuntimeIdleMs: 30_000,
              hooks: { enabled: false },
              disableAllHooks: true,
              mcpServers: {},
            },
            null,
            2
          )}\n`,
          { mode: 0o600 }
        );

        const evidence =
          surface === 'headless'
            ? await runHeadless({
                workspace,
                home,
                storageRoot,
                sessionId,
                prompt,
                marker,
                resultPath,
                secret: model.apiKey,
              })
            : await runPty({
                workspace,
                home,
                storageRoot,
                sessionId,
                prompt,
                marker,
                resultPath,
                secret: model.apiKey,
              });

        expect(proxy.requestBodies.length).toBeGreaterThan(0);
        expect(proxy.requestBodies.join('\n')).toContain(marker);
        expect((await readFile(resultPath, 'utf8')).trim()).toBe(marker);
        expect(evidence.output).not.toContain('Session runtime capacity is full');
        expect(evidence.output).not.toContain('resident_runtimes');
        expect(JSON.stringify(evidence)).not.toContain(model.apiKey);
        if (evidence.identity) {
          expect(processIdentityMatches(evidence.pid, evidence.identity)).toBe(false);
        }
      } finally {
        await proxy.close();
        await rm(root, { recursive: true, force: true });
      }
    }, 300_000);
  });
