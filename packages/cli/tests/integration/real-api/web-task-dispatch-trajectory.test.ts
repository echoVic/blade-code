import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { subagentRegistry } from '../../../src/agent/subagents/SubagentRegistry.js';
import {
  BusEventSchema,
  CreateTaskResponseSchema,
  SessionSchema,
  SessionTaskDiffArtifactSchema,
} from '../../../src/api/schemas.js';
import { PermissionMode, type RuntimeConfig } from '../../../src/config/types.js';
import { getSessionInboxFilePath } from '../../../src/context/storage/pathUtils.js';
import { HookManager } from '../../../src/hooks/HookManager.js';
import { parseSchema, type Static, Type } from '../../../src/schema/index.js';
import { BladeServer } from '../../../src/server/server.js';
import { SkillRegistry } from '../../../src/skills/SkillRegistry.js';
import { ensureStoreInitialized, getState } from '../../../src/store/vanilla.js';
import { assertNoSecrets } from './sessionForkTrajectoryHarness.js';
import {
  buildRealApiRuntimeConfig,
  isRealApiTestEnabled,
  resolveForkQualificationModels,
  type TestModelConfig,
} from './testConfig.js';

const execFileAsync = promisify(execFile);
const enabled = isRealApiTestEnabled();
if (enabled && !process.env.DEEPSEEK_API_KEY?.trim()) {
  throw new Error(
    'Web task dispatch qualification requires DeepSeek credentials from the process environment'
  );
}
const modelConfigs = enabled
  ? resolveForkQualificationModels(process.env, { requiredDeepSeek: true }).filter(
      (config) =>
        config.id === 'deepseek' &&
        ['deepseek-v4-flash', 'deepseek-v4-pro'].includes(config.model)
    )
  : [];
if (enabled && modelConfigs.length !== 2) {
  throw new Error(
    'Web task dispatch qualification requires exactly DeepSeek Flash and Pro'
  );
}

const SessionArraySchema = Type.Array(SessionSchema);
type SurfaceEvent = Static<typeof BusEventSchema>;

interface TestServer {
  url: string | URL;
  stop(): Promise<void>;
}

interface TaskEventCollector {
  events: SurfaceEvent[];
  waitFor(
    predicate: (event: SurfaceEvent) => boolean,
    label: string,
    timeoutMs?: number
  ): Promise<SurfaceEvent>;
  close(): Promise<void>;
}

function endpoint(server: TestServer, pathname: string): URL {
  return new URL(pathname.replace(/^\//, ''), server.url);
}

function createRuntimeConfig(modelConfig: TestModelConfig): RuntimeConfig {
  const base = buildRealApiRuntimeConfig(modelConfig);
  return {
    ...base,
    permissionMode: PermissionMode.YOLO,
    allowedTools: ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash'],
    disallowedTools: [],
    hooks: { ...base.hooks, enabled: false },
    disableAllHooks: true,
    mcpEnabled: false,
    mcpServers: {},
    maxConcurrentTasks: 1,
    maxQueuedTasks: 100,
  };
}

async function initializeWorkspace(workspace: string): Promise<string> {
  await mkdir(path.join(workspace, 'src'), { recursive: true });
  await mkdir(path.join(workspace, 'test'), { recursive: true });
  await writeFile(
    path.join(workspace, 'package.json'),
    JSON.stringify(
      {
        name: 'blade-web-task-dispatch-fixture',
        private: true,
        type: 'module',
        scripts: { test: 'node --test' },
      },
      null,
      2
    )
  );
  const source = [
    'export function multiply(left, right) {',
    '  return left + right;',
    '}',
    '',
  ].join('\n');
  await writeFile(path.join(workspace, 'src', 'multiply.js'), source);
  await writeFile(
    path.join(workspace, 'test', 'multiply.test.js'),
    [
      "import assert from 'node:assert/strict';",
      "import test from 'node:test';",
      "import { multiply } from '../src/multiply.js';",
      '',
      "test('multiplies two values', () => {",
      '  assert.equal(multiply(3, 4), 12);',
      '});',
      '',
    ].join('\n')
  );
  await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: workspace });
  await execFileAsync('git', ['config', 'user.email', 'blade@example.test'], {
    cwd: workspace,
  });
  await execFileAsync('git', ['config', 'user.name', 'Blade Test'], {
    cwd: workspace,
  });
  await execFileAsync('git', ['add', '.'], { cwd: workspace });
  await execFileAsync('git', ['commit', '-qm', 'fixture'], { cwd: workspace });
  return source;
}

