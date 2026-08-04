// @vitest-environment jsdom

import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { act } from 'react';
import ReactDOM from 'react-dom/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SessionRuntime } from '../../../src/agent/runtime/SessionRuntime.js';
import { DEFAULT_CONFIG } from '../../../src/config/defaults.js';
import { PermissionMode, type RuntimeConfig } from '../../../src/config/types.js';
import { getState } from '../../../src/store/vanilla.js';
import { useAgent } from '../../../src/ui/hooks/useAgent.js';
import { runWithCwdOverride } from '../../../src/utils/cwd.js';
import { isRealApiTestEnabled } from './testConfig.js';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const enabled = isRealApiTestEnabled() && Boolean(process.env.DEEPSEEK_API_KEY);
const apiKey = process.env.DEEPSEEK_API_KEY ?? '';
const baseUrl = process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com';
const models = (process.env.DEEPSEEK_MODELS ?? 'deepseek-v4-flash,deepseek-v4-pro')
  .split(',')
  .map((model) => model.trim())
  .filter(Boolean);
let originalConfig: RuntimeConfig | null = null;

function setRuntimeModel(model: string): string {
  const modelId = `tui-runtime-${model}`;
  getState().config.actions.setConfig({
    ...DEFAULT_CONFIG,
    currentModelId: modelId,
    models: [
      {
        id: modelId,
        name: model,
        provider: 'deepseek',
        apiKey,
        baseUrl,
        model,
        maxContextTokens: 64_000,
        maxOutputTokens: 512,
        timeout: 180_000,
      },
    ],
  });
  return modelId;
}

beforeAll(() => {
  if (!enabled) return;
  originalConfig = getState().config.config;
});

afterAll(() => {
  if (originalConfig) {
    getState().config.actions.setConfig(originalConfig);
  }
});

describe.skipIf(!enabled)('TUI runtime lifecycle (real API)', () => {
  for (const model of models) {
    it(`${model} releases its runtime lease after a real TUI Agent turn`, async () => {
      const workspace = mkdtempSync(path.join(os.tmpdir(), 'blade-tui-runtime-'));
      const sessionId = `tui-real-${model}-${Date.now()}`;
      const modelId = setRuntimeModel(model);
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = ReactDOM.createRoot(container);
      let hook: ReturnType<typeof useAgent> | undefined;

      function Harness() {
        hook = useAgent({
          sessionId,
          modelId,
          maxTurns: 2,
          appendSystemPrompt:
            'For the runtime lifecycle check, answer directly without calling tools.',
        });
        return null;
      }

      try {
        await act(async () => {
          root.render(<Harness />);
          await Promise.resolve();
        });
        const agent = await hook?.createAgent();
        if (!agent) throw new Error('TUI Agent was not created');

        const result = await runWithCwdOverride(workspace, () =>
          agent.chat(
            'Reply with exactly TUI_RUNTIME_OK and do not call tools.',
            {
              messages: [],
              userId: 'tui-real-api-test',
              sessionId,
              workspaceRoot: workspace,
              permissionMode: PermissionMode.YOLO,
            },
            { maxTurns: 2, stream: true }
          )
        );
        expect(result.success).toBe(true);
        expect(result.finalMessage).toContain('TUI_RUNTIME_OK');
        expect(JSON.stringify(result)).not.toContain(apiKey);

        await hook?.cleanupAgent();

        const replacement = await SessionRuntime.create({ sessionId, modelId });
        await replacement.dispose();
      } finally {
        await hook?.cleanupAgent().catch(() => undefined);
        await act(async () => {
          root.unmount();
          await Promise.resolve();
        });
        container.remove();
        rmSync(workspace, { recursive: true, force: true });
      }
    }, 240_000);
  }
});
