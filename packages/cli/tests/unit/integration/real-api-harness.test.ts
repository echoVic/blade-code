import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { SessionEvent } from '../../../src/context/types.js';
import type { JsonValue } from '../../../src/store/types.js';
import {
  buildRealApiConfig,
  parseHeadlessJsonl,
  redactSecrets,
} from '../../integration/real-api/codingTaskHarness.js';
import {
  assertForkLineage,
  assertForkChildToolTrace,
  assertForkParentToolTrace,
  assertNoSecrets,
  assertParentUnchanged,
  cleanupForkFixture,
  createForkFixture,
  type DurableToolTraceRecord,
  extractDurableToolTrace,
  findSessionTranscript,
  readSessionEvents,
  startHeldProviderProxy,
} from '../../integration/real-api/sessionForkTrajectoryHarness.js';
import {
  buildRealApiRuntimeConfig,
  normalizeNewApiBaseURL,
  resolveForkQualificationModels,
  resolveModelSettings,
} from '../../integration/real-api/testConfig.js';

vi.unmock('http');
vi.unmock('node:http');

const CREATED_AT = '2026-08-04T00:00:00.000Z';
let createHttpServer: typeof import('node:http').createServer;
let createHttpRequest: typeof import('node:http').request;

beforeAll(async () => {
  const http = await vi.importActual<typeof import('node:http')>('node:http');
  createHttpServer = http.createServer;
  createHttpRequest = http.request;
});

function localHttpRequest(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {}
): Promise<{
  status: number;
  headers: import('node:http').IncomingHttpHeaders;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const request = createHttpRequest(
      url,
      { method: options.method ?? 'GET', headers: options.headers },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          })
        );
      }
    );
    request.once('error', reject);
    request.end(options.body);
  });
}

function createForkCreatedEvent(
  childId: string,
  parentId: string,
  rootId: string
): Extract<SessionEvent, { type: 'session_created' }> {
  return {
    id: `${childId}-created`,
    sessionId: childId,
    timestamp: CREATED_AT,
    type: 'session_created',
    cwd: '/tmp/fork-workspace',
    gitBranch: 'main',
    version: 'test',
    data: {
      sessionId: childId,
      rootId,
      parentId,
      relationType: 'fork',
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    },
  };
}

function createForkBoundaryEvent(
  childId: string,
  parentId: string,
  rootId: string,
  dataOverrides: Partial<
    Extract<SessionEvent, { type: 'session_updated' }>['data']
  > = {}
): Extract<SessionEvent, { type: 'session_updated' }> {
  return {
    id: `${childId}-boundary`,
    sessionId: childId,
    timestamp: CREATED_AT,
    type: 'session_updated',
    cwd: '/tmp/fork-workspace',
    gitBranch: 'main',
    version: 'test',
    data: {
      sessionId: childId,
      rootId,
      parentId,
      relationType: 'fork',
      updatedAt: CREATED_AT,
      ...dataOverrides,
    },
  };
}

function createMessageEvent(
  sessionId: string
): Extract<SessionEvent, { type: 'message_created' }> {
  return {
    id: `${sessionId}-message`,
    sessionId,
    timestamp: CREATED_AT,
    type: 'message_created',
    cwd: '/tmp/fork-workspace',
    gitBranch: 'main',
    version: 'test',
    data: {
      messageId: `${sessionId}-message`,
      role: 'user',
      createdAt: CREATED_AT,
    },
  };
}

function createPartEvent(
  sessionId: string
): Extract<SessionEvent, { type: 'part_created' }> {
  return {
    id: `${sessionId}-part`,
    sessionId,
    timestamp: CREATED_AT,
    type: 'part_created',
    cwd: '/tmp/fork-workspace',
    gitBranch: 'main',
    version: 'test',
    data: {
      partId: `${sessionId}-part`,
      messageId: `${sessionId}-message`,
      partType: 'text',
      payload: { text: 'after fork boundary' },
      createdAt: CREATED_AT,
    },
  };
}

function createToolPartEvent(
  sessionId: string,
  index: number,
  partType: 'tool_call' | 'tool_result',
  payload: JsonValue
): Extract<SessionEvent, { type: 'part_created' }> {
  return {
    id: `${sessionId}-${partType}-${index}`,
    sessionId,
    timestamp: CREATED_AT,
    type: 'part_created',
    cwd: '/tmp/fork-workspace',
    gitBranch: 'main',
    version: 'test',
    data: {
      partId: `${sessionId}-${partType}-${index}`,
      messageId: `${sessionId}-message`,
      partType,
      payload,
      createdAt: CREATED_AT,
    },
  };
}

function thrownMessage(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('Expected action to throw');
}