function initializeIsolatedExtensions(workspace: string, storageRoot: string): void {
  const userSkillsDir = path.join(storageRoot, 'isolated-skills');
  const claudeUserSkillsDir = path.join(storageRoot, 'isolated-claude-skills');
  const projectSkillsDir = path.join(workspace, '.blade', 'skills');
  const claudeProjectSkillsDir = path.join(workspace, '.claude', 'skills');
  const skillCreatorDir = path.join(userSkillsDir, 'skill-creator');
  for (const directory of [
    skillCreatorDir,
    claudeUserSkillsDir,
    projectSkillsDir,
    claudeProjectSkillsDir,
  ]) {
    mkdirSync(directory, { recursive: true });
  }
  writeFileSync(
    path.join(skillCreatorDir, 'SKILL.md'),
    [
      '---',
      'name: skill-creator',
      'description: Local qualification fixture that prevents network installation.',
      '---',
      '',
      '# Fixture Skill Creator',
      '',
      'This fixture is local and deterministic.',
      '',
    ].join('\n')
  );

  SkillRegistry.resetInstance();
  SkillRegistry.getInstance({
    cwd: workspace,
    userSkillsDir,
    claudeUserSkillsDir,
    projectSkillsDir,
    claudeProjectSkillsDir,
  });
  subagentRegistry.clear();
  subagentRegistry.loadBuiltinAgents();
}

async function connectTaskEvents(server: TestServer): Promise<TaskEventCollector> {
  const controller = new AbortController();
  const response = await fetch(endpoint(server, '/events'), {
    signal: controller.signal,
  });
  if (!response.ok || !response.body) {
    throw new Error(`Global task SSE failed with HTTP ${response.status}`);
  }

  const events: SurfaceEvent[] = [];
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let readingError: unknown;
  const consume = (frame: string): void => {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (data) events.push(BusEventSchema.parse(JSON.parse(data)));
  };
  const reading = (async () => {
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        const frames = buffer.split(/\r?\n\r?\n/);
        buffer = frames.pop() ?? '';
        for (const frame of frames) consume(frame);
      }
    } catch (error) {
      if (!controller.signal.aborted) readingError = error;
    }
  })();

  const waitFor = async (
    predicate: (event: SurfaceEvent) => boolean,
    label: string,
    timeoutMs = 240_000
  ): Promise<SurfaceEvent> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const event = events.find(predicate);
      if (event) return event;
      if (readingError) {
        throw new Error(`Global task SSE failed while waiting for ${label}`, {
          cause: readingError,
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(
      `Timed out waiting for ${label}; observed=${events
        .map((event) => `${event.type}:${String(event.properties.taskStatus ?? '')}`)
        .join(',')}`
    );
  };

  await waitFor((event) => event.type === 'connected', 'connected', 10_000);
  return {
    events,
    waitFor,
    close: async () => {
      controller.abort();
      await reader.cancel().catch(() => undefined);
      await reading.catch(() => undefined);
    },
  };
}

async function listTask(
  server: TestServer,
  sessionId: string,
  projectPath: string
): Promise<Static<typeof SessionSchema>> {
  const url = endpoint(server, '/sessions');
  url.searchParams.set('projectPath', projectPath);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`List task sessions failed with HTTP ${response.status}`);
  }
  const sessions = parseSchema(SessionArraySchema, await response.json());
  const session = sessions.find(
    (candidate) =>
      candidate.sessionId === sessionId && candidate.projectPath === projectPath
  );
  if (!session) throw new Error('Dispatched task was not projected by the catalog');
  return session;
}

