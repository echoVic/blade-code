// @vitest-environment jsdom

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { act } from 'react';
import ReactDOM from 'react-dom/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SessionRuntime } from '../../../src/agent/runtime/SessionRuntime.js';
import { DEFAULT_CONFIG } from '../../../src/config/defaults.js';
import { PermissionMode, type RuntimeConfig } from '../../../src/config/types.js';
import { SessionService } from '../../../src/services/SessionService.js';
import { getState } from '../../../src/store/vanilla.js';
import { useAgent } from '../../../src/ui/hooks/useAgent.js';
import { runWithCwdOverride } from '../../../src/utils/cwd.js';
import {
  BOUNDED_OUTPUT_PROOF,
  buildInteractiveShellCommand,
  buildInteractiveShellPrompt,
  createBoundedOutputFixture,
  INTERACTIVE_SHELL_INPUT,
} from './interactiveShellFixture.js';
import {
  isRealApiTestEnabled,
  resolveDeepSeekQualificationSettings,
} from './testConfig.js';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const qualification = isRealApiTestEnabled()
  ? resolveDeepSeekQualificationSettings()
  : undefined;
const enabled = Boolean(qualification);
const apiKey = qualification?.apiKey ?? '';
const baseUrl = qualification?.baseURL ?? 'https://api.deepseek.com';
const models = qualification?.models ?? [];
let originalConfig: RuntimeConfig | null = null;

