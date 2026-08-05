// @vitest-environment jsdom

import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { act } from 'react';
import ReactDOM from 'react-dom/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type AgentSession,
  type AgentSessionOwner,
  AgentSessionStore,
} from '../../../src/agent/subagents/AgentSessionStore.js';
import { BackgroundAgentManager } from '../../../src/agent/subagents/BackgroundAgentManager.js';
import { subagentRegistry } from '../../../src/agent/subagents/SubagentRegistry.js';
import type { RuntimeConfig } from '../../../src/config/types.js';
import { PermissionMode } from '../../../src/config/types.js';
import { getState } from '../../../src/store/vanilla.js';
import { useAgent } from '../../../src/ui/hooks/useAgent.js';
import { runWithCwdOverride } from '../../../src/utils/cwd.js';
import {
  buildRealApiRuntimeConfig,
  getEnabledModelConfigs,
  isRealApiTestEnabled,
} from './testConfig.js';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const modelConfigs = isRealApiTestEnabled() ? getEnabledModelConfigs() : [];
const enabled = modelConfigs.length > 0;
const originalStorageRoot = process.env.BLADE_STORAGE_ROOT;
let originalConfig: RuntimeConfig | null = null;

beforeAll(() => {
  if (enabled) originalConfig = getState().config.config;
});

afterAll(() => {
  if (originalConfig) getState().config.actions.setConfig(originalConfig);
  if (originalStorageRoot === undefined) {
    delete process.env.BLADE_STORAGE_ROOT;
  } else {
    process.env.BLADE_STORAGE_ROOT = originalStorageRoot;
  }
});

function resetSubagentState(): void {
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

function registerMemoryAgent(): void {
  subagentRegistry.clear();
  subagentRegistry.register({
    name: 'durable-memory',
    description: 'Follow-up code review agent',
    systemPrompt:
      'Act as a focused code review assistant. Use prior conversation context ' +
      'when answering follow-up questions. Do not call tools unless requested.',
    tools: ['Read'],
    permissionMode: PermissionMode.YOLO,
    maxTurns: 2,
  });
}

function seedSource(input: {
  id: string;
  owner: AgentSessionOwner;
  modelId: string;
  token: string;
}): void {
  const now = Date.now();
  AgentSessionStore.getInstance().saveSession({
    schemaVersion: 2,
    id: input.id,
    subagentType: 'durable-memory',
    description: 'Track review module',
    prompt: `For this code review, the selected module codename is ${input.token}.`,
    messages: [
      {
        role: 'user',
        content: `For this code review, the selected module codename is ${input.token}.`,
      },
      {
        role: 'assistant',
        content: 'Acknowledged. I recorded the selected module codename.',
      },
    ],
    status: 'completed',
    result: {
      success: true,
      message: 'Acknowledged. I recorded the selected module codename.',
    },
    createdAt: now - 1,
    lastActiveAt: now,
    completedAt: now,
    parentSessionId: input.owner.sessionId,
    parentProjectPath: input.owner.projectPath,
    rootAgentId: input.id,
    resumeDepth: 0,
    workspaceRoot: input.owner.projectPath,
    isolation: 'none',
    configSnapshot: {
      name: 'durable-memory',
      description: 'Follow-up code review agent',
      systemPrompt:
        'Act as a focused code review assistant. Use prior conversation context ' +
        'when answering follow-up questions. Do not call tools unless requested.',
      tools: ['Read'],
      model: input.modelId,
      permissionMode: PermissionMode.YOLO,
      maxTurns: 2,
    },
  });
}

const describeTrajectory = enabled ? describe.sequential : describe.skip;

describeTrajectory('TUI durable subagent resume (real API)', () => {
  for (const modelConfig of modelConfigs) {
    it(`${modelConfig.model} resumes through the useAgent runtime owner`, async () => {
      const workspace = mkdtempSync(
        path.join(os.tmpdir(), 'blade-tui-subagent-resume-')
      );
      const runtimeConfig = buildRealApiRuntimeConfig(modelConfig);
      const owner = {
        sessionId: `tui-subagent-${Date.now()}`,
        projectPath: workspace,
      };
      const sourceId = `agent-tui-root-${Date.now()}`;
      const token = `tui-module-${Date.now()}`;
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = ReactDOM.createRoot(container);
      let hook: ReturnType<typeof useAgent> | undefined;

      function Harness() {
        hook = useAgent({
          sessionId: owner.sessionId,
          modelId: runtimeConfig.currentModelId,
        });
        return null;
      }

      try {
        process.env.BLADE_STORAGE_ROOT = path.join(workspace, '.blade-storage');
        resetSubagentState();
        registerMemoryAgent();
        getState().config.actions.setConfig(runtimeConfig);
        seedSource({
          id: sourceId,
          owner,
          modelId: runtimeConfig.currentModelId,
          token,
        });
        await act(async () => {
          root.render(<Harness />);
          await Promise.resolve();
        });

        const listed = await runWithCwdOverride(workspace, () => hook?.listSubagents());
        expect(listed).toEqual([
          expect.objectContaining({ id: sourceId, resumeDepth: 0 }),
        ]);
        const resumed = await runWithCwdOverride(workspace, () =>
          hook?.resumeSubagent(
            sourceId,
            'What module codename did we select earlier? Answer in one short sentence.'
          )
        );
        expect(resumed).toMatchObject({
          source: { id: sourceId },
          session: {
            resumedFrom: sourceId,
            rootAgentId: sourceId,
            resumeDepth: 1,
          },
        });
        const child = await BackgroundAgentManager.getInstance().waitForCompletion(
          resumed!.session.id,
          180_000,
          owner
        );
        expect(child).toMatchObject({
          status: 'completed',
          resumedFrom: sourceId,
          resumeDepth: 1,
        });
        expect(child?.result?.message).toContain(token);
        expect(JSON.stringify(child)).not.toContain(modelConfig.apiKey);
      } finally {
        await hook?.cleanupAgent().catch(() => undefined);
        await act(async () => {
          root.unmount();
          await Promise.resolve();
        });
        container.remove();
        resetSubagentState();
        rmSync(workspace, { recursive: true, force: true });
      }
    }, 300_000);
  }
});