async function getTaskDiff(server: TestServer, sessionId: string, projectPath: string) {
  const url = endpoint(server, `/tasks/${sessionId}/diff`);
  url.searchParams.set('projectPath', projectPath);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Load task diff failed with HTTP ${response.status}`);
  }
  return SessionTaskDiffArtifactSchema.parse(await response.json());
}

async function deleteTask(
  server: TestServer,
  sessionId: string,
  projectPath: string
): Promise<void> {
  const url = endpoint(server, `/sessions/${sessionId}`);
  url.searchParams.set('projectPath', projectPath);
  const response = await fetch(url, { method: 'DELETE' });
  if (!response.ok) {
    throw new Error(`Delete task session failed with HTTP ${response.status}`);
  }
}

const describeTaskDispatch = enabled ? describe.sequential : describe.skip;

describeTaskDispatch('Web task dispatch trajectory (real API)', () => {
  it.skipIf(enabled)('requires real API qualification', () => undefined);

  for (const modelConfig of modelConfigs) {
    it(`${modelConfig.model} dispatches, isolates, streams, and archives a task`, async () => {
      const fixtureRoot = await mkdtemp(
        path.join(os.tmpdir(), 'blade-web-task-dispatch-')
      );
      const workspace = path.join(fixtureRoot, 'workspace');
      const storageRoot = path.join(fixtureRoot, 'storage');
      await mkdir(workspace, { recursive: true });
      await mkdir(storageRoot, { recursive: true });
      const originalSource = await initializeWorkspace(workspace);
      const originalStorageRoot = process.env.BLADE_STORAGE_ROOT;
      const originalAutoMemory = process.env.BLADE_AUTO_MEMORY;
      const hookManager = HookManager.getInstance();
      const hooksWereEnabled = hookManager.isEnabled();
      let originalConfig: RuntimeConfig | null = null;
      let server: TestServer | undefined;
      let collector: TaskEventCollector | undefined;
      const taskRefs: Array<{ sessionId: string; projectPath: string }> = [];

      try {
        process.env.BLADE_STORAGE_ROOT = storageRoot;
        process.env.BLADE_AUTO_MEMORY = '0';
        hookManager.disable();
        initializeIsolatedExtensions(workspace, storageRoot);
        await ensureStoreInitialized();
        originalConfig = getState().config.config;
        getState().config.actions.setConfig(createRuntimeConfig(modelConfig));
        server = await BladeServer.listenAsync({
          port: 0,
          hostname: '127.0.0.1',
        });
        collector = await connectTaskEvents(server);

        const prompt = [
          'Work only in the task workspace already selected for you.',
          'Read src/multiply.js and test/multiply.test.js.',
          'Fix only src/multiply.js so multiply returns the mathematical product.',
          'Run exactly "npm test" and finish only after it passes.',
          'Do not create or enter another worktree.',
        ].join(' ');
        const response = await fetch(endpoint(server, '/tasks'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            prompt,
            title: 'Fix multiplication',
            projectPath: workspace,
            isolation: 'worktree',
            permissionMode: 'yolo',
          }),
        });
        expect(response.status).toBe(202);
        const accepted = CreateTaskResponseSchema.parse(await response.json());
        const taskRef = {
          sessionId: accepted.session.sessionId,
          projectPath: accepted.session.projectPath,
        };
        taskRefs.push(taskRef);
        expect(accepted).toMatchObject({
          status: 'running',
          runId: expect.any(String),
          messageId: expect.any(String),
          session: {
            title: 'Fix multiplication',
            taskIsolation: 'worktree',
            taskSourceProjectPath: workspace,
            taskWorktreePath: accepted.session.projectPath,
            taskWorktreeBranch: expect.stringMatching(/^blade-worktree-task\+/),
            taskBaseCommit: expect.stringMatching(/^[a-f0-9]{40}$/),
          },
        });
        expect(accepted.session.projectPath).not.toBe(workspace);

        const queuedResponse = await fetch(endpoint(server, '/tasks'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            prompt: [
              'Work only in the task workspace already selected for you.',
              'Read package.json.',
              'Reply with exactly blade-web-task-dispatch-fixture.',
              'Do not edit files and do not enter a worktree.',
            ].join(' '),
            title: 'Read project identity',
            projectPath: workspace,
            isolation: 'local',
            permissionMode: 'yolo',
          }),
        });
        expect(queuedResponse.status).toBe(202);
        const queuedTask = CreateTaskResponseSchema.parse(await queuedResponse.json());
        taskRefs.push({
          sessionId: queuedTask.session.sessionId,
          projectPath: queuedTask.session.projectPath,
        });
        expect(queuedTask).toMatchObject({
          status: 'queued',
          queuePosition: 1,
          queueDepth: 1,
          maxConcurrentTasks: 1,
          session: {
            title: 'Read project identity',
            projectPath: workspace,
            taskStatus: 'queued',
            taskIsolation: 'local',
            taskSourceProjectPath: workspace,
            taskQueuePosition: 1,
            taskQueueDepth: 1,
            taskConcurrencyLimit: 1,
          },
        });
        await collector.waitFor(
          (event) =>
            event.type === 'task.status' &&
            event.properties.sessionId === queuedTask.session.sessionId &&
            event.properties.taskStatus === 'queued' &&
            event.properties.taskQueuePosition === 1 &&
            event.properties.taskQueueDepth === 1,
          'queued task admission'
        );

        const terminalEvent = await collector.waitFor(
          (event) =>
            event.type === 'task.status' &&
            event.properties.sessionId === accepted.session.sessionId &&
            event.properties.projectPath === accepted.session.projectPath &&
            ['completed', 'failed', 'cancelled', 'interrupted'].includes(
              String(event.properties.taskStatus)
            ),
          'terminal task.status',
          300_000
        );
        const taskEvents = collector.events.filter(
          (event) =>
            event.type === 'task.status' &&
            event.properties.sessionId === accepted.session.sessionId &&
            event.properties.projectPath === accepted.session.projectPath
        );
        if (terminalEvent.properties.taskStatus !== 'completed') {
          const failedTask = await listTask(
            server,
            accepted.session.sessionId,
            accepted.session.projectPath
          );
          throw new Error(
            `Web task failed: ${JSON.stringify({
              status: terminalEvent.properties.taskStatus,
              reason:
                terminalEvent.properties.taskStatusReason ??
                failedTask.taskStatusReason,
              diffStat:
                terminalEvent.properties.taskDiffStat ?? failedTask.taskDiffStat,
              statuses: taskEvents.map((event) => event.properties.taskStatus),
            })}`
          );
        }
        expect(taskEvents.map((event) => event.properties.taskStatus)).toEqual(
          expect.arrayContaining(['queued', 'running', 'completed'])
        );
        expect(terminalEvent.properties.taskDiffStat).toMatchObject({
          changedFiles: 1,
          commits: 0,
        });
        expect(JSON.stringify(terminalEvent.properties)).not.toContain(
          'repositoryRoot'
        );
        await collector.waitFor(
          (event) =>
            event.type === 'task.status' &&
            event.properties.sessionId === queuedTask.session.sessionId &&
            event.properties.projectPath === queuedTask.session.projectPath &&
            event.properties.taskStatus === 'running' &&
            event.properties.taskConcurrencyLimit === 1,
          'queued task promotion',
          300_000
        );
        const queuedTerminalEvent = await collector.waitFor(
          (event) =>
            event.type === 'task.status' &&
            event.properties.sessionId === queuedTask.session.sessionId &&
            event.properties.projectPath === queuedTask.session.projectPath &&
            ['completed', 'failed', 'cancelled', 'interrupted'].includes(
              String(event.properties.taskStatus)
            ),
          'queued task terminal status',
          300_000
        );
        if (queuedTerminalEvent.properties.taskStatus !== 'completed') {
          const failedTask = await listTask(
            server,
            queuedTask.session.sessionId,
            queuedTask.session.projectPath
          );
          throw new Error(
            `Queued Web task failed: ${JSON.stringify({
              status: queuedTerminalEvent.properties.taskStatus,
              reason:
                queuedTerminalEvent.properties.taskStatusReason ??
                failedTask.taskStatusReason,
            })}`
          );
        }
        const capacitySettledEvent = await collector.waitFor(
          (event) =>
            event.type === 'task.status' &&
            event.properties.sessionId === queuedTask.session.sessionId &&
            event.properties.taskStatus === 'completed' &&
            event.properties.taskInFlight === 0 &&
            event.properties.taskQueueDepth === 0,
          'settled task admission capacity'
        );
        expect(capacitySettledEvent.properties).toMatchObject({
          taskConcurrencyLimit: 1,
          taskInFlight: 0,
          taskQueueDepth: 0,
        });
        const queuedTaskEvents = collector.events.filter(
          (event) =>
            event.type === 'task.status' &&
            event.properties.sessionId === queuedTask.session.sessionId &&
            event.properties.projectPath === queuedTask.session.projectPath
        );
        expect(queuedTaskEvents.map((event) => event.properties.taskStatus)).toEqual(
          expect.arrayContaining(['queued', 'running', 'completed'])
        );

        const listed = await listTask(
          server,
          accepted.session.sessionId,
          accepted.session.projectPath
        );
        expect(listed).toMatchObject({
          taskStatus: 'completed',
          taskIsolation: 'worktree',
          taskSourceProjectPath: workspace,
          taskWorktreePath: accepted.session.projectPath,
          taskWorktreeBranch: accepted.session.taskWorktreeBranch,
          taskBaseCommit: accepted.session.taskBaseCommit,
          taskDiffStat: {
            changedFiles: 1,
            commits: 0,
          },
        });
        expect(listed.taskDiffStat?.additions).toBeGreaterThan(0);
        expect(listed.taskDiffStat?.deletions).toBeGreaterThan(0);
        const listedQueuedTask = await listTask(
          server,
          queuedTask.session.sessionId,
          queuedTask.session.projectPath
        );
        expect(listedQueuedTask).toMatchObject({
          taskStatus: 'completed',
          taskIsolation: 'local',
          taskSourceProjectPath: workspace,
          taskConcurrencyLimit: 1,
        });
        expect(listedQueuedTask.taskQueuePosition).toBeUndefined();
        expect(listedQueuedTask.taskQueueDepth).toBeUndefined();
        const artifact = await getTaskDiff(
          server,
          accepted.session.sessionId,
          accepted.session.projectPath
        );
        expect(artifact).toMatchObject({
          sessionId: accepted.session.sessionId,
          projectPath: accepted.session.projectPath,
          baseCommit: accepted.session.taskBaseCommit,
          truncated: false,
          files: [
            {
              path: 'src/multiply.js',
              additions: 1,
              deletions: 1,
              binary: false,
              truncated: false,
            },
          ],
        });
        expect(artifact.files[0]?.patch).toContain('return left * right;');
        expect(await readFile(path.join(workspace, 'src', 'multiply.js'), 'utf8')).toBe(
          originalSource
        );
        const isolatedSource = await readFile(
          path.join(accepted.session.projectPath, 'src', 'multiply.js'),
          'utf8'
        );
        expect(isolatedSource).toContain('return left * right;');
        const verification = await execFileAsync(process.execPath, ['--test'], {
          cwd: accepted.session.projectPath,
          timeout: 30_000,
        });
        expect(verification.stdout).toContain('pass 1');
        const sourceStatus = await execFileAsync('git', ['status', '--porcelain'], {
          cwd: workspace,
        });
        expect(sourceStatus.stdout.trim()).toBe('');
        await expect(
          access(
            getSessionInboxFilePath(
              accepted.session.projectPath,
              accepted.session.sessionId
            )
          )
        ).rejects.toThrow();
        assertNoSecrets(
          {
            accepted,
            queuedTask,
            taskEvents,
            queuedTaskEvents,
            terminalEvent,
            queuedTerminalEvent,
            capacitySettledEvent,
            listed,
            listedQueuedTask,
            artifact,
          },
          [modelConfig.apiKey]
        );
      } finally {
        await collector?.close().catch(() => undefined);
        if (server) {
          for (const taskRef of taskRefs) {
            await deleteTask(server, taskRef.sessionId, taskRef.projectPath).catch(
              () => undefined
            );
          }
        }
        await server?.stop().catch(() => undefined);
        if (originalConfig) getState().config.actions.setConfig(originalConfig);
        SkillRegistry.resetInstance();
        subagentRegistry.clear();
        subagentRegistry.loadBuiltinAgents();
        if (hooksWereEnabled) hookManager.enable();
        if (originalStorageRoot === undefined) delete process.env.BLADE_STORAGE_ROOT;
        else process.env.BLADE_STORAGE_ROOT = originalStorageRoot;
        if (originalAutoMemory === undefined) delete process.env.BLADE_AUTO_MEMORY;
        else process.env.BLADE_AUTO_MEMORY = originalAutoMemory;
        await rm(fixtureRoot, { recursive: true, force: true });
      }
    }, 360_000);
  }
});