function setRuntimeModel(model: string): string {
  const modelId = `tui-runtime-${model}`;
  getState().config.actions.setConfig({
    ...DEFAULT_CONFIG,
    currentModelId: modelId,
    models: [
      {
        id: modelId,
        displayName: model,
        provider: 'deepseek',
        model,
        overrides: { baseUrl, maxOutputTokens: 512, timeout: 180_000 },
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
        const agent = await runWithCwdOverride(workspace, () => hook?.createAgent());
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

    it(`${model} rewinds a real edit through the TUI runtime hook`, async () => {
      const workspace = mkdtempSync(path.join(os.tmpdir(), 'blade-tui-rewind-'));
      const previousStorageRoot = process.env.BLADE_STORAGE_ROOT;
      process.env.BLADE_STORAGE_ROOT = path.join(workspace, '.blade-storage');
      const sessionId = `tui-rewind-${model}-${Date.now()}`;
      const modelId = setRuntimeModel(model);
      const targetFile = path.join(workspace, 'fixture.txt');
      writeFileSync(targetFile, 'BASELINE');
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = ReactDOM.createRoot(container);
      let hook: ReturnType<typeof useAgent> | undefined;

      function Harness() {
        hook = useAgent({ sessionId, modelId, maxTurns: 8 });
        return null;
      }

      try {
        await act(async () => {
          root.render(<Harness />);
          await Promise.resolve();
        });
        const agent = await runWithCwdOverride(workspace, () => hook?.createAgent());
        if (!agent) throw new Error('TUI Agent was not created');
        const result = await runWithCwdOverride(workspace, () =>
          agent.chat(
            [
              'Use Read on fixture.txt, then Edit exactly once to replace',
              'BASELINE with CHANGED, then Read again to verify CHANGED.',
              'Use no other tools and finish with exactly TUI_REWIND_READY.',
            ].join(' '),
            {
              messages: [],
              userId: 'tui-rewind-real-api',
              sessionId,
              workspaceRoot: workspace,
              permissionMode: PermissionMode.YOLO,
            },
            { maxTurns: 8, stream: true }
          )
        );
        expect(result.success).toBe(true);
        expect(readFileSync(targetFile, 'utf8')).toBe('CHANGED');

        const checkpoints = await hook?.listRewindCheckpoints();
        expect(checkpoints?.[0]).toMatchObject({ fileCount: 1 });
        const rewound = await hook?.rewindSession({
          targetMessageId: checkpoints![0]!.messageId,
          mode: 'both',
        });
        expect(rewound?.messages).toEqual([]);
        expect(readFileSync(targetFile, 'utf8')).toBe('BASELINE');
        await expect(
          SessionService.listRewindCheckpoints(sessionId, workspace)
        ).resolves.toEqual([]);
        expect(JSON.stringify([result, rewound])).not.toContain(apiKey);
      } finally {
        await hook?.cleanupAgent().catch(() => undefined);
        await act(async () => {
          root.unmount();
          await Promise.resolve();
        });
        container.remove();
        if (previousStorageRoot === undefined) {
          delete process.env.BLADE_STORAGE_ROOT;
        } else {
          process.env.BLADE_STORAGE_ROOT = previousStorageRoot;
        }
        rmSync(workspace, { recursive: true, force: true });
      }
    }, 240_000);

    it(`${model} keeps a TUI session approval in memory without persisting it`, async () => {
      const workspace = mkdtempSync(path.join(os.tmpdir(), 'blade-tui-scope-'));
      const sessionId = `tui-scope-${model}-${Date.now()}`;
      const modelId = setRuntimeModel(model);
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = ReactDOM.createRoot(container);
      let hook: ReturnType<typeof useAgent> | undefined;
      let confirmationCount = 0;
      const scriptFile = 'tui-permission-scope.mjs';
      const turnTokenFile = 'tui-permission-turn.txt';
      const command = `${JSON.stringify(process.execPath)} ${scriptFile}`;
      writeFileSync(
        path.join(workspace, scriptFile),
        [
          "import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';",
          `const token = readFileSync(${JSON.stringify(turnTokenFile)}, 'utf8');`,
          "const previous = existsSync('tui-permission-last.txt') ? readFileSync('tui-permission-last.txt', 'utf8') : '';",
          'if (token !== previous) {',
          "  appendFileSync('tui-permission-scope.log', 'tui-scope\\n');",
          "  writeFileSync('tui-permission-last.txt', token);",
          '}',
          '',
        ].join('\n')
      );

      function Harness() {
        hook = useAgent({ sessionId, modelId, maxTurns: 6 });
        return null;
      }

      try {
        await act(async () => {
          root.render(<Harness />);
          await Promise.resolve();
        });
        const agent = await hook?.createAgent();
        if (!agent) throw new Error('TUI Agent was not created');

        writeFileSync(path.join(workspace, turnTokenFile), 'turn-one');
        const firstResult = await runWithCwdOverride(workspace, () =>
          agent.chat(
            `Call Bash with the exact command ${JSON.stringify(command)} and finish after it succeeds. Do not use any other tool.`,
            {
              messages: [],
              userId: 'tui-permission-scope-test',
              sessionId,
              workspaceRoot: workspace,
              permissionMode: PermissionMode.DEFAULT,
              confirmationHandler: {
                requestConfirmation: async () => {
                  confirmationCount += 1;
                  return { approved: true, scope: 'session' };
                },
              },
            },
            { maxTurns: 6, stream: true }
          )
        );

        expect(firstResult.success).toBe(true);
        expect(confirmationCount).toBe(1);
        expect(
          readFileSync(path.join(workspace, 'tui-permission-scope.log'), 'utf8')
        ).toBe('tui-scope\n');

        writeFileSync(path.join(workspace, turnTokenFile), 'turn-two');
        const secondResult = await runWithCwdOverride(workspace, () =>
          agent.chat(
            `In this new turn, call Bash with the same exact command ${JSON.stringify(command)} and finish after it succeeds. Do not use any other tool.`,
            {
              messages: [],
              userId: 'tui-permission-scope-test',
              sessionId,
              workspaceRoot: workspace,
              permissionMode: PermissionMode.DEFAULT,
              confirmationHandler: {
                requestConfirmation: async () => {
                  confirmationCount += 1;
                  return { approved: true, scope: 'session' };
                },
              },
            },
            { maxTurns: 6, stream: true }
          )
        );

        expect(secondResult.success).toBe(true);
        expect(confirmationCount).toBe(1);
        expect(
          readFileSync(path.join(workspace, 'tui-permission-scope.log'), 'utf8')
        ).toBe('tui-scope\ntui-scope\n');
        expect(existsSync(path.join(workspace, '.blade', 'settings.local.json'))).toBe(
          false
        );
        expect(JSON.stringify([firstResult, secondResult])).not.toContain(apiKey);
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

    it(`${model} drives an interactive background shell through the TUI runtime`, async () => {
      const workspace = mkdtempSync(path.join(os.tmpdir(), 'blade-tui-stdin-'));
      const sessionId = `tui-stdin-${model}-${Date.now()}`;
      const modelId = setRuntimeModel(model);
      const outputFile = 'tui-stdin.txt';
      const command = buildInteractiveShellCommand(outputFile);
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = ReactDOM.createRoot(container);
      let hook: ReturnType<typeof useAgent> | undefined;

      function Harness() {
        hook = useAgent({ sessionId, modelId, maxTurns: 8 });
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
            buildInteractiveShellPrompt(command),
            {
              messages: [],
              userId: 'tui-write-stdin-test',
              sessionId,
              workspaceRoot: workspace,
              permissionMode: PermissionMode.YOLO,
            },
            { maxTurns: 8, stream: true }
          )
        );

        const outputPath = path.join(workspace, outputFile);
        const diagnostic = JSON.stringify(
          {
            error: result.error,
            finalMessage: result.finalMessage,
            metadata: result.metadata,
            outputExists: existsSync(outputPath),
            output: existsSync(outputPath) ? readFileSync(outputPath, 'utf8') : null,
          },
          null,
          2
        ).replaceAll(apiKey, '[redacted]');
        expect(result.success, diagnostic).toBe(true);
        expect(existsSync(outputPath), diagnostic).toBe(true);
        expect(readFileSync(outputPath, 'utf8')).toBe(INTERACTIVE_SHELL_INPUT);
        expect(result.metadata?.toolCallsCount ?? 0).toBeGreaterThanOrEqual(3);
        expect(JSON.stringify(result)).not.toContain(apiKey);
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

    it(`${model} observes bounded background output through the TUI runtime`, async () => {
      const workspace = mkdtempSync(path.join(os.tmpdir(), 'blade-tui-bounded-'));
      const sessionId = `tui-bounded-${model}-${Date.now()}`;
      const modelId = setRuntimeModel(model);
      const proofFile = 'tui-bounded-output.txt';
      const fixture = await createBoundedOutputFixture(workspace, proofFile);
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = ReactDOM.createRoot(container);
      let hook: ReturnType<typeof useAgent> | undefined;

      function Harness() {
        hook = useAgent({ sessionId, modelId, maxTurns: 8 });
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
            fixture.prompt,
            {
              messages: [],
              userId: 'tui-bounded-output-test',
              sessionId,
              workspaceRoot: workspace,
              permissionMode: PermissionMode.YOLO,
            },
            { maxTurns: 8, stream: true }
          )
        );

        const proofPath = path.join(workspace, proofFile);
        const diagnostic = JSON.stringify(
          {
            error: result.error,
            finalMessage: result.finalMessage,
            metadata: result.metadata,
            proofExists: existsSync(proofPath),
          },
          null,
          2
        ).replaceAll(apiKey, '[redacted]');
        expect(result.success, diagnostic).toBe(true);
        expect(readFileSync(proofPath, 'utf8'), diagnostic).toBe(BOUNDED_OUTPUT_PROOF);
        expect(result.metadata?.toolCallsCount ?? 0).toBeGreaterThanOrEqual(3);
        expect(JSON.stringify(result)).not.toContain(apiKey);
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