describe('real API coding-task harness', () => {
  it('imports testConfig without reading the local Blade configuration', async () => {
    vi.resetModules();
    const credentialNames = [
      'DEEPSEEK_API_KEY',
      'CLAUDE_API_KEY',
      'GPT_API_KEY',
      'DOMESTIC_API_KEY',
    ] as const;
    const previousCredentials = new Map(
      credentialNames.map((name) => [name, process.env[name]])
    );
    for (const name of credentialNames) delete process.env[name];
    const readFileSync = vi.fn(() => {
      throw new Error('testConfig import attempted local config I/O');
    });
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
      return { ...actual, readFileSync };
    });

    try {
      await expect(
        import('../../integration/real-api/testConfig.js')
      ).resolves.toHaveProperty('getEnabledModelConfigs');
      expect(readFileSync).not.toHaveBeenCalled();
    } finally {
      for (const name of credentialNames) {
        const previous = previousCredentials.get(name);
        if (previous === undefined) delete process.env[name];
        else process.env[name] = previous;
      }
      vi.doUnmock('node:fs');
      vi.resetModules();
    }
  });

  it('parses versioned JSONL events and reports malformed lines', () => {
    const parsed = parseHeadlessJsonl(
      [
        JSON.stringify({
          event_version: 1,
          type: 'tool_start',
          tool_name: 'Read',
          summary: 'Read src/math.js',
        }),
        'diagnostic line',
        JSON.stringify({ event_version: 1, type: 'content', content: 'done' }),
      ].join('\n')
    );

    expect(parsed.events).toHaveLength(2);
    expect(parsed.events[0]?.type).toBe('tool_start');
    expect(parsed.nonJsonLines).toEqual(['diagnostic line']);
  });

  it('builds a project config that keeps the API key outside the file', () => {
    expect(
      buildRealApiConfig({
        modelId: 'deepseek-v4-flash',
        model: 'deepseek-v4-flash',
        baseUrl: 'https://api.deepseek.com',
      })
    ).toMatchObject({
      currentModelId: 'deepseek-v4-flash',
      models: [
        expect.objectContaining({
          apiKey: '${BLADE_API_KEY}',
          baseUrl: 'https://api.deepseek.com',
          model: 'deepseek-v4-flash',
          provider: 'deepseek',
        }),
      ],
    });
  });

  it('allows a real CLI trajectory to exercise a constrained context window', () => {
    expect(
      buildRealApiConfig({
        modelId: 'deepseek-v4-flash',
        model: 'deepseek-v4-flash',
        baseUrl: 'https://api.deepseek.com',
        maxContextTokens: 24_000,
        maxOutputTokens: 1_024,
      })
    ).toMatchObject({
      models: [
        expect.objectContaining({
          maxContextTokens: 24_000,
          maxOutputTokens: 1_024,
        }),
      ],
    });
  });

  it('redacts provider keys from output without changing unrelated text', () => {
    expect(redactSecrets('key=sk-secret-value; status=ok', ['sk-secret-value'])).toBe(
      'key=[REDACTED]; status=ok'
    );
  });

  it('treats explicit provider credentials as a complete model allowlist', () => {
    const personalModel = {
      id: 'personal-proxy',
      provider: 'openai-compatible',
      model: 'deepseek-v4-pro',
      apiKey: 'personal-secret',
      baseUrl: 'https://personal-proxy.invalid/v1',
    };

    expect(
      resolveModelSettings(
        'domestic',
        'DOMESTIC',
        'qwen-plus',
        'https://default.invalid',
        { DEEPSEEK_API_KEY: 'explicit-secret' },
        personalModel
      )
    ).toEqual({
      apiKey: '',
      baseURL: 'https://default.invalid',
      model: 'qwen-plus',
    });
  });

  it('allows an injected Blade model fallback when no explicit credential exists', () => {
    const fallback = {
      id: 'fake-deepseek',
      provider: 'deepseek',
      model: 'deepseek-fallback-model',
      apiKey: 'fallback-fake-secret',
      baseUrl: 'https://fallback.invalid',
    };

    expect(
      resolveModelSettings(
        'deepseek',
        'DEEPSEEK',
        'deepseek-chat',
        'https://default.invalid',
        {},
        fallback
      )
    ).toEqual({
      apiKey: 'fallback-fake-secret',
      baseURL: 'https://fallback.invalid',
      model: 'deepseek-fallback-model',
    });
  });

  it('normalizes NewAPI channel roots without duplicating the API version', () => {
    expect(normalizeNewApiBaseURL('https://callapi8.com')).toBe(
      'https://callapi8.com/v1'
    );
    expect(normalizeNewApiBaseURL(' `https://callapi8.com/` ')).toBe(
      'https://callapi8.com/v1'
    );
    expect(normalizeNewApiBaseURL('https://callapi8.com/v1')).toBe(
      'https://callapi8.com/v1'
    );
  });

  it('builds an isolated runtime config with only the selected real API model', () => {
    const [modelConfig] = resolveForkQualificationModels(
      {
        DEEPSEEK_API_KEY: 'explicit-secret',
        DEEPSEEK_MODELS: 'deepseek-v4-flash',
      },
      { requiredDeepSeek: false }
    );
    if (!modelConfig) throw new Error('Expected a DeepSeek test model');

    const runtimeConfig = buildRealApiRuntimeConfig(modelConfig);

    expect(runtimeConfig.currentModelId).toMatch(
      /^real-api-deepseek-deepseek-v4-flash-[a-f0-9]{12}$/
    );
    expect(runtimeConfig.models).toEqual([
      expect.objectContaining({
        id: runtimeConfig.currentModelId,
        apiKey: 'explicit-secret',
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-v4-flash',
        provider: 'deepseek',
      }),
    ]);
  });

  it('resolves the required DeepSeek fork qualification matrix in declared order', () => {
    const secret = 'matrix-fake-secret';
    const configs = resolveForkQualificationModels(
      {
        DEEPSEEK_API_KEY: secret,
        DEEPSEEK_BASE_URL: 'https://deepseek.invalid',
        DEEPSEEK_MODELS: ' deepseek-v4-flash, deepseek-v4-pro, deepseek-v4-flash, , ',
      },
      { requiredDeepSeek: true }
    );

    expect(
      configs.map(({ id, model, qualificationId }) => ({
        id,
        model,
        qualificationId,
      }))
    ).toEqual([
      {
        id: 'deepseek',
        model: 'deepseek-v4-flash',
        qualificationId: 'deepseek:deepseek-v4-flash',
      },
      {
        id: 'deepseek',
        model: 'deepseek-v4-pro',
        qualificationId: 'deepseek:deepseek-v4-pro',
      },
    ]);
    const flashModel = configs[0]?.createModel();
    const proModel = configs[1]?.createModel();
    if (typeof flashModel === 'string' || typeof proModel === 'string') {
      throw new Error('Expected provider-backed language models');
    }
    expect(flashModel?.modelId).toBe('deepseek-v4-flash');
    expect(proModel?.modelId).toBe('deepseek-v4-pro');
    expect(new Set(configs.map((config) => config.qualificationId)).size).toBe(2);
    expect(
      JSON.stringify(
        configs.map(({ id, provider, model, qualificationId }) => ({
          id,
          provider,
          model,
          qualificationId,
        }))
      )
    ).not.toContain(secret);
  });

  it('fails closed when either required DeepSeek model or its key is missing', () => {
    const fakeSecret = 'required-deepseek-fake-secret';
    const cases = [
      {
        label: 'Pro',
        env: {
          DEEPSEEK_API_KEY: fakeSecret,
          DEEPSEEK_MODELS: 'deepseek-v4-flash',
        },
      },
      {
        label: 'Flash',
        env: {
          DEEPSEEK_API_KEY: fakeSecret,
          DEEPSEEK_MODELS: 'deepseek-v4-pro',
        },
      },
      {
        label: 'API key',
        env: {
          DEEPSEEK_API_KEY: '  ',
          DEEPSEEK_MODELS: 'deepseek-v4-flash,deepseek-v4-pro',
        },
      },
    ] as const;

    for (const testCase of cases) {
      const message = thrownMessage(() =>
        resolveForkQualificationModels(testCase.env, { requiredDeepSeek: true })
      );
      expect(message).toContain('DeepSeek');
      expect(message).toContain(testCase.label);
      expect(message).not.toContain(fakeSecret);
    }
  });

  it('appends explicitly credentialed provider models in deterministic family order', () => {
    const secrets = [
      'deepseek-fake-secret',
      'claude-fake-secret',
      'gpt-fake-secret',
      'domestic-fake-secret',
    ] as const;
    const configs = resolveForkQualificationModels({
      DEEPSEEK_API_KEY: secrets[0],
      DEEPSEEK_MODELS: 'deepseek-v4-flash,deepseek-v4-pro',
      CLAUDE_API_KEY: secrets[1],
      CLAUDE_MODEL: 'claude-test-model',
      GPT_API_KEY: secrets[2],
      GPT_MODEL: 'gpt-test-model',
      DOMESTIC_API_KEY: secrets[3],
      DOMESTIC_MODEL: 'domestic-test-model',
    });
    const safeProjection = configs.map(({ id, provider, model, qualificationId }) => ({
      id,
      provider,
      model,
      qualificationId,
    }));

    expect(safeProjection).toEqual([
      {
        id: 'deepseek',
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
        qualificationId: 'deepseek:deepseek-v4-flash',
      },
      {
        id: 'deepseek',
        provider: 'deepseek',
        model: 'deepseek-v4-pro',
        qualificationId: 'deepseek:deepseek-v4-pro',
      },
      {
        id: 'claude',
        provider: 'anthropic',
        model: 'claude-test-model',
        qualificationId: 'claude:claude-test-model',
      },
      {
        id: 'gpt',
        provider: 'openai-compatible',
        model: 'gpt-test-model',
        qualificationId: 'gpt:gpt-test-model',
      },
      {
        id: 'domestic',
        provider: 'openai-compatible',
        model: 'domestic-test-model',
        qualificationId: 'domestic:domestic-test-model',
      },
    ]);
    expect(() => assertNoSecrets(safeProjection, secrets)).not.toThrow();
  });

  it('keeps an explicit empty environment isolated from local Blade credentials', () => {
    expect(resolveForkQualificationModels({})).toEqual([]);
  });

  it('does not mix local provider credentials into an explicit provider matrix', () => {
    const configs = resolveForkQualificationModels({
      CLAUDE_API_KEY: 'claude-only-fake-secret',
      CLAUDE_MODEL: 'claude-only-test-model',
    });

    expect(
      configs.map(({ id, model, qualificationId }) => ({
        id,
        model,
        qualificationId,
      }))
    ).toEqual([
      {
        id: 'claude',
        model: 'claude-only-test-model',
        qualificationId: 'claude:claude-only-test-model',
      },
    ]);
  });

  it('uses unique sanitized runtime IDs for Flash and Pro without key material', () => {
    const fakeSecret = 'runtime-id-fake-secret';
    const configs = resolveForkQualificationModels(
      {
        DEEPSEEK_API_KEY: fakeSecret,
        DEEPSEEK_MODELS: 'deepseek-v4-flash,deepseek-v4-pro',
      },
      { requiredDeepSeek: true }
    );
    const runtimeIds = configs.map(
      (config) => buildRealApiRuntimeConfig(config).currentModelId
    );

    expect(new Set(runtimeIds).size).toBe(2);
    expect(runtimeIds.every((id) => /^[a-z0-9-]+$/.test(id))).toBe(true);
    expect(runtimeIds.every((id) => /-[a-f0-9]{12}$/.test(id))).toBe(true);
    expect(runtimeIds.every((id) => id.length <= 80)).toBe(true);
    expect(runtimeIds.join(' ')).not.toContain(fakeSecret);
  });

  it('builds stable bounded runtime IDs without exposing a long model label', () => {
    const longModel = `sensitivepurealphabeticlabel${'x'.repeat(180)}`;
    const [config] = resolveForkQualificationModels({
      DEEPSEEK_API_KEY: 'bounded-id-fake-secret',
      DEEPSEEK_MODELS: longModel,
    });
    if (!config) throw new Error('Expected a long-model config');

    const first = buildRealApiRuntimeConfig(config).currentModelId;
    const second = buildRealApiRuntimeConfig(config).currentModelId;
    expect(first).toBe(second);
    expect(first.length).toBeLessThanOrEqual(80);
    expect(first).toMatch(/^real-api-[a-z0-9-]+-[a-f0-9]{12}$/);
    expect(first).not.toContain(longModel);
    expect(first).not.toContain(config.qualificationId);
  });

  it('keeps sanitized runtime IDs collision-free for punctuation-distinct models', () => {
    const configs = resolveForkQualificationModels({
      DEEPSEEK_API_KEY: 'collision-fake-secret',
      DEEPSEEK_MODELS: 'model/variant,model?variant',
    });
    const runtimeIds = configs.map(
      (config) => buildRealApiRuntimeConfig(config).currentModelId
    );

    expect(new Set(runtimeIds).size).toBe(2);
    expect(runtimeIds.every((id) => /^[a-z0-9-]+$/.test(id))).toBe(true);
  });
});

