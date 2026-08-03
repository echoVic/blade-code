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
import {
  buildRealApiConfig,
  parseHeadlessJsonl,
  redactSecrets,
} from '../../integration/real-api/codingTaskHarness.js';
import {
  assertForkLineage,
  assertNoSecrets,
  assertParentUnchanged,
  cleanupForkFixture,
  createForkFixture,
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

beforeAll(async () => {
  const http = await vi.importActual<typeof import('node:http')>('node:http');
  createHttpServer = http.createServer;
});

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

function thrownMessage(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('Expected action to throw');
}

describe('real API coding-task harness', () => {
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

    expect(runtimeConfig.currentModelId).toBe('real-api-deepseek-deepseek-v4-flash');
    expect(runtimeConfig.models).toEqual([
      expect.objectContaining({
        id: 'real-api-deepseek-deepseek-v4-flash',
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

    expect(runtimeIds).toEqual([
      'real-api-deepseek-deepseek-v4-flash',
      'real-api-deepseek-deepseek-v4-pro',
    ]);
    expect(new Set(runtimeIds).size).toBe(2);
    expect(runtimeIds.every((id) => /^[a-z0-9-]+$/.test(id))).toBe(true);
    expect(runtimeIds.join(' ')).not.toContain(fakeSecret);
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

    expect(() => assertForkLineage([valid], expected)).not.toThrow();
    expect(() =>
      assertForkLineage(
        [createForkCreatedEvent('wrong-child', expected.parentId, expected.rootId)],
        expected
      )
    ).toThrow(/child.*child-session/i);
    expect(() =>
      assertForkLineage(
        [createForkCreatedEvent(expected.childId, 'wrong-parent', expected.rootId)],
        expected
      )
    ).toThrow(/parent.*parent-session/i);
    expect(() =>
      assertForkLineage(
        [createForkCreatedEvent(expected.childId, expected.parentId, 'wrong-root')],
        expected
      )
    ).toThrow(/root.*root-session/i);
    const wrongRelation: Extract<SessionEvent, { type: 'session_created' }> = {
      ...valid,
      data: { ...valid.data, relationType: 'subagent' },
    };
    expect(() => assertForkLineage([wrongRelation], expected)).toThrow(
      /relation.*fork/i
    );
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

    const unsafeEvidence: typeof safeEvidence & { nested: { value: string } } = {
      ...safeEvidence,
      nested: { value: fakeSecret },
    };
    unsafeEvidence.self = unsafeEvidence;
    const message = thrownMessage(() => assertNoSecrets(unsafeEvidence, [fakeSecret]));
    expect(message).toMatch(/secret.*evidence/i);
    expect(message).not.toContain(fakeSecret);
  });

  it('holds, releases, streams, and redacts a local provider request', async () => {
    let upstreamRequest:
      | { method: string; url: string; body: string; authorization?: string }
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
});
