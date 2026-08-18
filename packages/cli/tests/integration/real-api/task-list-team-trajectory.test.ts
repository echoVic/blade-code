import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgentSessionStore } from '../../../src/agent/subagents/AgentSessionStore.js';
import { BackgroundAgentManager } from '../../../src/agent/subagents/BackgroundAgentManager.js';
import { PermissionMode, type RuntimeConfig } from '../../../src/config/types.js';
import { getState } from '../../../src/store/vanilla.js';
import { TaskListManager } from '../../../src/tools/builtin/task/TaskListManager.js';
import { runWithCwdOverride } from '../../../src/utils/cwd.js';
import {
  buildRealApiRuntimeConfig,
  expandDeepSeekModelMatrix,
  getEnabledModelConfigs,
  isRealApiTestEnabled,
} from './testConfig.js';

const modelConfigs = isRealApiTestEnabled()
  ? expandDeepSeekModelMatrix(
      getEnabledModelConfigs().filter((config) => config.id === 'deepseek')
    )
  : [];
const enabled = modelConfigs.length > 0;
const originalStorageRoot = process.env.BLADE_STORAGE_ROOT;
let originalConfig: RuntimeConfig | null = null;

beforeAll(() => {
  if (!enabled) return;
  originalConfig = getState().config.config;
});

afterAll(() => {
  resetBackgroundAgentState();
  if (originalConfig) {
    getState().config.actions.setConfig(originalConfig);
  }
  restoreEnvironment('BLADE_STORAGE_ROOT', originalStorageRoot);
});

describe.skipIf(!enabled)(
  'durable Agent Team task-list coordination (real API)',
  () => {
    for (const modelConfig of modelConfigs) {
      it(`${modelConfig.model} preserves every concurrent teammate task`, async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), 'blade-team-task-list-'));
        const workspace = path.join(root, 'workspace');
        const storageRoot = path.join(root, 'storage');
        const configDir = storageRoot;
        const teamName = `real-team-${modelConfig.model.replace(/[^a-z0-9]+/gi, '-')}`;
        const parentSessionId = `parent-${teamName}`;
        const teammateCount = 4;

        try {
          await mkdir(workspace, { recursive: true });
          process.env.BLADE_STORAGE_ROOT = storageRoot;
          const runtimeConfig = buildRealApiRuntimeConfig(modelConfig);
          getState().config.actions.setConfig({
            ...runtimeConfig,
            permissionMode: PermissionMode.YOLO,
          });
          resetBackgroundAgentState();

          const manager = BackgroundAgentManager.getInstance();
          const taskCreateResults = new Set<string>();
          const agentIds = await runWithCwdOverride(workspace, async () =>
            Array.from({ length: teammateCount }, (_, index) => {
              const label = `teammate-${index + 1}`;
              return manager.startBackgroundAgent({
                config: {
                  name: 'task-list-writer',
                  description: 'Create one task in a shared Agent Team list',
                  systemPrompt:
                    'You are an execution-only Agent Team worker. Your first response ' +
                    'must be exactly one TaskCreate tool call using the exact fields ' +
                    'from the user. A text response before receiving that tool result ' +
                    'is a protocol failure. Never claim success unless TaskCreate has ' +
                    'returned success in this conversation.',
                  tools: ['TaskCreate'],
                  model: runtimeConfig.currentModelId,
                  permissionMode: PermissionMode.YOLO,
                  maxTurns: 3,
                },
                description: `Write shared task ${label}`,
                prompt:
                  `Do not answer with text. Invoke TaskCreate now with subject ` +
                  `"${label}" and description "Created by ${label}".`,
                parentSessionId,
                providerAdmissionOwnerId: parentSessionId,
                parentProjectPath: workspace,
                permissionMode: PermissionMode.YOLO,
                agentId: `${teamName}-${label}`,
                taskListId: teamName,
                workspaceRoot: workspace,
                isolation: 'none',
                onEvent: (event) => {
                  if (
                    event.kind === 'tool_result' &&
                    'function' in event.toolCall &&
                    event.toolCall.function.name === 'TaskCreate' &&
                    event.result.success
                  ) {
                    taskCreateResults.add(label);
                  }
                },
              });
            })
          );

          const completed = await Promise.all(
            agentIds.map((agentId) =>
              manager.waitForCompletion(agentId, 180_000, {
                sessionId: parentSessionId,
                projectPath: workspace,
              })
            )
          );
          expect(completed).toHaveLength(teammateCount);
          for (const session of completed) {
            expect(session).toMatchObject({
              status: 'completed',
              taskListId: teamName,
              result: { success: true },
            });
          }
          expect(taskCreateResults).toEqual(
            new Set(['teammate-1', 'teammate-2', 'teammate-3', 'teammate-4'])
          );

          const taskManager = TaskListManager.getInstance(teamName, configDir);
          const tasks = await taskManager.listTasks();
          expect(tasks).toHaveLength(teammateCount);
          expect(tasks.map((task) => Number(task.id)).sort((a, b) => a - b)).toEqual([
            1, 2, 3, 4,
          ]);
          expect(new Set(tasks.map((task) => task.subject))).toEqual(
            new Set(['teammate-1', 'teammate-2', 'teammate-3', 'teammate-4'])
          );
          expect(TaskListManager.coordinationStatsForTests()).toEqual({
            keys: 0,
            operations: 0,
          });

          const taskFile = path.join(
            configDir,
            'tasks',
            `${teamName}-agent-${teamName}.json`
          );
          const stored = JSON.parse(await readFile(taskFile, 'utf-8')) as {
            nextId: number;
            tasks: unknown[];
          };
          expect(stored).toMatchObject({
            nextId: 5,
            tasks: expect.any(Array),
          });
          expect(stored.tasks).toHaveLength(teammateCount);
          await expect(access(`${taskFile}.lock`)).rejects.toMatchObject({
            code: 'ENOENT',
          });
          expect(JSON.stringify(completed).includes(modelConfig.apiKey)).toBe(false);
        } finally {
          BackgroundAgentManager.getInstance().killAll();
          resetBackgroundAgentState();
          restoreEnvironment('BLADE_STORAGE_ROOT', originalStorageRoot);
          await rm(root, { recursive: true, force: true });
        }
      }, 240_000);
    }
  }
);

function resetBackgroundAgentState(): void {
  const manager = (
    BackgroundAgentManager as unknown as {
      instance: BackgroundAgentManager | null;
    }
  ).instance;
  manager?.killAll();
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

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