describe('real API session-fork trajectory harness', () => {
  it('accepts repeated exact successful parent Reads', () => {
    const memoryPath = '/workspace/memory.txt';
    const reads = ['read-1', 'read-2', 'read-3'].map((toolCallId) => ({
      toolCallId,
      toolName: 'Read',
      input: { file_path: memoryPath },
      output: { text: 'fixture output' },
      error: null,
    }));

    expect(() => assertForkParentToolTrace(reads, memoryPath)).not.toThrow();
  });

  it('rejects empty, wrong-path, unexpected, and failed parent traces', () => {
    const memoryPath = '/workspace/memory.txt';
    const valid = {
      toolCallId: 'read-1',
      toolName: 'Read',
      input: { file_path: memoryPath },
      output: { text: 'fixture output' },
      error: null,
    };

    expect(() => assertForkParentToolTrace([], memoryPath)).toThrow();
    expect(() =>
      assertForkParentToolTrace(
        [{ ...valid, input: { file_path: '/workspace/other.txt' } }],
        memoryPath
      )
    ).toThrow();
    expect(() =>
      assertForkParentToolTrace([{ ...valid, toolName: 'Bash' }], memoryPath)
    ).toThrow();
    expect(() =>
      assertForkParentToolTrace([{ ...valid, output: null }], memoryPath)
    ).toThrow();
    expect(() =>
      assertForkParentToolTrace([{ ...valid, error: 'failed' }], memoryPath)
    ).toThrow();
  });

  it('accepts repeated exact child Write and wc calls in required order', () => {
    const resultPath = '/workspace/result.txt';
    const expectedBytes = 'fixture-marker\n';
    const write = (toolCallId: string) => ({
      toolCallId,
      toolName: 'Write',
      input: { file_path: resultPath, content: expectedBytes },
      output: { written: true },
      error: null,
    });
    const bash = (toolCallId: string) => ({
      toolCallId,
      toolName: 'Bash',
      input: { command: 'wc -c result.txt' },
      output: { stdout: '15 result.txt' },
      error: null,
    });

    expect(() =>
      assertForkChildToolTrace(
        [write('write-1'), write('write-2'), bash('bash-1'), bash('bash-2')],
        resultPath,
        expectedBytes
      )
    ).not.toThrow();
  });

  it('rejects incomplete, reordered, unexpected, mismatched, and failed child traces', () => {
    const resultPath = '/workspace/result.txt';
    const expectedBytes = 'fixture-marker\n';
    const write: DurableToolTraceRecord = {
      toolCallId: 'write-1',
      toolName: 'Write',
      input: { file_path: resultPath, content: expectedBytes },
      output: { written: true },
      error: null,
    };
    const bash: DurableToolTraceRecord = {
      toolCallId: 'bash-1',
      toolName: 'Bash',
      input: { command: 'wc -c result.txt' },
      output: { stdout: '15 result.txt' },
      error: null,
    };
    const assertRejected = (trace: DurableToolTraceRecord[]) =>
      expect(() =>
        assertForkChildToolTrace(trace, resultPath, expectedBytes)
      ).toThrow();

    assertRejected([write]);
    assertRejected([bash]);
    assertRejected([bash, write]);
    assertRejected([write, { ...bash, input: { command: 'cat result.txt' } }]);
    assertRejected([write, { ...bash, toolName: 'Read' }]);
    assertRejected([
      { ...write, input: { file_path: resultPath, content: 'wrong' } },
      bash,
    ]);
    assertRejected([{ ...write, output: null }, bash]);
    assertRejected([write, { ...bash, error: 'failed' }]);
  });

  it('pairs durable tool calls and results in call order after a snapshot boundary', () => {
    const inherited = createToolPartEvent('child', 0, 'tool_call', {
      toolCallId: 'inherited-read',
      toolName: 'Read',
      input: { file_path: '/workspace/memory.txt' },
    });
    const events: SessionEvent[] = [
      inherited,
      createToolPartEvent('child', 1, 'tool_call', {
        toolCallId: 'write-1',
        toolName: 'Write',
        input: { file_path: '/workspace/result.txt', content: 'marker\n' },
      }),
      createToolPartEvent('child', 2, 'tool_result', {
        toolCallId: 'write-1',
        toolName: 'Write',
        output: { success: true },
        error: null,
      }),
      createToolPartEvent('child', 3, 'tool_call', {
        toolCallId: 'bash-1',
        toolName: 'Bash',
        input: { command: 'wc -c result.txt' },
      }),
      createToolPartEvent('child', 4, 'tool_result', {
        toolCallId: 'bash-1',
        toolName: 'Bash',
        output: { success: true },
        error: null,
      }),
    ];

    expect(extractDurableToolTrace(events, { afterEventCount: 1 })).toEqual([
      {
        toolCallId: 'write-1',
        toolName: 'Write',
        input: { file_path: '/workspace/result.txt', content: 'marker\n' },
        output: { success: true },
        error: null,
      },
      {
        toolCallId: 'bash-1',
        toolName: 'Bash',
        input: { command: 'wc -c result.txt' },
        output: { success: true },
        error: null,
      },
    ]);
  });

  it('rejects orphan, duplicate, mismatched, and incomplete durable tool records', () => {
    const call = createToolPartEvent('child', 1, 'tool_call', {
      toolCallId: 'call-1',
      toolName: 'Write',
      input: {},
    });
    const result = createToolPartEvent('child', 2, 'tool_result', {
      toolCallId: 'call-1',
      toolName: 'Write',
      output: {},
      error: null,
    });

    expect(() => extractDurableToolTrace([result])).toThrow(/orphan/i);
    expect(() => extractDurableToolTrace([call, call, result])).toThrow(
      /duplicate.*call/i
    );
    expect(() => extractDurableToolTrace([call, result, result])).toThrow(
      /duplicate.*result/i
    );
    expect(() =>
      extractDurableToolTrace([
        call,
        createToolPartEvent('child', 3, 'tool_result', {
          toolCallId: 'call-1',
          toolName: 'Bash',
          output: {},
          error: null,
        }),
      ])
    ).toThrow(/name.*mismatch/i);
    expect(() => extractDurableToolTrace([call])).toThrow(/missing.*result/i);
  });
  it('creates unique sanitized fixtures and cleans only their registered roots', () => {
    const first = createForkFixture('../../TUI surface', '../DeepSeek/Flash?');
    const second = createForkFixture('../../TUI surface', '../DeepSeek/Flash?');
    const firstRoot = path.dirname(first.workspace);
    const secondRoot = path.dirname(second.workspace);

    try {
      expect(firstRoot).not.toBe(secondRoot);
      expect(first.workspace.startsWith(`${firstRoot}${path.sep}`)).toBe(true);
      expect(first.storageRoot.startsWith(`${firstRoot}${path.sep}`)).toBe(true);
      expect(first.resultPath.startsWith(`${firstRoot}${path.sep}`)).toBe(true);
      expect(first.nonce).toMatch(/^[a-z0-9-]+$/);
      expect(firstRoot).not.toContain('..');
      expect(existsSync(first.workspace)).toBe(true);
      expect(existsSync(first.storageRoot)).toBe(true);
    } finally {
      cleanupForkFixture(first);
      cleanupForkFixture(second);
    }

    expect(existsSync(firstRoot)).toBe(false);
    expect(existsSync(secondRoot)).toBe(false);
  });

  it('cleans a registered fixture idempotently without deleting sibling roots', () => {
    const fixture = createForkFixture('headless', 'deepseek-v4-flash');
    const sibling = createForkFixture('headless', 'deepseek-v4-pro');
    const siblingRoot = path.dirname(sibling.workspace);

    try {
      cleanupForkFixture(fixture);
      expect(() => cleanupForkFixture(fixture)).not.toThrow();
      expect(existsSync(siblingRoot)).toBe(true);
      expect(() =>
        cleanupForkFixture({
          workspace: fixture.workspace,
          storageRoot: fixture.storageRoot,
          nonce: fixture.nonce,
          resultPath: fixture.resultPath,
        })
      ).toThrow(/unregistered/i);
    } finally {
      cleanupForkFixture(sibling);
    }
  });

  it('finds exactly one transcript recursively and rejects missing or ambiguous IDs', () => {
    const storageRoot = mkdtempSync(path.join(os.tmpdir(), 'blade-transcript-find-'));
    const firstDirectory = path.join(storageRoot, 'projects', 'workspace-a');
    const secondDirectory = path.join(storageRoot, 'projects', 'workspace-b');
    mkdirSync(firstDirectory, { recursive: true });
    mkdirSync(secondDirectory, { recursive: true });
    const firstPath = path.join(firstDirectory, 'child-session.jsonl');
    writeFileSync(
      firstPath,
      `${JSON.stringify(
        createForkCreatedEvent('child-session', 'parent-session', 'root-session')
      )}\n`
    );

    try {
      expect(findSessionTranscript(storageRoot, 'child-session')).toBe(firstPath);
      expect(() => findSessionTranscript(storageRoot, 'missing-session')).toThrow(
        /missing-session.*not found/i
      );

      writeFileSync(
        path.join(secondDirectory, 'child-session.jsonl'),
        `${JSON.stringify(
          createForkCreatedEvent('child-session', 'other-parent', 'other-root')
        )}\n`
      );
      expect(() => findSessionTranscript(storageRoot, 'child-session')).toThrow(
        /child-session.*multiple/i
      );
    } finally {
      rmSync(storageRoot, { recursive: true, force: true });
    }
  });

  it('reads validated session JSONL with a trailing blank line', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'blade-session-events-'));
    const transcriptPath = path.join(root, 'child-session.jsonl');
    const event = createForkCreatedEvent(
      'child-session',
      'parent-session',
      'root-session'
    );
    writeFileSync(transcriptPath, `${JSON.stringify(event)}\n\n`);

    try {
      expect(readSessionEvents(transcriptPath)).toEqual([event]);
      writeFileSync(transcriptPath, `${JSON.stringify(event)}\n{bad json}\n`);
      expect(() => readSessionEvents(transcriptPath)).toThrow(/line 2/i);
      writeFileSync(transcriptPath, '{"type":"session_created"}\n');
      expect(() => readSessionEvents(transcriptPath)).toThrow(/session event.*line 1/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects coercible non-string message roles and part types', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'blade-session-enum-types-'));
    const transcriptPath = path.join(root, 'child-session.jsonl');
    const message = createMessageEvent('child-session');
    const part = createPartEvent('child-session');

    try {
      writeFileSync(
        transcriptPath,
        `${JSON.stringify({ ...message, data: { ...message.data, role: ['user'] } })}\n`
      );
      expect(() => readSessionEvents(transcriptPath)).toThrow(/session event/i);
      writeFileSync(
        transcriptPath,
        `${JSON.stringify({ ...part, data: { ...part.data, partType: ['text'] } })}\n`
      );
      expect(() => readSessionEvents(transcriptPath)).toThrow(/session event/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects blank lines between durable session records', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'blade-session-blank-line-'));
    const transcriptPath = path.join(root, 'child-session.jsonl');
    const created = createForkCreatedEvent(
      'child-session',
      'parent-session',
      'root-session'
    );
    const boundary = createForkBoundaryEvent(
      'child-session',
      'parent-session',
      'root-session'
    );
    writeFileSync(
      transcriptPath,
      `${JSON.stringify(created)}\n   \n${JSON.stringify(boundary)}\n`
    );

    try {
      expect(() => readSessionEvents(transcriptPath)).toThrow(/blank.*line 2/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a transcript whose durable created identity does not match its file', () => {
    const storageRoot = mkdtempSync(path.join(os.tmpdir(), 'blade-transcript-id-'));
    const projectDirectory = path.join(storageRoot, 'projects', 'workspace-a');
    mkdirSync(projectDirectory, { recursive: true });
    writeFileSync(
      path.join(projectDirectory, 'requested-session.jsonl'),
      `${JSON.stringify(
        createForkCreatedEvent('different-session', 'parent-session', 'root-session')
      )}\n`
    );

    try {
      expect(() => findSessionTranscript(storageRoot, 'requested-session')).toThrow(
        /requested-session.*session_created.*sessionId/i
      );
    } finally {
      rmSync(storageRoot, { recursive: true, force: true });
    }
  });

  it('validates durable fork child, parent, root, and relation lineage', () => {
    const expected = {
      childId: 'child-session',
      parentId: 'parent-session',
      rootId: 'root-session',
    };
    const valid = createForkCreatedEvent(
      expected.childId,
      expected.parentId,
      expected.rootId
    );

    const boundary = createForkBoundaryEvent(
      expected.childId,
      expected.parentId,
      expected.rootId
    );
    expect(() =>
      assertForkLineage(
        [valid, createMessageEvent(expected.childId), boundary],
        expected
      )
    ).not.toThrow();
    expect(() =>
      assertForkLineage(
        [
          createForkCreatedEvent('wrong-child', expected.parentId, expected.rootId),
          boundary,
        ],
        expected
      )
    ).toThrow(/child.*child-session/i);
    expect(() =>
      assertForkLineage(
        [
          createForkCreatedEvent(expected.childId, 'wrong-parent', expected.rootId),
          boundary,
        ],
        expected
      )
    ).toThrow(/parent.*parent-session/i);
    expect(() =>
      assertForkLineage(
        [
          createForkCreatedEvent(expected.childId, expected.parentId, 'wrong-root'),
          boundary,
        ],
        expected
      )
    ).toThrow(/root.*root-session/i);
    const wrongRelation: Extract<SessionEvent, { type: 'session_created' }> = {
      ...valid,
      data: { ...valid.data, relationType: 'subagent' },
    };
    expect(() => assertForkLineage([wrongRelation, boundary], expected)).toThrow(
      /relation.*fork/i
    );
  });

  it('rejects any fork event with a non-child top-level session ID', () => {
    const expected = {
      childId: 'child-session',
      parentId: 'parent-session',
      rootId: 'root-session',
    };
    const wrongMessage = createMessageEvent('wrong-child');

    expect(() =>
      assertForkLineage(
        [
          createForkCreatedEvent(expected.childId, expected.parentId, expected.rootId),
          wrongMessage,
          createForkBoundaryEvent(expected.childId, expected.parentId, expected.rootId),
        ],
        expected
      )
    ).toThrow(/event.*session ID.*child-session/i);
  });

  it('requires exactly one session_created event at transcript index zero', () => {
    const expected = {
      childId: 'child-session',
      parentId: 'parent-session',
      rootId: 'root-session',
    };
    const created = createForkCreatedEvent(
      expected.childId,
      expected.parentId,
      expected.rootId
    );
    const boundary = createForkBoundaryEvent(
      expected.childId,
      expected.parentId,
      expected.rootId
    );

    expect(() =>
      assertForkLineage(
        [createMessageEvent(expected.childId), created, boundary],
        expected
      )
    ).toThrow(/session_created.*first/i);
    expect(() => assertForkLineage([created, created, boundary], expected)).toThrow(
      /exactly one session_created/i
    );
  });

  it('rejects conflicting lineage fields on intermediate session updates', () => {
    const expected = {
      childId: 'child-session',
      parentId: 'parent-session',
      rootId: 'root-session',
    };
    const created = createForkCreatedEvent(
      expected.childId,
      expected.parentId,
      expected.rootId
    );
    const boundary = createForkBoundaryEvent(
      expected.childId,
      expected.parentId,
      expected.rootId
    );
    const conflicts: Array<
      Partial<Extract<SessionEvent, { type: 'session_updated' }>['data']>
    > = [
      { sessionId: 'wrong-child' },
      { rootId: 'wrong-root' },
      { parentId: 'wrong-parent' },
      { relationType: 'subagent' },
    ];

    for (const conflict of conflicts) {
      expect(() =>
        assertForkLineage(
          [
            created,
            {
              ...createForkBoundaryEvent(
                expected.childId,
                expected.parentId,
                expected.rootId,
                conflict
              ),
              id: `intermediate-${Object.keys(conflict)[0]}`,
            },
            boundary,
          ],
          expected
        )
      ).toThrow(/session_updated.*lineage/i);
    }
  });

  it('requires a complete fork lineage boundary', () => {
    const expected = {
      childId: 'child-session',
      parentId: 'parent-session',
      rootId: 'root-session',
    };
    const created = createForkCreatedEvent(
      expected.childId,
      expected.parentId,
      expected.rootId
    );

    expect(() =>
      assertForkLineage([created, createMessageEvent(expected.childId)], expected)
    ).toThrow(/complete fork boundary/i);
    expect(() =>
      assertForkLineage(
        [
          created,
          createForkBoundaryEvent(
            expected.childId,
            expected.parentId,
            expected.rootId,
            { parentId: undefined }
          ),
        ],
        expected
      )
    ).toThrow(/complete.*fork boundary/i);
  });

  it('accepts child message and part appends after the complete fork boundary', () => {
    const expected = {
      childId: 'child-session',
      parentId: 'parent-session',
      rootId: 'root-session',
    };

    expect(() =>
      assertForkLineage(
        [
          createForkCreatedEvent(expected.childId, expected.parentId, expected.rootId),
          createForkBoundaryEvent(expected.childId, expected.parentId, expected.rootId),
          createMessageEvent(expected.childId),
          createPartEvent(expected.childId),
        ],
        expected
      )
    ).not.toThrow();
  });

  it('detects parent transcript mutation without including transcript contents', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'blade-parent-unchanged-'));
    const parentPath = path.join(root, 'parent-session.jsonl');
    const before = 'safe parent bytes\n';
    writeFileSync(parentPath, before);

    try {
      expect(() => assertParentUnchanged(before, parentPath)).not.toThrow();
      writeFileSync(parentPath, 'mutated secret-bearing bytes\n');
      const message = thrownMessage(() => assertParentUnchanged(before, parentPath));
      expect(message).toContain(parentPath);
      expect(message).not.toContain('mutated secret-bearing bytes');
      expect(readFileSync(parentPath, 'utf8')).not.toBe(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('checks cyclic and non-JSON evidence for secrets without echoing them', () => {
    const fakeSecret = 'evidence-fake-secret';
    const safeEvidence: {
      self?: unknown;
      count: bigint;
      missing: undefined;
      error: Error;
    } = {
      count: 42n,
      missing: undefined,
      error: new Error('safe error'),
    };
    safeEvidence.self = safeEvidence;
    expect(() => assertNoSecrets(safeEvidence, [fakeSecret, ''])).not.toThrow();

    const firstFakeSecret = 'first-fake-secret';
    const unsafeEvidence = new Map<unknown, unknown>([
      ['error', new Error('outer', { cause: { nested: firstFakeSecret } })],
      [{ key: fakeSecret }, new Set([42n])],
    ]);
    unsafeEvidence.set('self', unsafeEvidence);
    const message = thrownMessage(() =>
      assertNoSecrets(unsafeEvidence, [fakeSecret, firstFakeSecret])
    );
    expect(message).toContain(
      'Secret material #2 found at $.map[0].value.cause.nested'
    );
    expect(message).not.toContain(fakeSecret);
    expect(message).not.toContain(firstFakeSecret);
  });

  it('reports the original secret index while ignoring empty secret entries', () => {
    const fakeSecret = 'indexed-fake-secret';
    const message = thrownMessage(() =>
      assertNoSecrets({ value: fakeSecret }, ['', fakeSecret])
    );

    expect(message).toBe('Secret material #2 found at $.value');
    expect(message).not.toContain(fakeSecret);
  });

  it('finds secrets in byte arrays, non-enumerable values, and symbol keys without invoking getters', () => {
    const byteSecret = 'buffer-fake-secret';
    const hiddenSecret = 'hidden-fake-secret';
    const symbolSecret = 'symbol-fake-secret';
    let getterCalls = 0;
    const evidence = {
      buffer: Buffer.from(byteSecret),
      bytes: Uint8Array.from(Buffer.from(byteSecret)),
    };
    Object.defineProperty(evidence, 'hidden', {
      value: hiddenSecret,
      enumerable: false,
    });
    Object.defineProperty(evidence, Symbol(symbolSecret), {
      value: 'safe',
      enumerable: false,
    });
    Object.defineProperty(evidence, 'dangerousGetter', {
      get: () => {
        getterCalls++;
        return 'getter-fake-secret';
      },
    });

    expect(thrownMessage(() => assertNoSecrets(evidence.buffer, [byteSecret]))).toBe(
      'Secret material #1 found at $'
    );
    expect(thrownMessage(() => assertNoSecrets(evidence, [hiddenSecret]))).toContain(
      '$.hidden'
    );
    expect(thrownMessage(() => assertNoSecrets(evidence, [symbolSecret]))).toContain(
      '[symbol#'
    );
    expect(getterCalls).toBe(0);
  });

  it('reports an actionable scan error without echoing a Proxy ownKeys failure', () => {
    const fakeSecret = 'ownkeys-fake-secret';
    const evidence = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error(fakeSecret);
        },
      }
    );

    const message = thrownMessage(() => assertNoSecrets(evidence, [fakeSecret]));
    expect(message).toContain('Unable to inspect evidence at $');
    expect(message).not.toContain(fakeSecret);
  });

  it('holds, releases, streams, and redacts a local provider request', async () => {
    let upstreamRequest:
      | {
          method: string;
          url: string;
          body: string;
          authorization?: string;
          requestHopHeaders: Record<string, string | undefined>;
        }
      | undefined;
    let releaseSecondChunk: () => void = () => undefined;
    const secondChunkGate = new Promise<void>((resolve) => {
      releaseSecondChunk = resolve;
    });
    const upstream: Server = createHttpServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        upstreamRequest = {
          method: request.method ?? '',
          url: request.url ?? '',
          body: Buffer.concat(chunks).toString('utf8'),
          authorization: request.headers.authorization,
          requestHopHeaders: {},
        };
        response.writeHead(201, {
          'content-type': 'text/event-stream',
          'x-upstream': 'streamed',
        });
        response.write('data: first\n\n');
        void secondChunkGate.then(() => response.end('data: second\n\n'));
      });
    });
    await new Promise<void>((resolve, reject) => {
      upstream.once('error', reject);
      upstream.listen(0, '127.0.0.1', () => {
        upstream.off('error', reject);
        resolve();
      });
    });
    const upstreamAddress = upstream.address() as AddressInfo;
    const proxy = await startHeldProviderProxy(
      `http://127.0.0.1:${upstreamAddress.port}/provider?token=upstream-query-secret`
    );
    const requestBody = '{"prompt":"body-fake-secret"}';

    try {
      const responsePromise = fetch(
        `${proxy.baseUrl}/v1/messages?mode=stream&key=request-query-secret`,
        {
          method: 'POST',
          headers: {
            authorization: 'Bearer header-fake-secret',
            cookie: 'session=cookie-fake-secret',
            'content-type': 'application/json',
            'x-api-key': 'api-key-fake-secret',
          },
          body: requestBody,
        }
      );
      await proxy.requestHeld;
      expect(upstreamRequest).toBeUndefined();
      expect(proxy.redactedEvidence()).toEqual({
        upstream: {
          origin: `http://127.0.0.1:${upstreamAddress.port}`,
          pathname: '/provider',
        },
        requests: [{ method: 'POST', pathname: '/v1/messages', bodyBytes: 29 }],
      });

      proxy.release();
      const response = await Promise.race([
        responsePromise,
        new Promise<never>((_resolve, reject) =>
          setTimeout(
            () => reject(new Error('Proxy buffered the upstream streaming response')),
            1_000
          )
        ),
      ]);
      expect(response.status).toBe(201);
      expect(response.headers.get('x-upstream')).toBe('streamed');
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Expected a streaming response body');
      const firstChunk = await reader.read();
      expect(Buffer.from(firstChunk.value ?? []).toString('utf8')).toBe(
        'data: first\n\n'
      );
      releaseSecondChunk();
      const secondChunk = await reader.read();
      expect(Buffer.from(secondChunk.value ?? []).toString('utf8')).toBe(
        'data: second\n\n'
      );
      expect(await reader.read()).toMatchObject({ done: true });
      expect(upstreamRequest).toEqual({
        method: 'POST',
        url: '/provider/v1/messages?token=upstream-query-secret&mode=stream&key=request-query-secret',
        body: requestBody,
        authorization: 'Bearer header-fake-secret',
        requestHopHeaders: {},
      });
      expect(() =>
        assertNoSecrets(proxy.redactedEvidence(), [
          'upstream-query-secret',
          'request-query-secret',
          'body-fake-secret',
          'header-fake-secret',
          'cookie-fake-secret',
          'api-key-fake-secret',
        ])
      ).not.toThrow();
      await proxy.close();
      await proxy.close();
    } finally {
      releaseSecondChunk();
      await proxy.close();
      await new Promise<void>((resolve, reject) => {
        upstream.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it('filters standard and Connection-declared request hop-by-hop headers', async () => {
    let upstreamHeaders: import('node:http').IncomingHttpHeaders | undefined;
    const upstream: Server = createHttpServer((request, response) => {
      upstreamHeaders = request.headers;
      response.end('forwarded');
    });
    await new Promise<void>((resolve, reject) => {
      upstream.once('error', reject);
      upstream.listen(0, '127.0.0.1', () => {
        upstream.off('error', reject);
        resolve();
      });
    });
    const upstreamAddress = upstream.address() as AddressInfo;
    const proxy = await startHeldProviderProxy(
      `http://127.0.0.1:${upstreamAddress.port}`
    );

    try {
      const responsePromise = localHttpRequest(`${proxy.baseUrl}/headers`, {
        method: 'POST',
        headers: {
          connection: 'x-request-hop, keep-alive',
          'keep-alive': 'timeout=5',
          'proxy-authorization': 'fake-request-proxy-auth',
          te: 'trailers',
          trailer: 'x-trailer',
          upgrade: 'fake-upgrade',
          'x-request-hop': 'fake-request-hop',
          'x-end-to-end': 'preserved',
        },
        body: 'request-body',
      });
      await proxy.requestHeld;
      proxy.release();
      const response = await responsePromise;

      expect(response.status).toBe(200);
      expect(upstreamHeaders?.connection).toBe('keep-alive');
      expect(upstreamHeaders?.['keep-alive']).toBeUndefined();
      expect(upstreamHeaders?.['proxy-authorization']).toBeUndefined();
      expect(upstreamHeaders?.te).toBeUndefined();
      expect(upstreamHeaders?.trailer).toBeUndefined();
      expect(upstreamHeaders?.upgrade).toBeUndefined();
      expect(upstreamHeaders?.['x-request-hop']).toBeUndefined();
      expect(upstreamHeaders?.['x-end-to-end']).toBe('preserved');
    } finally {
      await proxy.close();
      await new Promise<void>((resolve, reject) => {
        upstream.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it('filters standard and Connection-declared response hop-by-hop headers', async () => {
    const upstream: Server = createHttpServer((_request, response) => {
      response.writeHead(200, {
        connection: 'x-response-hop, keep-alive',
        'keep-alive': 'timeout=99, max=1',
        'proxy-authenticate': 'fake-response-proxy-auth',
        trailer: 'x-trailer',
        upgrade: 'fake-upgrade',
        'x-response-hop': 'fake-response-hop',
        'x-end-to-end': 'preserved',
      });
      response.end('response-body');
    });
    await new Promise<void>((resolve, reject) => {
      upstream.once('error', reject);
      upstream.listen(0, '127.0.0.1', () => {
        upstream.off('error', reject);
        resolve();
      });
    });
    const upstreamAddress = upstream.address() as AddressInfo;
    const proxy = await startHeldProviderProxy(
      `http://127.0.0.1:${upstreamAddress.port}`
    );

    try {
      const responsePromise = localHttpRequest(`${proxy.baseUrl}/headers`);
      await proxy.requestHeld;
      proxy.release();
      const response = await responsePromise;

      expect(response.status).toBe(200);
      expect(response.headers.connection).not.toContain('x-response-hop');
      expect(response.headers['keep-alive']).not.toContain('timeout=99');
      expect(response.headers['proxy-authenticate']).toBeUndefined();
      expect(response.headers.trailer).toBeUndefined();
      expect(response.headers.upgrade).toBeUndefined();
      expect(response.headers['x-response-hop']).toBeUndefined();
      expect(response.headers['x-end-to-end']).toBe('preserved');
    } finally {
      await proxy.close();
      await new Promise<void>((resolve, reject) => {
        upstream.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it('preserves multiple Set-Cookie response header values', async () => {
    const upstream: Server = createHttpServer((_request, response) => {
      response.writeHead(200, {
        'set-cookie': ['first=fake-one; Path=/', 'second=fake-two; HttpOnly'],
      });
      response.end('cookies');
    });
    await new Promise<void>((resolve, reject) => {
      upstream.once('error', reject);
      upstream.listen(0, '127.0.0.1', () => {
        upstream.off('error', reject);
        resolve();
      });
    });
    const upstreamAddress = upstream.address() as AddressInfo;
    const proxy = await startHeldProviderProxy(
      `http://127.0.0.1:${upstreamAddress.port}`
    );

    try {
      const responsePromise = localHttpRequest(`${proxy.baseUrl}/cookies`);
      await proxy.requestHeld;
      proxy.release();
      const response = await responsePromise;

      expect(response.headers['set-cookie']).toEqual([
        'first=fake-one; Path=/',
        'second=fake-two; HttpOnly',
      ]);
    } finally {
      await proxy.close();
      await new Promise<void>((resolve, reject) => {
        upstream.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it('closes an unreleased held proxy without hanging', async () => {
    const upstream: Server = createHttpServer((_request, response) =>
      response.end('unused')
    );
    await new Promise<void>((resolve, reject) => {
      upstream.once('error', reject);
      upstream.listen(0, '127.0.0.1', () => {
        upstream.off('error', reject);
        resolve();
      });
    });
    const upstreamAddress = upstream.address() as AddressInfo;
    const proxy = await startHeldProviderProxy(
      `http://127.0.0.1:${upstreamAddress.port}`
    );
    const pendingFetch = fetch(`${proxy.baseUrl}/held`, {
      method: 'POST',
      body: 'held',
    }).catch(() => undefined);

    try {
      await proxy.requestHeld;
      await expect(
        Promise.race([
          proxy.close().then(() => 'closed'),
          new Promise<string>((resolve) =>
            setTimeout(() => resolve('timed-out'), 1_000)
          ),
        ])
      ).resolves.toBe('closed');
      await pendingFetch;
    } finally {
      await proxy.close();
      await new Promise<void>((resolve, reject) => {
        upstream.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it('rejects requestHeld when closed before the first provider request', async () => {
    const upstream: Server = createHttpServer((_request, response) =>
      response.end('unused')
    );
    await new Promise<void>((resolve, reject) => {
      upstream.once('error', reject);
      upstream.listen(0, '127.0.0.1', () => {
        upstream.off('error', reject);
        resolve();
      });
    });
    const upstreamAddress = upstream.address() as AddressInfo;
    const proxy = await startHeldProviderProxy(
      `http://127.0.0.1:${upstreamAddress.port}`
    );
    const heldRejection = expect(proxy.requestHeld).rejects.toThrow(
      'Held provider proxy closed before first request'
    );

    try {
      await proxy.close();
      await heldRejection;
      await expect(proxy.close()).resolves.toBeUndefined();
    } finally {
      await proxy.close();
      await new Promise<void>((resolve, reject) => {
        upstream.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
