import { describe, expect, it } from 'vitest';
import { BladeServer } from '../../../src/server/server.js';
import { builtinCommands } from '../../../src/slash-commands/builtinCommands.js';
import { getState } from '../../../src/store/vanilla.js';
import { assertNoSecrets } from './sessionForkTrajectoryHarness.js';
import {
  buildRealApiRuntimeConfig,
  isRealApiTestEnabled,
  resolveForkQualificationModels,
  type TestModelConfig,
} from './testConfig.js';

const configs = isRealApiTestEnabled()
  ? resolveForkQualificationModels(process.env)
  : [];

function requireModel(id: TestModelConfig['id']): TestModelConfig | undefined {
  return configs.find((config) => config.id === id);
}

const gpt = requireModel('gpt');
const domestic = requireModel('domestic');
const claude = requireModel('claude');
const enabled = Boolean(gpt && domestic && claude);
const describeHealth = enabled ? describe.sequential : describe.skip;

describeHealth('provider health surfaces (real API)', () => {
  it('probes a custom GPT channel through the production Web route', async () => {
    if (!gpt) throw new Error('GPT qualification model is unavailable');
    const originalConfig = getState().config.config;
    const config = buildRealApiRuntimeConfig(gpt);
    getState().config.actions.setConfig(config);
    const selected = config.models[0]!;
    const server = await BladeServer.listenAsync({
      port: 0,
      hostname: '127.0.0.1',
    });
    try {
      const response = await fetch(
        new URL(`/providers/${selected.provider}/probe`, server.url),
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ modelId: selected.id }),
        }
      );
      const result = await response.json();

      expect(response.status).toBe(200);
      expect(result).toMatchObject({
        ok: true,
        providerId: selected.provider,
        modelConfigId: selected.id,
        model: selected.model,
        wireApi: 'openai-completions',
        code: 'ok',
        message: 'Provider responded successfully.',
        latencyMs: expect.any(Number),
      });
      assertNoSecrets(result, [gpt.apiKey]);
    } finally {
      await server.stop();
      if (originalConfig) getState().config.actions.setConfig(originalConfig);
    }
  }, 60_000);

  it('renders a safe Qwen diagnosis through the TUI slash command', async () => {
    if (!domestic) throw new Error('Domestic qualification model is unavailable');
    const originalConfig = getState().config.config;
    const originalMessages = getState().session.messages;
    getState().config.actions.setConfig(buildRealApiRuntimeConfig(domestic));
    getState().session.actions.clearMessages();
    try {
      const result = await builtinCommands.doctor.handler([], {
        cwd: process.cwd(),
      });
      const output = getState()
        .session.messages.map((message) => String(message.content))
        .join('\n');

      expect(result.success).toBe(true);
      expect(result.content).toContain('API Connectivity Diagnosis');
      expect(output).toContain('API Connectivity Diagnosis');
      expect(output).toContain('openai-completions');
      assertNoSecrets({ result, output }, [domestic.apiKey]);
    } finally {
      if (originalConfig) getState().config.actions.setConfig(originalConfig);
      getState().session.actions.restoreSession(
        getState().session.sessionId,
        originalMessages,
        undefined,
        getState().session.workspaceRoot
      );
    }
  }, 60_000);

  it('delivers a safe Claude diagnosis through ACP callbacks', async () => {
    if (!claude) throw new Error('Claude qualification model is unavailable');
    const originalConfig = getState().config.config;
    getState().config.actions.setConfig(buildRealApiRuntimeConfig(claude));
    const updates: string[] = [];
    try {
      const result = await builtinCommands.doctor.handler([], {
        cwd: process.cwd(),
        acp: {
          sendMessage: (text) => updates.push(text),
        },
      });

      expect(result.success).toBe(true);
      expect(updates).toHaveLength(1);
      expect(updates[0]).toContain('anthropic-messages');
      expect(updates[0]).not.toContain('sk-');
      assertNoSecrets({ result, updates }, [claude.apiKey]);
    } finally {
      if (originalConfig) getState().config.actions.setConfig(originalConfig);
    }
  }, 60_000);
});
