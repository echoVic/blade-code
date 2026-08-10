import type { Api, Model, Usage } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';
import type { ChatConfig } from '../../../src/services/ChatServiceInterface.js';
import {
  buildPiOptions,
  convertPiUsage,
  isFallbackablePiError,
} from '../../../src/services/pi/requestOptions.js';

describe('convertPiUsage', () => {
  it('preserves cache usage and pi-computed cost', () => {
    const usage: Usage = {
      input: 100,
      output: 20,
      cacheRead: 50,
      cacheWrite: 30,
      reasoning: 5,
      totalTokens: 200,
      cost: {
        input: 0.001,
        output: 0.002,
        cacheRead: 0.0001,
        cacheWrite: 0.0002,
        total: 0.0033,
      },
    };

    expect(convertPiUsage(usage)).toEqual({
      promptTokens: 180,
      completionTokens: 20,
      totalTokens: 200,
      costUsd: 0.0033,
      reasoningTokens: 5,
      cacheCreationInputTokens: 30,
      cacheReadInputTokens: 50,
    });
  });
});

describe('buildPiOptions', () => {
  it('allows a bounded request to override output tokens and temperature', () => {
    const config = {
      provider: 'openai-compatible',
      model: 'session-model',
      apiKey: 'test-key',
      maxOutputTokens: 2048,
      temperature: 0.7,
    } satisfies ChatConfig;
    const model = {
      api: 'openai-completions',
    } as Model<Api>;

    expect(
      buildPiOptions(config, model, undefined, {
        maxOutputTokens: 64,
        temperature: 0.1,
      })
    ).toMatchObject({
      maxTokens: 64,
      temperature: 0.1,
    });
  });

  it.each([
    {
      api: 'openai-responses',
      effort: 'xhigh',
      expected: { reasoningEffort: 'xhigh' },
    },
    {
      api: 'anthropic-messages',
      effort: 'max',
      expected: { thinkingEnabled: true, effort: 'max' },
    },
    {
      api: 'google-generative-ai',
      effort: 'medium',
      expected: { thinking: { enabled: true, level: 'MEDIUM' } },
    },
    {
      api: 'bedrock-converse-stream',
      effort: 'minimal',
      expected: { reasoning: 'minimal' },
    },
  ] as const)('projects $effort through the $api provider options', ({
    api,
    effort,
    expected,
  }) => {
    const config = {
      provider: 'openai-compatible',
      model: 'reasoning-model',
      reasoningEnabled: true,
      reasoningEffort: effort,
    } satisfies ChatConfig;
    expect(buildPiOptions(config, { api } as Model<Api>)).toMatchObject(expected);
  });

  it('forces thinking off for disabled configurations and tool continuations', () => {
    const model = { api: 'anthropic-messages' } as Model<Api>;
    expect(
      buildPiOptions(
        {
          provider: 'anthropic-compatible',
          model: 'claude',
          reasoningEnabled: false,
        },
        model
      )
    ).toMatchObject({ thinkingEnabled: false });
    expect(
      buildPiOptions(
        {
          provider: 'anthropic-compatible',
          model: 'claude',
          reasoningEnabled: true,
          reasoningEffort: 'high',
        },
        model,
        undefined,
        undefined,
        true
      )
    ).toMatchObject({ thinkingEnabled: false });
  });

  it('projects OpenAI and Anthropic service tiers into provider payloads', async () => {
    expect(
      buildPiOptions(
        {
          provider: 'openai-compatible',
          model: 'gpt',
          serviceTier: 'priority',
        },
        { api: 'openai-responses' } as Model<Api>
      )
    ).toMatchObject({ serviceTier: 'priority' });

    const completionOptions = buildPiOptions(
      {
        provider: 'openai-compatible',
        model: 'gpt',
        serviceTier: 'flex',
      },
      { api: 'openai-completions' } as Model<Api>
    );
    const completionPayload = await (
      completionOptions.onPayload as (payload: unknown) => Promise<unknown> | unknown
    )({ model: 'gpt' });
    expect(completionPayload).toEqual({
      model: 'gpt',
      service_tier: 'flex',
    });

    const anthropicOptions = buildPiOptions(
      {
        provider: 'anthropic-compatible',
        model: 'claude-opus-4-6',
        serviceTier: 'fast',
      },
      { api: 'anthropic-messages' } as Model<Api>
    );
    const anthropicPayload = await (
      anthropicOptions.onPayload as (payload: unknown) => Promise<unknown> | unknown
    )({ model: 'claude-opus-4-6' });
    expect(anthropicPayload).toEqual({
      model: 'claude-opus-4-6',
      speed: 'fast',
    });
  });

  it('projects response verbosity without replacing service-tier payload hooks', async () => {
    const completionModel = {
      id: 'gpt-5.5',
      name: 'GPT 5.5',
      api: 'openai-completions',
    } as Model<Api>;
    const completionOptions = buildPiOptions(
      {
        provider: 'openai-compatible',
        model: 'gpt-5.5',
        serviceTier: 'priority',
        responseVerbosity: 'low',
      },
      completionModel
    );
    const completionPayload = await (
      completionOptions.onPayload as (
        payload: unknown,
        model: Model<Api>
      ) => Promise<unknown> | unknown
    )({ model: 'gpt-5.5' }, completionModel);
    expect(completionPayload).toEqual({
      model: 'gpt-5.5',
      service_tier: 'priority',
      verbosity: 'low',
    });

    const responsesModel = {
      id: 'gpt-5.4',
      name: 'GPT 5.4',
      api: 'openai-responses',
    } as Model<Api>;
    const responsesOptions = buildPiOptions(
      {
        provider: 'openai-compatible',
        model: 'gpt-5.4',
        responseVerbosity: 'high',
      },
      responsesModel
    );
    const responsesPayload = await (
      responsesOptions.onPayload as (
        payload: unknown,
        model: Model<Api>
      ) => Promise<unknown> | unknown
    )({ model: 'gpt-5.4', text: { format: { type: 'json_schema' } } }, responsesModel);
    expect(responsesPayload).toEqual({
      model: 'gpt-5.4',
      text: {
        format: { type: 'json_schema' },
        verbosity: 'high',
      },
    });

    expect(
      buildPiOptions(
        {
          provider: 'openai-codex',
          model: 'codex-model',
          responseVerbosity: 'medium',
        },
        {
          id: 'codex-model',
          name: 'Codex',
          api: 'openai-codex-responses',
        } as Model<Api>
      )
    ).toMatchObject({ textVerbosity: 'medium' });
  });

  it('rejects explicit verbosity for an unsupported fallback model', () => {
    expect(() =>
      buildPiOptions(
        {
          provider: 'anthropic-compatible',
          model: 'claude-opus-4-6',
          responseVerbosity: 'high',
        },
        {
          id: 'claude-opus-4-6',
          name: 'Claude Opus 4.6',
          api: 'anthropic-messages',
        } as Model<Api>
      )
    ).toThrow('Response verbosity high is not supported');
  });
});

describe('isFallbackablePiError', () => {
  it.each([
    'Upstream service temporarily unavailable',
    '{"type":"upstream_error","message":"Upstream request failed"}',
  ])('retries an explicit transient upstream failure: %s', (message) => {
    expect(isFallbackablePiError(new Error(message))).toBe(true);
  });

  it('does not classify a generic client error as retryable', () => {
    expect(isFallbackablePiError(new Error('status 400 invalid request'))).toBe(false);
  });
});
