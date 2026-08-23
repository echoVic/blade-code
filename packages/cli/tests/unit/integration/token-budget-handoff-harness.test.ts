import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type * as acp from '@agentclientprotocol/sdk';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { serializeCompactionReplacementMessages } from '../../../src/context/compactionCheckpoint.js';
import {
  projectTokenBudgetHandoffEvent,
  TOKEN_BUDGET_HANDOFF_TAG,
} from '../../../src/context/TokenBudgetHandoff.js';
import type { SessionEvent } from '../../../src/context/types.js';
import type { Message } from '../../../src/services/ChatServiceInterface.js';
import {
  createTokenBudgetHandoffFixture,
  renderTokenBudgetExactNextAction,
  type TokenBudgetHandoffFixture,
} from '../../integration/real-api/tokenBudgetHandoffFixture.js';
import {
  assertAndProjectSurfaceEvidence,
  assertContinuationLedger,
  assertTokenBudgetEvidenceSafe,
  assertTokenBudgetRequestSequence,
  assertTokenBudgetRequestSequenceWithTranscript,
  assertTokenBudgetTranscript,
  BoundedStringSink,
  canonicalStatusClauseDiagnostic,
  formatTokenBudgetTranscriptDiagnostic,
  parseContinuationLedger,
} from '../../integration/real-api/tokenBudgetHandoffHarness.js';
import {
  buildTokenBudgetAcpRunnerEnvironment,
  describeTokenBudgetAcpCleanupProbeFailure,
  describeTokenBudgetAcpCleanupProbeTeardownFailure,
  describeTokenBudgetAcpRunnerFailure,
  formatTokenBudgetAcpTaskFailureDiagnostic,
  parseTokenBudgetAcpRunnerFailure,
  parseTokenBudgetAcpRunnerSuccess,
  parseTokenBudgetHandoffAcpEvidence,
  resolveTokenBudgetAcpCleanupProbeTimeouts,
  resolveTokenBudgetAcpRunTimeouts,
} from '../../support/tokenBudgetHandoffAcpDriver.js';
import {
  finalAgentTextFromUpdates,
  hasUnexpectedLoadUserChunk,
  hasUnexpectedSurfaceMessageChunk,
} from '../../support/tokenBudgetHandoffAcpRunner.js';
import {
  finalHeadlessTextFromEvents,
  parseTokenBudgetHandoffProjectionEvidence,
  runTokenBudgetHandoffProjectionRunner,
  TOKEN_BUDGET_PROJECTION_EVIDENCE_PREFIX,
  TokenBudgetHandoffOutputSink,
} from '../../support/tokenBudgetHandoffHeadlessDriver.js';
import {
  inspectTokenBudgetRequest,
  type ProxyWritableResponse,
  startTokenBudgetHandoffProxy,
  type TokenBudgetProxyEvidence,
  writeWithBackpressure,
} from '../../support/tokenBudgetHandoffProxy.js';
import {
  classifyTokenBudgetPtyFinal,
  parseTokenBudgetHandoffPtyEvidence,
} from '../../support/tokenBudgetHandoffPtyDriver.js';
import {
  classifyTokenBudgetWebTaskStartObservation,
  formatTokenBudgetWebFinalDiagnostic,
  formatTokenBudgetWebProxyDiagnostic,
  formatTokenBudgetWebTaskStartDiagnostic,
  isTokenBudgetWebRunFailure,
  parseTokenBudgetHandoffWebEvidence,
} from '../../support/tokenBudgetHandoffWebDriver.js';

vi.unmock('child_process');
vi.unmock('node:child_process');

vi.unmock('http');
vi.unmock('node:http');

const LEDGER_HEADINGS = [
  'Objective and constraints',
  'Decisions and rationale',
  'Workspace mutations',
  'Verification evidence',
  'Active tasks and background work',
  'Open risks or blockers',
  'Exact next action',
] as const;

const safeRecovery = {
  kind: 'cold_projection' as const,
  completed: true,
  providerRequestsBefore: 5,
  providerRequestsAfter: 5,
};

const ACP_FAILURE_PROBE_PROCESS_TIMEOUT_MS = 30_000;
const ACP_FAILURE_PROBE_SINGLE_TEST_TIMEOUT_MS = 45_000;
const ACP_FAILURE_PROBE_DOUBLE_TEST_TIMEOUT_MS = 70_000;

function baseSurfaceEvidence(surface: 'headless' | 'pty' | 'web' | 'acp') {
  return {
    success: true,
    surface,
    sessionId: 'safe-session',
    finalMarkerSeen: true,
    hiddenMarkerSeen: false,
    recovery: safeRecovery,
    faults: [] as string[],
  };
}

let createServer: typeof import('node:http').createServer;
const roots: string[] = [];
const servers: Server[] = [];

beforeAll(async () => {
  const http = await vi.importActual<typeof import('node:http')>('node:http');
  createServer = http.createServer;
});

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        })
    )
  );
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected loopback TCP address');
  }
  return `http://127.0.0.1:${(address as AddressInfo).port}/v1`;
}

async function startJsonUpstream(options: { includeUsage?: boolean } = {}): Promise<{
  baseURL: string;
  requests(): number;
}> {
  let requestCount = 0;
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) void _chunk;
    requestCount++;
    response.writeHead(201, {
      'content-type': 'application/json',
      'x-upstream': 'preserved',
    });
    response.end(
      JSON.stringify({
        id: `response-${requestCount}`,
        choices: [
          {
            message: {
              role: 'assistant',
              content: `real-${requestCount}`,
              tool_calls: [{ id: 'tool-1', type: 'function' }],
            },
          },
        ],
        ...(options.includeUsage === false
          ? {}
          : {
              usage: {
                prompt_tokens: 12,
                completion_tokens: 3,
                total_tokens: 15,
              },
            }),
      })
    );
  });
  return { baseURL: await listen(server), requests: () => requestCount };
}

async function startFragmentedSseUpstream(
  chunks: readonly (string | Buffer)[]
): Promise<string> {
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) void _chunk;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const chunk of chunks) response.write(chunk);
    response.end();
  });
  return listen(server);
}

async function startHeldJsonUpstream(): Promise<{
  baseURL: string;
  release(): void;
  requests(): number;
}> {
  let requestCount = 0;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) void _chunk;
    requestCount++;
    await gate;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'held' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })
    );
  });
  return { baseURL: await listen(server), release, requests: () => requestCount };
}

async function startHeldStreamingUpstream(): Promise<{
  baseURL: string;
  closed(): boolean;
  requests(): number;
}> {
  let closed = false;
  let requestCount = 0;
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) void _chunk;
    requestCount++;
    response.once('close', () => {
      closed = true;
    });
    response.writeHead(200, { 'content-type': 'application/octet-stream' });
    response.flushHeaders();
    response.write('PREFIX');
  });
  return {
    baseURL: await listen(server),
    closed: () => closed,
    requests: () => requestCount,
  };
}

class CloseBeforeListenerResponse implements ProxyWritableResponse {
  destroyed = false;
  writableEnded = false;
  readonly #events = new EventEmitter();

  write(_chunk: Uint8Array): boolean {
    this.destroyed = true;
    this.#events.emit('close');
    return false;
  }

  once(event: 'drain' | 'close', listener: () => void): void {
    this.#events.once(event, listener);
  }

  off(event: 'drain' | 'close', listener: () => void): void {
    this.#events.off(event, listener);
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function taskBody(content: string, extra: Record<string, unknown> = {}): unknown {
  return {
    stream: false,
    messages: [{ role: 'user', content }],
    ...extra,
  };
}

function compactionBody(): unknown {
  return {
    messages: [{ role: 'user', content: LEDGER_HEADINGS.join('\n') }],
    tools: [],
  };
}

async function postJson(
  baseURL: string,
  body: unknown
): Promise<{
  status: number;
  body: Record<string, unknown>;
  upstreamHeader: string | null;
}> {
  const response = await fetch(`${baseURL}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer proxy-test-secret',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
    upstreamHeader: response.headers.get('x-upstream'),
  };
}

function usage(response: Record<string, unknown>): Record<string, unknown> {
  const value = response.usage;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected usage object');
  }
  return value as Record<string, unknown>;
}

function eventBase(id: string, type: SessionEvent['type']) {
  return {
    id,
    sessionId: 'handoff-session',
    timestamp: '2026-08-19T00:00:00.000Z',
    type,
    cwd: '/tmp/token-budget-fixture',
    version: 'test',
  };
}

function toolPart(
  id: string,
  toolCallId: string,
  toolName: string,
  partType: 'tool_call' | 'tool_result',
  payload: Record<string, unknown>
): Extract<SessionEvent, { type: 'part_created' }> {
  return {
    ...eventBase(id, 'part_created'),
    type: 'part_created',
    data: {
      partId: id,
      messageId: `${id}-message`,
      partType,
      payload: { toolCallId, toolName, ...payload },
      createdAt: '2026-08-19T00:00:00.000Z',
    },
  } satisfies Extract<SessionEvent, { type: 'part_created' }>;
}

function transcript(
  fixture: TokenBudgetHandoffFixture,
  replacementOverride?: Message[]
): SessionEvent[] {
  const ledger = [
    '# Objective and constraints',
    'continue',
    '# Decisions and rationale',
    'preserve',
    '# Workspace mutations',
    `- ${fixture.sentinels.mutation} status=applied`,
    '# Verification evidence',
    `- ${fixture.sentinels.failedVerification} status=failed`,
    '# Active tasks and background work',
    'none',
    '# Open risks or blockers',
    'none',
    '# Exact next action',
    `- ${fixture.sentinels.pendingAction} status=pending`,
    `- ${renderTokenBudgetExactNextAction({
      command: fixture.passingCommand,
      finalMarker: fixture.finalMarker,
    })}`,
  ].join('\n');
  const handoff = {
    ...eventBase('handoff-event', 'token_budget_handoff_recorded'),
    type: 'token_budget_handoff_recorded',
    data: {
      version: 1,
      messageId: 'handoff-message-1',
      observedPromptTokens: 75_000,
      availableForInput: 100_000,
      handoffThreshold: 70_000,
      compactionThreshold: 80_000,
      createdAt: '2026-08-19T00:00:00.000Z',
    },
  } satisfies Extract<SessionEvent, { type: 'token_budget_handoff_recorded' }>;
  const replacementMessages: Message[] = replacementOverride ?? [
    { role: 'user', content: ledger, metadata: { isCompactSummary: true } },
  ];
  const checkpoint = {
    ...eventBase('checkpoint', 'part_created'),
    type: 'part_created',
    data: {
      partId: 'checkpoint',
      messageId: 'checkpoint-message',
      partType: 'summary',
      payload: {
        text: ledger,
        metadata: {
          checkpointVersion: 1,
          reason: 'threshold',
          sampleAttempts: 2,
        },
        replacementMessages:
          serializeCompactionReplacementMessages(replacementMessages),
      },
      createdAt: '2026-08-19T00:00:01.000Z',
    },
  } satisfies Extract<SessionEvent, { type: 'part_created' }>;

  return [
    toolPart('fail-call', 'fail-call', 'Bash', 'tool_call', {
      input: { command: fixture.failingCommand },
    }),
    toolPart('fail-result', 'fail-call', 'Bash', 'tool_result', {
      output: null,
      error: fixture.sentinels.failedVerification,
    }),
    handoff,
    toolPart('write-call', 'write-call', 'Write', 'tool_call', {
      input: { file_path: fixture.targetPath, content: fixture.targetContent },
    }),
    toolPart('write-result', 'write-call', 'Write', 'tool_result', {
      output: { success: true },
      error: null,
    }),
    checkpoint,
    toolPart('pass-call', 'pass-call', 'Bash', 'tool_call', {
      input: { command: fixture.passingCommand },
    }),
    toolPart('pass-result', 'pass-call', 'Bash', 'tool_result', {
      output: { stdout: fixture.sentinels.mutation },
      error: null,
    }),
  ];
}

describe('token-budget handoff deterministic qualification foundation', () => {
  it('exports one stable structural marker tag in projected model context', () => {
    const marker = projectTokenBudgetHandoffEvent({
      ...eventBase('marker', 'token_budget_handoff_recorded'),
      type: 'token_budget_handoff_recorded',
      data: {
        version: 1,
        messageId: 'marker-message',
        observedPromptTokens: 75_000,
        availableForInput: 100_000,
        handoffThreshold: 70_000,
        compactionThreshold: 80_000,
        createdAt: '2026-08-19T00:00:00.000Z',
      },
    });
    if (!marker || typeof marker.content !== 'string') {
      throw new Error('Expected projected handoff marker');
    }
    expect(TOKEN_BUDGET_HANDOFF_TAG).toBe('<token-budget-handoff version="1">');
    expect(marker.content.split(TOKEN_BUDGET_HANDOFF_TAG)).toHaveLength(2);
  });

  it('classifies full-ledger requests and records only bounded structural facts', () => {
    const markerBody = {
      messages: [
        {
          role: 'user',
          content: `${TOKEN_BUDGET_HANDOFF_TAG}\n${TOKEN_BUDGET_HANDOFF_TAG}`,
        },
      ],
      tools: [{ type: 'function' }],
    };
    expect(inspectTokenBudgetRequest(compactionBody())).toMatchObject({
      kind: 'compaction',
      markerOccurrences: 0,
      bodyBytes: expect.any(Number),
      bodySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    const task = inspectTokenBudgetRequest(markerBody);
    expect(task).toMatchObject({ kind: 'task', markerOccurrences: 2 });
    expect(task).not.toHaveProperty('body');
    expect(
      inspectTokenBudgetRequest({ messages: [{ content: LEDGER_HEADINGS[0] }] })
    ).toMatchObject({
      kind: 'task',
    });
  });

  it('rewrites JSON usage for task one and two only while preserving response data', async () => {
    const upstream = await startJsonUpstream();
    const proxy = await startTokenBudgetHandoffProxy(upstream.baseURL, {
      handoffPromptTokens: 70_000,
      compactionPromptTokens: 80_000,
      markerTag: TOKEN_BUDGET_HANDOFF_TAG,
    });
    try {
      const first = await postJson(proxy.baseURL, taskBody('stage one secret'));
      const second = await postJson(
        proxy.baseURL,
        taskBody(`${TOKEN_BUDGET_HANDOFF_TAG}\nstage two`)
      );
      const compact = await postJson(proxy.baseURL, compactionBody());
      const third = await postJson(proxy.baseURL, taskBody('stage three'));
      const fourth = await postJson(proxy.baseURL, taskBody('stage four final'));

      expect([
        first.status,
        second.status,
        compact.status,
        third.status,
        fourth.status,
      ]).toEqual([201, 201, 201, 201, 201]);
      expect([
        usage(first.body).prompt_tokens,
        usage(second.body).prompt_tokens,
        usage(compact.body).prompt_tokens,
        usage(third.body).prompt_tokens,
        usage(fourth.body).prompt_tokens,
      ]).toEqual([70_000, 80_000, 12, 12, 12]);
      expect(usage(first.body)).toMatchObject({
        completion_tokens: 3,
        total_tokens: 70_003,
      });
      expect(first.body.choices).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message: expect.objectContaining({
              content: 'real-1',
              tool_calls: [{ id: 'tool-1', type: 'function' }],
            }),
          }),
        ])
      );
      expect(first.upstreamHeader).toBe('preserved');

      const evidence = proxy.evidence();
      expect(evidence).toMatchObject({
        requests: [
          {
            kind: 'task',
            ordinal: 1,
            targetPromptTokens: 70_000,
            upstreamStatus: 201,
            responseKind: 'json',
            usageShape: 'root-nonempty',
            usageRewritten: true,
          },
          {
            kind: 'task',
            ordinal: 2,
            markerOccurrences: 1,
            targetPromptTokens: 80_000,
            usageRewritten: true,
          },
          { kind: 'compaction', ordinal: 3, usageRewritten: false },
          { kind: 'task', ordinal: 4, usageRewritten: false },
          { kind: 'task', ordinal: 5, usageRewritten: false },
        ],
      });
      expect(() =>
        assertTokenBudgetRequestSequence(evidence, {
          handoffPromptTokens: 70_000,
          compactionPromptTokens: 80_000,
        })
      ).not.toThrow();
      expect(JSON.stringify(evidence)).not.toContain('stage one secret');
      expect(JSON.stringify(evidence)).not.toContain('proxy-test-secret');
      evidence.requests[0]!.kind = 'compaction';
      expect(proxy.evidence().requests[0]?.kind).toBe('task');
      expect(upstream.requests()).toBe(5);
    } finally {
      await proxy.close();
      await proxy.close();
    }
  });

  it('injects exactly one bounded transient compaction failure', async () => {
    const upstream = await startJsonUpstream();
    const proxy = await startTokenBudgetHandoffProxy(upstream.baseURL, {
      handoffPromptTokens: 70_000,
      compactionPromptTokens: 80_000,
      markerTag: TOKEN_BUDGET_HANDOFF_TAG,
      failFirstCompaction: true,
    });
    try {
      const first = await postJson(proxy.baseURL, compactionBody());
      const second = await postJson(proxy.baseURL, compactionBody());

      expect(first.status).toBe(503);
      expect(second.status).toBe(201);
      expect(upstream.requests()).toBe(1);
      expect(proxy.evidence().requests).toEqual([
        expect.objectContaining({
          ordinal: 1,
          kind: 'compaction',
          upstreamStatus: 503,
          responseKind: 'json',
          injectedFailure: 'compaction_transient',
          usageRewritten: false,
        }),
        expect.objectContaining({
          ordinal: 2,
          kind: 'compaction',
          upstreamStatus: 201,
          usageRewritten: false,
        }),
      ]);
    } finally {
      await proxy.close();
    }
  });

  it('rewrites a fragmented final SSE usage frame and preserves content and DONE', async () => {
    const contentFrame = 'data: {"choices":[{"delta":{"content":"real"}}]}\n\n';
    const upstreamBaseURL = await startFragmentedSseUpstream([
      contentFrame,
      'data: {"choices":[],"usage":{"prompt_tokens":12,',
      '"completion_tokens":3,"total_tokens":15}}\n\n',
      'data: [DONE]\n\n',
    ]);
    const proxy = await startTokenBudgetHandoffProxy(upstreamBaseURL, {
      handoffPromptTokens: 70_000,
      compactionPromptTokens: 80_000,
      markerTag: TOKEN_BUDGET_HANDOFF_TAG,
    });
    try {
      const response = await fetch(`${proxy.baseURL}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          stream: true,
          messages: [{ role: 'user', content: 'one' }],
        }),
      });
      const text = await response.text();
      expect(text.startsWith(contentFrame)).toBe(true);
      expect(text).toContain('"prompt_tokens":70000');
      expect(text).toContain('"completion_tokens":3');
      expect(text).toContain('"total_tokens":70003');
      expect(text.endsWith('data: [DONE]\n\n')).toBe(true);
      expect(proxy.evidence().requests[0]).toMatchObject({ usageRewritten: true });
      expect(proxy.evidence().requests[0]).toMatchObject({
        upstreamStatus: 200,
        responseKind: 'sse',
        usageShape: 'root-empty',
      });
    } finally {
      await proxy.close();
    }
  });

  it('changes only usage number bytes in a multiline CRLF SSE frame', async () => {
    const contentFrame =
      ': keep-this-comment\r\n' +
      'data: { "choices" : [{"delta":{"content":"r\\u0065al"}}] }\r\n\r\n';
    const usageFrame =
      'event: completion\r\n' +
      'data: { "id" : "keep🙂\\u0020escape", "choices" : [ ],\r\n' +
      'data: "meta" : { "spacing" : "unchanged" }, "usage" : { "prompt_tokens" : 12 , "completion_tokens" : 3 , "total_tokens" : 15 } }\r\n\r\n';
    const doneFrame = 'data: [DONE]\r\n\r\n';
    const expectedUsageFrame = usageFrame
      .replace('"prompt_tokens" : 12', '"prompt_tokens" : 70000')
      .replace('"total_tokens" : 15', '"total_tokens" : 70003');
    const upstreamBaseURL = await startFragmentedSseUpstream([
      contentFrame.slice(0, 19),
      contentFrame.slice(19),
      usageFrame.slice(0, 71),
      usageFrame.slice(71),
      doneFrame,
    ]);
    const proxy = await startTokenBudgetHandoffProxy(upstreamBaseURL, {
      handoffPromptTokens: 70_000,
      compactionPromptTokens: 80_000,
      markerTag: TOKEN_BUDGET_HANDOFF_TAG,
    });
    try {
      const response = await fetch(`${proxy.baseURL}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(taskBody('byte-transparent SSE')),
      });

      expect(await response.text()).toBe(
        `${contentFrame}${expectedUsageFrame}${doneFrame}`
      );
    } finally {
      await proxy.close();
    }
  });

  it('fails closed instead of rewriting an invalid UTF-8 SSE data frame', async () => {
    const invalidFrame = Buffer.concat([
      Buffer.from('data: {"id":"'),
      Buffer.from([0xff]),
      Buffer.from(
        '","choices":[],"usage":{"prompt_tokens":12,"completion_tokens":3,"total_tokens":15}}\n\n'
      ),
    ]);
    const upstreamBaseURL = await startFragmentedSseUpstream([invalidFrame]);
    const proxy = await startTokenBudgetHandoffProxy(upstreamBaseURL, {
      handoffPromptTokens: 70_000,
      compactionPromptTokens: 80_000,
      markerTag: TOKEN_BUDGET_HANDOFF_TAG,
    });
    try {
      const response = await fetch(`${proxy.baseURL}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(taskBody('invalid UTF-8 SSE')),
      });

      expect(response.status).toBe(502);
      expect(await response.text()).not.toContain('prompt_tokens');
      expect(proxy.evidence().requests[0]).toMatchObject({
        usageShape: 'invalid',
        usageRewritten: false,
      });
    } finally {
      await proxy.close();
    }
  });

  it('fails closed on invalid UTF-8 outside SSE data lines', async () => {
    const invalidCommentFrame = Buffer.concat([
      Buffer.from(': invalid-comment '),
      Buffer.from([0xff]),
      Buffer.from('\n\n'),
    ]);
    const validUsageFrame =
      'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":3,"total_tokens":15}}\n\n';
    const upstreamBaseURL = await startFragmentedSseUpstream([
      invalidCommentFrame,
      validUsageFrame,
    ]);
    const proxy = await startTokenBudgetHandoffProxy(upstreamBaseURL, {
      handoffPromptTokens: 70_000,
      compactionPromptTokens: 80_000,
      markerTag: TOKEN_BUDGET_HANDOFF_TAG,
    });
    try {
      const response = await fetch(`${proxy.baseURL}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(taskBody('invalid UTF-8 SSE metadata')),
      });

      expect(response.status).toBe(502);
      const text = await response.text();
      expect(text).not.toContain('invalid-comment');
      expect(text).not.toContain('prompt_tokens');
      expect(proxy.evidence().requests[0]).toMatchObject({
        usageRewritten: false,
      });
    } finally {
      await proxy.close();
    }
  });

  it('leaves non-final SSE usage untouched and rewrites only the final usage frame', async () => {
    const upstreamBaseURL = await startFragmentedSseUpstream([
      'data: {"choices":[{"delta":{"content":"real"}}],"usage":{"prompt_tokens":5,"completion_tokens":1,"total_tokens":6}}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":3,"total_tokens":15}}\n\n',
      'data: [DONE]\n\n',
    ]);
    const proxy = await startTokenBudgetHandoffProxy(upstreamBaseURL, {
      handoffPromptTokens: 70_000,
      compactionPromptTokens: 80_000,
      markerTag: TOKEN_BUDGET_HANDOFF_TAG,
    });
    try {
      const response = await fetch(`${proxy.baseURL}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(taskBody('final usage only')),
      });
      const text = await response.text();
      expect(text).toContain(
        '"choices":[{"delta":{"content":"real"}}],"usage":{"prompt_tokens":5'
      );
      expect(text).toContain('"choices":[],"usage":{"prompt_tokens":70000');
    } finally {
      await proxy.close();
    }
  });

  it('rewrites root usage on a terminal nonempty SSE choice only', async () => {
    const nonterminal =
      'data: {"choices":[{"delta":{"content":"real"},"finish_reason":null}],' +
      '"usage":{"prompt_tokens":5,"completion_tokens":1,"total_tokens":6}}\n\n';
    const terminal =
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],' +
      '"usage":{"prompt_tokens":12,"completion_tokens":3,"total_tokens":15}}\n\n';
    const upstreamBaseURL = await startFragmentedSseUpstream([
      nonterminal,
      terminal,
      'data: [DONE]\n\n',
    ]);
    const proxy = await startTokenBudgetHandoffProxy(upstreamBaseURL, {
      handoffPromptTokens: 70_000,
      compactionPromptTokens: 80_000,
      markerTag: TOKEN_BUDGET_HANDOFF_TAG,
    });
    try {
      const response = await fetch(`${proxy.baseURL}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(taskBody('terminal usage choice')),
      });
      const text = await response.text();

      expect(response.status).toBe(200);
      expect(text).toContain('"finish_reason":null}],"usage":{"prompt_tokens":5');
      expect(text).toContain(
        '"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":70000'
      );
      expect(proxy.evidence().requests[0]).toMatchObject({
        usageShape: 'root-terminal',
        usageRewritten: true,
      });
    } finally {
      await proxy.close();
    }
  });

  it('rewrites CR-only SSE frames without changing unrelated bytes', async () => {
    const contentFrame = 'data: {"choices":[{"delta":{"content":"real"}}]}\r\r';
    const usageFrame =
      'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":3,"total_tokens":15}}\r\r';
    const doneFrame = 'data: [DONE]\r\r';
    const upstreamBaseURL = await startFragmentedSseUpstream([
      contentFrame,
      usageFrame,
      doneFrame,
    ]);
    const proxy = await startTokenBudgetHandoffProxy(upstreamBaseURL, {
      handoffPromptTokens: 70_000,
      compactionPromptTokens: 80_000,
      markerTag: TOKEN_BUDGET_HANDOFF_TAG,
    });
    try {
      const response = await fetch(`${proxy.baseURL}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(taskBody('CR-only SSE')),
      });
      const expectedUsage = usageFrame
        .replace('"prompt_tokens":12', '"prompt_tokens":70000')
        .replace('"total_tokens":15', '"total_tokens":70003');

      expect(await response.text()).toBe(`${contentFrame}${expectedUsage}${doneFrame}`);
    } finally {
      await proxy.close();
    }
  });

  it('fails a targeted response when upstream omits usage', async () => {
    const upstream = await startJsonUpstream({ includeUsage: false });
    const proxy = await startTokenBudgetHandoffProxy(upstream.baseURL, {
      handoffPromptTokens: 70_000,
      compactionPromptTokens: 80_000,
      markerTag: TOKEN_BUDGET_HANDOFF_TAG,
    });
    try {
      const response = await postJson(proxy.baseURL, taskBody('missing usage'));
      expect(response.status).toBe(502);
      expect(JSON.stringify(response.body)).not.toContain('missing usage');
      expect(proxy.evidence().requests[0]).toMatchObject({ usageRewritten: false });
    } finally {
      await proxy.close();
    }
  });

  it('fails a targeted SSE stream that ends without usage', async () => {
    const upstreamBaseURL = await startFragmentedSseUpstream([
      'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
      'data: [DONE]\n\n',
    ]);
    const proxy = await startTokenBudgetHandoffProxy(upstreamBaseURL, {
      handoffPromptTokens: 70_000,
      compactionPromptTokens: 80_000,
      markerTag: TOKEN_BUDGET_HANDOFF_TAG,
    });
    try {
      const response = await fetch(`${proxy.baseURL}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(taskBody('missing SSE usage')),
      });
      expect(response.status).toBe(502);
      const text = await response.text();
      expect(text).not.toContain('partial');
      expect(text).not.toContain('[DONE]');
      expect(proxy.evidence().requests[0]).toMatchObject({
        usageRewritten: false,
      });
    } finally {
      await proxy.close();
    }
  });

  it('fails closed when targeted SSE validation exceeds its bounded buffer', async () => {
    const largeFrame = `data: ${'x'.repeat(1024 * 1024)}\n\n`;
    const upstreamBaseURL = await startFragmentedSseUpstream(
      Array.from({ length: 17 }, () => largeFrame)
    );
    const proxy = await startTokenBudgetHandoffProxy(upstreamBaseURL, {
      handoffPromptTokens: 70_000,
      compactionPromptTokens: 80_000,
      markerTag: TOKEN_BUDGET_HANDOFF_TAG,
    });
    try {
      const response = await fetch(`${proxy.baseURL}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(taskBody('bounded SSE validation')),
      });

      expect(response.status).toBe(502);
      expect(await response.text()).not.toContain('data: xxx');
      expect(proxy.evidence().requests[0]).toMatchObject({
        usageRewritten: false,
      });
    } finally {
      await proxy.close();
    }
  }, 60_000);

  it('rejects request bodies above 16 MiB without contacting upstream', async () => {
    const upstream = await startJsonUpstream();
    const proxy = await startTokenBudgetHandoffProxy(upstream.baseURL, {
      handoffPromptTokens: 70_000,
      compactionPromptTokens: 80_000,
      markerTag: TOKEN_BUDGET_HANDOFF_TAG,
    });
    try {
      const response = await fetch(`${proxy.baseURL}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(taskBody('x'.repeat(16 * 1024 * 1024))),
      });
      expect(response.status).toBe(413);
      expect(upstream.requests()).toBe(0);
      expect(proxy.evidence().requests).toEqual([]);
    } finally {
      await proxy.close();
    }
  });

  it('records concurrent in-flight requests without retaining their bodies', async () => {
    const upstream = await startHeldJsonUpstream();
    const proxy = await startTokenBudgetHandoffProxy(upstream.baseURL, {
      handoffPromptTokens: 70_000,
      compactionPromptTokens: 80_000,
      markerTag: TOKEN_BUDGET_HANDOFF_TAG,
    });
    try {
      const first = postJson(proxy.baseURL, taskBody('parallel-one'));
      const second = postJson(proxy.baseURL, taskBody('parallel-two'));
      await waitFor(() => upstream.requests() === 2);
      expect(proxy.evidence().maxInFlight).toBe(2);
      upstream.release();
      await Promise.all([first, second]);
      expect(JSON.stringify(proxy.evidence())).not.toContain('parallel-');
    } finally {
      upstream.release();
      await proxy.close();
    }
  });

  it('waits for accepted streaming handlers and upstream closure during shutdown', async () => {
    const upstream = await startHeldStreamingUpstream();
    const proxy = await startTokenBudgetHandoffProxy(upstream.baseURL, {
      handoffPromptTokens: 70_000,
      compactionPromptTokens: 80_000,
      markerTag: TOKEN_BUDGET_HANDOFF_TAG,
    });
    const response = await fetch(`${proxy.baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(compactionBody()),
    });
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Expected a streaming proxy response');
    const first = await reader.read();
    expect(Buffer.from(first.value ?? []).toString()).toBe('PREFIX');
    expect(upstream.requests()).toBe(1);

    const pendingRead = reader.read().then(
      () => 'resolved' as const,
      () => 'rejected' as const
    );
    await proxy.close();

    expect(await pendingRead).toBe('rejected');
    await waitFor(upstream.closed);
  });

  it('rejects when downstream closes between a backpressured write and listeners', async () => {
    const response = new CloseBeforeListenerResponse();
    const outcome = await Promise.race([
      writeWithBackpressure(response, Buffer.from('chunk')).then(
        () => 'resolved' as const,
        () => 'rejected' as const
      ),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 50)),
    ]);

    expect(outcome).toBe('rejected');
  });

  it('rejects invalid proxy configuration without contacting an upstream', async () => {
    await expect(
      startTokenBudgetHandoffProxy('file:///tmp/provider', {
        handoffPromptTokens: 70_000,
        compactionPromptTokens: 80_000,
        markerTag: TOKEN_BUDGET_HANDOFF_TAG,
      })
    ).rejects.toThrow('HTTP');
    await expect(
      startTokenBudgetHandoffProxy('http://127.0.0.1:1/v1', {
        handoffPromptTokens: 0,
        compactionPromptTokens: 80_000,
        markerTag: TOKEN_BUDGET_HANDOFF_TAG,
      })
    ).rejects.toThrow('positive');
  });

  it('creates a four-boundary coding fixture with exact failing and passing states', async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'blade-handoff-fixture-'));
    roots.push(workspace);
    const created = await createTokenBudgetHandoffFixture(
      workspace,
      'AbCdEf1234567890'
    );

    expect(readFileSync(path.join(workspace, 'test.mjs'), 'utf8')).toContain(
      created.sentinels.failedVerification
    );
    expect(() => readFileSync(created.targetPath)).toThrow();
    const failing = spawnSync(created.failingCommand, {
      shell: true,
      encoding: 'utf8',
    });
    expect(failing.status).toBe(1);
    expect(`${failing.stdout}${failing.stderr}`).toContain(
      created.sentinels.failedVerification
    );
    mkdirSync(path.dirname(created.targetPath), { recursive: true });
    writeFileSync(created.targetPath, `${created.targetContent}-wrong`);
    expect(spawnSync(created.passingCommand, { shell: true }).status).toBe(1);
    writeFileSync(created.targetPath, created.targetContent);
    expect(spawnSync(created.passingCommand, { shell: true }).status).toBe(0);

    const boundaryIndexes = [1, 2, 3, 4].map((boundary) => {
      const label = `Boundary ${boundary}`;
      expect(created.prompt.split(label)).toHaveLength(2);
      return created.prompt.indexOf(label);
    });
    expect(boundaryIndexes).toEqual([...boundaryIndexes].sort((a, b) => a - b));
    expect(boundaryIndexes.every((index) => index >= 0)).toBe(true);

    const failIndex = created.prompt.indexOf(created.failingCommand);
    const writeIndex = created.prompt.indexOf(created.targetPath);
    const passIndex = created.prompt.lastIndexOf(created.passingCommand);
    expect(failIndex).toBeGreaterThanOrEqual(0);
    expect(writeIndex).toBeGreaterThan(failIndex);
    expect(passIndex).toBeGreaterThan(writeIndex);
    expect(created.prompt).toContain(created.sentinels.pendingAction);
    expect(created.prompt).toContain(`${created.sentinels.mutation} status=applied`);
    expect(created.prompt).toContain(
      `${created.sentinels.failedVerification} status=failed`
    );
    expect(created.prompt).toContain(
      `${created.sentinels.pendingAction} status=pending`
    );
    expect(created.prompt).toContain(
      `EXACT CONTINUATION RECORD [Workspace mutations] :: ${created.sentinels.mutation} status=applied`
    );
    expect(created.prompt).toContain(
      `EXACT CONTINUATION RECORD [Verification evidence] :: ${created.sentinels.failedVerification} status=failed`
    );
    expect(created.prompt).toContain(
      `EXACT CONTINUATION RECORD [Exact next action] :: ${created.sentinels.pendingAction} status=pending`
    );
    expect(created.prompt).toContain(
      `EXACT CONTINUATION RECORD [Exact next action] :: ${renderTokenBudgetExactNextAction(
        {
          command: created.passingCommand,
          finalMarker: created.finalMarker,
        }
      )}`
    );
    expect(created.prompt).not.toContain('nowhere else');
    expect(created.prompt).not.toContain(created.finalMarker);
    const partA = created.prompt.match(/^PART_A=([A-Za-z0-9_-]+)$/m)?.[1];
    const partB = created.prompt.match(/^PART_B=([A-Za-z0-9_-]+)$/m)?.[1];
    expect(`${partA}${partB}`).toBe(created.finalMarker);
    expect(created.prompt).toContain(
      `exactly ${created.finalMarker.length} ASCII characters`
    );
    expect(created.prompt).toContain(
      `match ^[A-Za-z0-9_-]{${created.finalMarker.length}}$`
    );
    expect(created.prompt.endsWith(`PART_B=${partB}`)).toBe(true);
    expect(created.prompt.split(created.failingCommand)).toHaveLength(4);
    expect(created.prompt.match(/call Bash exactly once/g)).toHaveLength(2);
    expect(created.prompt.match(/call Write exactly once/g)).toHaveLength(1);
  });

  it('rejects fixture nonces outside the high-entropy sentinel contract', async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'blade-handoff-invalid-'));
    roots.push(workspace);
    await expect(createTokenBudgetHandoffFixture(workspace, 'short')).rejects.toThrow(
      'nonce'
    );
    await expect(
      createTokenBudgetHandoffFixture(workspace, 'invalid/path_nonce_1234')
    ).rejects.toThrow('nonce');
  });

  it('refuses to erase an existing fixture target', async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'blade-handoff-existing-'));
    roots.push(workspace);
    const target = path.join(workspace, 'src', 'status.txt');
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, 'user-owned');

    await expect(
      createTokenBudgetHandoffFixture(workspace, 'Existing12345678')
    ).rejects.toThrow('exists');
    expect(readFileSync(target, 'utf8')).toBe('user-owned');
  });

  it('rejects a dangling symlink at the fixture target', async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'blade-handoff-symlink-'));
    roots.push(workspace);
    const target = path.join(workspace, 'src', 'status.txt');
    mkdirSync(path.dirname(target), { recursive: true });
    symlinkSync(path.join(workspace, 'missing-external-target'), target);

    await expect(
      createTokenBudgetHandoffFixture(workspace, 'Symlink123456789')
    ).rejects.toThrow('exists');
  });

  it('normalizes ledger headings while requiring exact sentinels in correct sections', () => {
    const sections = parseContinuationLedger(
      '## Objective and constraints\n- continue\n' +
        '## Decisions and rationale\n- preserve\n' +
        '### WORKSPACE   MUTATIONS\n- MUTATION_7f31ABCDEF12 status=applied\n' +
        '## Verification Evidence\n* FAILED_19acABCDEF12 status=failed\n' +
        '## Active tasks and background work\n- none\n' +
        '## Open risks or blockers\n- none\n' +
        '#### Exact Next Action\n1. PENDING_a8d2ABCDEF12 status=pending'
    );
    expect(sections.workspaceMutations).toContain('MUTATION_7f31ABCDEF12');
    expect(sections.verificationEvidence).toContain('FAILED_19acABCDEF12');
    expect(sections.exactNextAction).toContain('PENDING_a8d2ABCDEF12');
    expect(() =>
      assertContinuationLedger(sections, {
        mutation: 'MUTATION_7f31ABCDEF12',
        failedVerification: 'FAILED_19acABCDEF12',
        pendingAction: 'PENDING_a8d2ABCDEF12',
      })
    ).not.toThrow();
    expect(() =>
      assertContinuationLedger(sections, {
        mutation: 'MUTATION_CHANGED_1234',
        failedVerification: 'FAILED_19acABCDEF12',
        pendingAction: 'PENDING_a8d2ABCDEF12',
      })
    ).toThrow('mutation sentinel');
  });

  it('requires canonical status clauses for execution-frontier identifiers', () => {
    const completedPending = parseContinuationLedger(
      '## Objective and constraints\ncontinue\n' +
        '## Decisions and rationale\npreserve\n' +
        '## Workspace mutations\nMUTATION_7f31ABCDEF12 status=applied\n' +
        '## Verification evidence\nFAILED_19acABCDEF12 status=failed\n' +
        '## Active tasks and background work\nnone\n' +
        '## Open risks or blockers\nnone\n' +
        '## Exact next action\ncompleted PENDING_a8d2ABCDEF12'
    );
    expect(() =>
      assertContinuationLedger(completedPending, {
        mutation: 'MUTATION_7f31ABCDEF12',
        failedVerification: 'FAILED_19acABCDEF12',
        pendingAction: 'PENDING_a8d2ABCDEF12',
      })
    ).toThrow('pending action must use one canonical status clause');

    const passedFailure = parseContinuationLedger(
      '## Objective and constraints\ncontinue\n' +
        '## Decisions and rationale\npreserve\n' +
        '## Workspace mutations\nMUTATION_7f31ABCDEF12 status=applied\n' +
        '## Verification evidence\npassed FAILED_19acABCDEF12\n' +
        '## Active tasks and background work\nnone\n' +
        '## Open risks or blockers\nnone\n' +
        '## Exact next action\nPENDING_a8d2ABCDEF12 status=pending'
    );
    expect(() =>
      assertContinuationLedger(passedFailure, {
        mutation: 'MUTATION_7f31ABCDEF12',
        failedVerification: 'FAILED_19acABCDEF12',
        pendingAction: 'PENDING_a8d2ABCDEF12',
      })
    ).toThrow('failed verification must use one canonical status clause');

    const suffixPassedFailure = parseContinuationLedger(
      '## Objective and constraints\ncontinue\n' +
        '## Decisions and rationale\npreserve\n' +
        '## Workspace mutations\nMUTATION_7f31ABCDEF12 status=applied\n' +
        '## Verification evidence\nFAILED_19acABCDEF12 was successful\n' +
        '## Active tasks and background work\nnone\n' +
        '## Open risks or blockers\nnone\n' +
        '## Exact next action\nPENDING_a8d2ABCDEF12 status=pending'
    );
    expect(() =>
      assertContinuationLedger(suffixPassedFailure, {
        mutation: 'MUTATION_7f31ABCDEF12',
        failedVerification: 'FAILED_19acABCDEF12',
        pendingAction: 'PENDING_a8d2ABCDEF12',
      })
    ).toThrow('failed verification must use one canonical status clause');

    const observedExpectedFailure = parseContinuationLedger(
      '## Objective and constraints\ncontinue\n' +
        '## Decisions and rationale\npreserve\n' +
        '## Workspace mutations\nMUTATION_7f31ABCDEF12 status=applied\n' +
        '## Verification evidence\nsuccessfully observed expected failure FAILED_19acABCDEF12\n' +
        '## Active tasks and background work\nnone\n' +
        '## Open risks or blockers\nnone\n' +
        '## Exact next action\nPENDING_a8d2ABCDEF12 status=pending'
    );
    expect(() =>
      assertContinuationLedger(observedExpectedFailure, {
        mutation: 'MUTATION_7f31ABCDEF12',
        failedVerification: 'FAILED_19acABCDEF12',
        pendingAction: 'PENDING_a8d2ABCDEF12',
      })
    ).toThrow('failed verification must use one canonical status clause');

    const wrappedContradiction = parseContinuationLedger(
      '## Objective and constraints\ncontinue\n' +
        '## Decisions and rationale\npreserve\n' +
        '## Workspace mutations\nMUTATION_7f31ABCDEF12 status=applied\n' +
        '## Verification evidence\nFAILED_19acABCDEF12 status=failed\n' +
        '## Active tasks and background work\nnone\n' +
        '## Open risks or blockers\nnone\n' +
        '## Exact next action\n- PENDING_a8d2ABCDEF12 status=pending\n' +
        '  This pending action is now completed'
    );
    expect(() =>
      assertContinuationLedger(wrappedContradiction, {
        mutation: 'MUTATION_7f31ABCDEF12',
        failedVerification: 'FAILED_19acABCDEF12',
        pendingAction: 'PENDING_a8d2ABCDEF12',
      })
    ).toThrow('pending action must use one canonical status clause');
  });

  it('reports only bounded structural facts for noncanonical ledger clauses', () => {
    expect(
      canonicalStatusClauseDiagnostic(
        'MUTATION_example status=applied\n' +
          'The mutation MUTATION_example remains relevant',
        'MUTATION_example',
        'applied'
      )
    ).toBe(
      'occurrences=2;canonical=1;starts=1;status=1;extra=1;' +
        'suffix_none=1;punctuation=0;parenthetical=0;prose=0;max_suffix=0'
    );
    expect(
      canonicalStatusClauseDiagnostic(
        '**MUTATION_example status=applied**',
        'MUTATION_example',
        'applied'
      )
    ).toBe(
      'occurrences=1;canonical=0;starts=0;status=1;extra=1;' +
        'suffix_none=0;punctuation=0;parenthetical=0;prose=0;max_suffix=0'
    );
    expect(
      canonicalStatusClauseDiagnostic(
        'PENDING_example status=pending (run tests next)',
        'PENDING_example',
        'pending'
      )
    ).toContain('parenthetical=1;prose=0;max_suffix=9_32');
  });

  it('does not attach a contradictory status from a separate ledger item', () => {
    const independentStatus = parseContinuationLedger(
      '## Objective and constraints\ncontinue\n' +
        '## Decisions and rationale\npreserve\n' +
        '## Workspace mutations\nMUTATION_7f31ABCDEF12 status=applied\n' +
        '## Verification evidence\nFAILED_19acABCDEF12 status=failed\n' +
        '## Active tasks and background work\nnone\n' +
        '## Open risks or blockers\nnone\n' +
        '## Exact next action\n- PENDING_a8d2ABCDEF12 status=pending\n' +
        '- completed unrelated cleanup'
    );

    expect(() =>
      assertContinuationLedger(independentStatus, {
        mutation: 'MUTATION_7f31ABCDEF12',
        failedVerification: 'FAILED_19acABCDEF12',
        pendingAction: 'PENDING_a8d2ABCDEF12',
      })
    ).not.toThrow();
  });

  it('allows narrative sentinel citations outside their authoritative sections', () => {
    const sections = parseContinuationLedger(
      '## Objective and constraints\nPreserve MUTATION_7f31ABCDEF12 while continuing.\n' +
        '## Decisions and rationale\nSuccessfully observed expected failure FAILED_19acABCDEF12.\n' +
        '## Workspace mutations\nMUTATION_7f31ABCDEF12 status=applied\n' +
        '## Verification evidence\nFAILED_19acABCDEF12 status=failed\n' +
        '## Active tasks and background work\nPENDING_a8d2ABCDEF12 remains queued.\n' +
        '## Open risks or blockers\nnone\n' +
        '## Exact next action\nPENDING_a8d2ABCDEF12 status=pending'
    );

    expect(() =>
      assertContinuationLedger(sections, {
        mutation: 'MUTATION_7f31ABCDEF12',
        failedVerification: 'FAILED_19acABCDEF12',
        pendingAction: 'PENDING_a8d2ABCDEF12',
      })
    ).not.toThrow();
  });

  it('allows one canonical status beside a same-section narrative citation', () => {
    const sections = parseContinuationLedger(
      '## Objective and constraints\ncontinue\n' +
        '## Decisions and rationale\npreserve\n' +
        '## Workspace mutations\n- MUTATION_7f31ABCDEF12 status=applied\n' +
        '- The mutation MUTATION_7f31ABCDEF12 remains relevant.\n' +
        '## Verification evidence\nFAILED_19acABCDEF12 status=failed\n' +
        '## Active tasks and background work\nnone\n' +
        '## Open risks or blockers\nnone\n' +
        '## Exact next action\nPENDING_a8d2ABCDEF12 status=pending'
    );
    const sentinels = {
      mutation: 'MUTATION_7f31ABCDEF12',
      failedVerification: 'FAILED_19acABCDEF12',
      pendingAction: 'PENDING_a8d2ABCDEF12',
    };

    expect(() => assertContinuationLedger(sections, sentinels)).not.toThrow();

    expect(() =>
      assertContinuationLedger(
        {
          ...sections,
          workspaceMutations:
            sections.workspaceMutations + '\nMUTATION_7f31ABCDEF12 was applied',
        },
        sentinels
      )
    ).toThrow('mutation must use one canonical status clause');
  });

  it('allows narrative copulas that do not assign an execution status', () => {
    const sections = parseContinuationLedger(
      '## Objective and constraints\ncontinue\n' +
        '## Decisions and rationale\npreserve\n' +
        '## Workspace mutations\n- MUTATION_7f31ABCDEF12 status=applied\n' +
        '- MUTATION_7f31ABCDEF12 was discussed during review.\n' +
        '## Verification evidence\nFAILED_19acABCDEF12 status=failed\n' +
        '## Active tasks and background work\nPENDING_a8d2ABCDEF12 is still referenced.\n' +
        '## Open risks or blockers\nnone\n' +
        '## Exact next action\nPENDING_a8d2ABCDEF12 status=pending'
    );

    expect(() =>
      assertContinuationLedger(sections, {
        mutation: 'MUTATION_7f31ABCDEF12',
        failedVerification: 'FAILED_19acABCDEF12',
        pendingAction: 'PENDING_a8d2ABCDEF12',
      })
    ).not.toThrow();
  });

  it('rejects every second explicit status authority across sections and formatting', () => {
    const sections = parseContinuationLedger(
      '## Objective and constraints\ncontinue\n' +
        '## Decisions and rationale\npreserve\n' +
        '## Workspace mutations\nMUTATION_7f31ABCDEF12 status=applied\n' +
        '## Verification evidence\nFAILED_19acABCDEF12 status=failed\n' +
        '## Active tasks and background work\nnone\n' +
        '## Open risks or blockers\nnone\n' +
        '## Exact next action\nPENDING_a8d2ABCDEF12 status=pending'
    );
    const sentinels = {
      mutation: 'MUTATION_7f31ABCDEF12',
      failedVerification: 'FAILED_19acABCDEF12',
      pendingAction: 'PENDING_a8d2ABCDEF12',
    };
    const invalid: Array<Record<string, string>> = [
      {
        ...sections,
        objectiveAndConstraints:
          sections.objectiveAndConstraints + '\nMUTATION_7f31ABCDEF12 status=applied',
      },
      {
        ...sections,
        decisionsAndRationale:
          sections.decisionsAndRationale + '\nFAILED_19acABCDEF12 status=failed',
      },
      {
        ...sections,
        activeTasksAndBackgroundWork:
          sections.activeTasksAndBackgroundWork +
          '\nPENDING_a8d2ABCDEF12 status=pending',
      },
      {
        ...sections,
        workspaceMutations:
          sections.workspaceMutations + '\n`MUTATION_7f31ABCDEF12 status=applied`',
      },
      {
        ...sections,
        workspaceMutations:
          sections.workspaceMutations + '\n**MUTATION_7f31ABCDEF12 status=applied**',
      },
      {
        ...sections,
        workspaceMutations:
          sections.workspaceMutations + '\nMUTATION_7f31ABCDEF12 status=unknown',
      },
      {
        ...sections,
        workspaceMutations:
          sections.workspaceMutations + '\nMUTATION_7f31ABCDEF12 status=applied-extra',
      },
      {
        ...sections,
        workspaceMutations:
          sections.workspaceMutations + '\nMUTATION_7f31ABCDEF12 was not applied',
      },
      {
        ...sections,
        verificationEvidence:
          sections.verificationEvidence + '\nFAILED_19acABCDEF12 did not fail',
      },
      {
        ...sections,
        exactNextAction:
          sections.exactNextAction + '\nPENDING_a8d2ABCDEF12 is not pending',
      },
    ];

    for (const candidate of invalid) {
      expect(() => assertContinuationLedger(candidate, sentinels)).toThrow(
        'must use one canonical status clause'
      );
    }
  });

  it('rejects a later authority after a narrative sentinel in the same clause', () => {
    const sections = parseContinuationLedger(
      '## Objective and constraints\ncontinue\n' +
        '## Decisions and rationale\npreserve\n' +
        '## Workspace mutations\nMUTATION_7f31ABCDEF12 status=applied\n' +
        '## Verification evidence\nFAILED_19acABCDEF12 status=failed\n' +
        '## Active tasks and background work\nnone\n' +
        '## Open risks or blockers\nnone\n' +
        '## Exact next action\nPENDING_a8d2ABCDEF12 status=pending'
    );
    const sentinels = {
      mutation: 'MUTATION_7f31ABCDEF12',
      failedVerification: 'FAILED_19acABCDEF12',
      pendingAction: 'PENDING_a8d2ABCDEF12',
    };

    for (const duplicate of [
      'MUTATION_7f31ABCDEF12 remains relevant; ' +
        'MUTATION_7f31ABCDEF12 status=applied',
      'MUTATION_7f31ABCDEF12 was discussed; ' + 'MUTATION_7f31ABCDEF12 status=unknown',
    ]) {
      expect(() =>
        assertContinuationLedger(
          {
            ...sections,
            workspaceMutations: sections.workspaceMutations + '\n' + duplicate,
          },
          sentinels
        )
      ).toThrow('mutation must use one canonical status clause');
    }

    expect(() =>
      assertContinuationLedger(
        {
          ...sections,
          exactNextAction:
            sections.exactNextAction +
            '\nPENDING_a8d2ABCDEF12 was discussed; ' +
            'PENDING_a8d2ABCDEF12 status=completed',
        },
        sentinels
      )
    ).toThrow();
  });

  it('rejects explicit contradictory statuses outside authoritative sections', () => {
    const completedPending = parseContinuationLedger(
      '## Objective and constraints\ncontinue\n' +
        '## Decisions and rationale\npreserve\n' +
        '## Workspace mutations\n- MUTATION_7f31ABCDEF12 status=applied\n' +
        '- PENDING_a8d2ABCDEF12 status=completed\n' +
        '## Verification evidence\nFAILED_19acABCDEF12 status=failed\n' +
        '## Active tasks and background work\nnone\n' +
        '## Open risks or blockers\nnone\n' +
        '## Exact next action\nPENDING_a8d2ABCDEF12 status=pending'
    );
    expect(() =>
      assertContinuationLedger(completedPending, {
        mutation: 'MUTATION_7f31ABCDEF12',
        failedVerification: 'FAILED_19acABCDEF12',
        pendingAction: 'PENDING_a8d2ABCDEF12',
      })
    ).toThrow('pending action is marked completed');

    const passedFailure = parseContinuationLedger(
      '## Objective and constraints\nFAILED_19acABCDEF12 status=passed\n' +
        '## Decisions and rationale\npreserve\n' +
        '## Workspace mutations\nMUTATION_7f31ABCDEF12 status=applied\n' +
        '## Verification evidence\nFAILED_19acABCDEF12 status=failed\n' +
        '## Active tasks and background work\nnone\n' +
        '## Open risks or blockers\nnone\n' +
        '## Exact next action\nPENDING_a8d2ABCDEF12 status=pending'
    );
    expect(() =>
      assertContinuationLedger(passedFailure, {
        mutation: 'MUTATION_7f31ABCDEF12',
        failedVerification: 'FAILED_19acABCDEF12',
        pendingAction: 'PENDING_a8d2ABCDEF12',
      })
    ).toThrow('failed verification is marked passing');

    const proseContradictions = parseContinuationLedger(
      '## Objective and constraints\nThe next action PENDING_a8d2ABCDEF12 is completed.\n' +
        '## Decisions and rationale\nVerification for FAILED_19acABCDEF12 passed.\n' +
        '## Workspace mutations\nMUTATION_7f31ABCDEF12 status=applied\n' +
        '## Verification evidence\nFAILED_19acABCDEF12 status=failed\n' +
        '## Active tasks and background work\nnone\n' +
        '## Open risks or blockers\nnone\n' +
        '## Exact next action\nPENDING_a8d2ABCDEF12 status=pending'
    );
    expect(() =>
      assertContinuationLedger(proseContradictions, {
        mutation: 'MUTATION_7f31ABCDEF12',
        failedVerification: 'FAILED_19acABCDEF12',
        pendingAction: 'PENDING_a8d2ABCDEF12',
      })
    ).toThrow('pending action is marked completed');

    const prosePassedFailure = parseContinuationLedger(
      '## Objective and constraints\ncontinue\n' +
        '## Decisions and rationale\nVerification for FAILED_19acABCDEF12 passed.\n' +
        '## Workspace mutations\nMUTATION_7f31ABCDEF12 status=applied\n' +
        '## Verification evidence\nFAILED_19acABCDEF12 status=failed\n' +
        '## Active tasks and background work\nnone\n' +
        '## Open risks or blockers\nnone\n' +
        '## Exact next action\nPENDING_a8d2ABCDEF12 status=pending'
    );
    expect(() =>
      assertContinuationLedger(prosePassedFailure, {
        mutation: 'MUTATION_7f31ABCDEF12',
        failedVerification: 'FAILED_19acABCDEF12',
        pendingAction: 'PENDING_a8d2ABCDEF12',
      })
    ).toThrow('failed verification is marked passing');
  });

  it('keeps bounded stage diagnostics in PTY and Web production drivers', () => {
    const ptyDriver = readFileSync(
      new URL('../../support/tokenBudgetHandoffPtyDriver.ts', import.meta.url),
      'utf8'
    );
    const ptyRunner = readFileSync(
      new URL('../../support/tokenBudgetHandoffPtyRunner.ts', import.meta.url),
      'utf8'
    );
    const webDriver = readFileSync(
      new URL('../../support/tokenBudgetHandoffWebDriver.ts', import.meta.url),
      'utf8'
    );

    expect(ptyRunner).toContain('failureStage');
    expect(ptyRunner).toContain('failureCode');
    expect(ptyDriver).toContain('COMPOSER_FAILURE_CODE_PATTERN');
    expect(ptyDriver).toContain("return 'transport:timeout'");
    expect(ptyDriver).toContain('Token-budget PTY runner failed at');
    expect(webDriver).toContain('Token-budget Web production driver failed at');
    expect(webDriver).toContain('const deadline = Date.now() + timeoutMs - 10_000');
    expect(webDriver).toContain('remainingStageBudget(deadline');
    expect(webDriver).toContain('[data-blade-permission-option="yolo"]');
    expect(webDriver).toContain('[data-blade-yolo-confirm]');
    expect(webDriver).toContain(
      "getAttribute('data-blade-permission-mode') === 'yolo'"
    );
    expect(webDriver).not.toContain(
      'marker: input.fixture.finalMarker,\n      timeoutMs,'
    );
  });

  it('bounds token-budget transcript failures to structural lifecycle facts', () => {
    const secret = 'transcript-diagnostic-secret';
    const fixture = {
      workspace: `/private/workspace/${secret}`,
      failingCommand: `bun test ${secret}`,
      passingCommand: `bun test ${secret}`,
      targetPath: `/private/workspace/${secret}/src/status.txt`,
      targetContent: `MUTATION_${secret}`,
      prompt: `private prompt ${secret}`,
      finalMarker: 'FINAL_OK_a8d2ABCDEF12',
      sentinels: {
        mutation: 'MUTATION_7f31ABCDEF12',
        failedVerification: 'FAILED_19acABCDEF12',
        pendingAction: 'PENDING_a8d2ABCDEF12',
      },
    } satisfies TokenBudgetHandoffFixture;
    const turnId = 'diagnostic-turn';
    const finalMessageId = 'diagnostic-final-message';
    const events: SessionEvent[] = [
      {
        ...eventBase('diagnostic-turn-started', 'turn_started'),
        type: 'turn_started',
        data: {
          turnId,
          kind: 'user',
          startedAt: '2026-08-19T00:00:00.000Z',
          inputMessageIds: [],
        },
      },
      ...transcript(fixture),
      {
        ...eventBase('diagnostic-final-message-created', 'message_created'),
        type: 'message_created',
        data: {
          messageId: finalMessageId,
          role: 'assistant',
          createdAt: '2026-08-19T00:00:02.000Z',
          metadata: {
            turnFinalization: {
              turnId,
              inputMessageIds: [],
              turnsCount: 4,
              toolCallsCount: 3,
              durationMs: 1,
            },
          },
        },
      },
      {
        ...eventBase('diagnostic-final-text', 'part_created'),
        type: 'part_created',
        data: {
          partId: 'diagnostic-final-text',
          messageId: finalMessageId,
          partType: 'text',
          payload: { text: fixture.finalMarker },
          createdAt: '2026-08-19T00:00:02.000Z',
        },
      },
      {
        ...eventBase('diagnostic-turn-completed', 'turn_completed'),
        type: 'turn_completed',
        data: {
          turnId,
          completedAt: '2026-08-19T00:00:03.000Z',
          turnsCount: 4,
          toolCallsCount: 3,
          durationMs: 1,
        },
      },
      {
        ...eventBase('diagnostic-session-updated', 'session_updated'),
        type: 'session_updated',
        data: {
          sessionId: 'handoff-session',
          taskStatus: 'completed',
        },
      },
    ];

    const diagnostic = formatTokenBudgetTranscriptDiagnostic({
      events,
      expectedFinal: fixture.finalMarker,
      surfaceFinalSeen: true,
    });

    expect(diagnostic).toContain(
      '"tools":{"bashCalls":2,"bashSuccesses":1,"writeCalls":1,' +
        '"writeSuccesses":1,"otherCalls":0,"completeResults":3}'
    );
    expect(diagnostic).toContain(
      '"lifecycle":{"checkpoints":1,"turnCompleted":1,' +
        '"turnAborted":0,"surfaceFinalSeen":true}'
    );
    expect(diagnostic).toMatch(/"final":{"present":true,"expectedMarkerPresent":true,/);
    expect(diagnostic).toMatch(/"sha256Prefix":"[a-f0-9]{12}"/);
    expect(diagnostic).not.toContain(secret);
    expect(diagnostic).not.toContain(fixture.finalMarker);
    expect(diagnostic).not.toContain(fixture.targetPath);
    expect(diagnostic).not.toContain(fixture.targetContent);
    expect(Buffer.byteLength(diagnostic)).toBeLessThanOrEqual(2_048);
  });

  it('attaches only bounded transcript facts to request-sequence failures', () => {
    const secret = 'request-sequence-diagnostic-secret';
    const events: SessionEvent[] = [
      toolPart('diagnostic-bash-call', 'diagnostic-bash', 'Bash', 'tool_call', {
        input: { command: `bun test ${secret}` },
      }),
      toolPart('diagnostic-bash-result', 'diagnostic-bash', 'Bash', 'tool_result', {
        output: { stdout: secret },
        error: null,
      }),
    ];

    expect(() =>
      assertTokenBudgetRequestSequenceWithTranscript({
        evidence: { requests: [], maxInFlight: 1 },
        targets: { handoffPromptTokens: 70_000, compactionPromptTokens: 80_000 },
        events,
        expectedFinal: `FINAL_OK_${secret}`,
        surfaceFinalSeen: false,
      })
    ).toThrow(
      'count=0; sequence=; transcript={"tools":{"bashCalls":1,' + '"bashSuccesses":1'
    );
    try {
      assertTokenBudgetRequestSequenceWithTranscript({
        evidence: { requests: [], maxInFlight: 1 },
        targets: { handoffPromptTokens: 70_000, compactionPromptTokens: 80_000 },
        events,
        expectedFinal: `FINAL_OK_${secret}`,
        surfaceFinalSeen: false,
      });
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });

  it('bounds Web final-timeout diagnostics to structural facts', () => {
    expect(
      formatTokenBudgetWebFinalDiagnostic({
        status: 'running',
        providerRequests: 4,
        publicFinalSeen: false,
        domFinalSeen: false,
      })
    ).toBe('status_running:requests_4:history_0:dom_0');
    expect(
      formatTokenBudgetWebFinalDiagnostic({
        status: 'provider secret text',
        providerRequests: 99,
        publicFinalSeen: true,
        domFinalSeen: false,
      })
    ).toBe('status_unknown:requests_overflow:history_1:dom_0');
    expect(
      formatTokenBudgetWebFinalDiagnostic({
        status: 'completed',
        providerRequests: Number.NaN,
        publicFinalSeen: true,
        domFinalSeen: true,
      })
    ).toBe('status_completed:requests_invalid:history_1:dom_1');
  });

  it('bounds Web task-start diagnostics and reports request deltas', () => {
    expect(
      formatTokenBudgetWebTaskStartDiagnostic({
        status: 'completed',
        providerRequestsBefore: 2,
        providerRequestsAfter: 2,
        publicInputSeen: false,
      })
    ).toBe('status_completed:requests_0:input_0');
    expect(
      formatTokenBudgetWebTaskStartDiagnostic({
        status: 'failed',
        providerRequestsBefore: 2,
        providerRequestsAfter: 4,
        publicInputSeen: true,
      })
    ).toBe('status_failed:requests_2:input_1');
    expect(
      formatTokenBudgetWebTaskStartDiagnostic({
        status: 'private status',
        providerRequestsBefore: 4,
        providerRequestsAfter: 3,
        publicInputSeen: true,
      })
    ).toBe('status_unknown:requests_invalid:input_1');
  });

  it('does not treat a fresh Session terminal status as a submitted turn', () => {
    expect(
      classifyTokenBudgetWebTaskStartObservation({
        status: 'completed',
        providerRequestsBefore: 2,
        providerRequestsAfter: 2,
        publicInputSeen: false,
      })
    ).toBe('pending');
    expect(
      classifyTokenBudgetWebTaskStartObservation({
        status: 'running',
        providerRequestsBefore: 2,
        providerRequestsAfter: 2,
        publicInputSeen: true,
      })
    ).toBe('active');
    expect(
      classifyTokenBudgetWebTaskStartObservation({
        status: 'completed',
        providerRequestsBefore: 2,
        providerRequestsAfter: 3,
        publicInputSeen: true,
      })
    ).toBe('terminal');
    expect(
      classifyTokenBudgetWebTaskStartObservation({
        status: 'failed',
        providerRequestsBefore: 2,
        providerRequestsAfter: 2,
        publicInputSeen: true,
      })
    ).toBe('terminal');
  });

  it('waits for completed Web runs to publish their final projection', () => {
    expect(isTokenBudgetWebRunFailure('completed')).toBe(false);
    expect(isTokenBudgetWebRunFailure('idle')).toBe(false);
    expect(isTokenBudgetWebRunFailure('waiting_permission')).toBe(false);
    expect(isTokenBudgetWebRunFailure('failed')).toBe(true);
    expect(isTokenBudgetWebRunFailure('cancelled')).toBe(true);
    expect(isTokenBudgetWebRunFailure('interrupted')).toBe(true);
    expect(isTokenBudgetWebRunFailure('error')).toBe(true);
  });

  it('bounds Web proxy diagnostics to the first request shape', () => {
    expect(
      formatTokenBudgetWebProxyDiagnostic({
        maxInFlight: 1,
        requests: [
          {
            ordinal: 1,
            kind: 'task',
            markerOccurrences: 0,
            bodyBytes: 512,
            bodySha256: 'a'.repeat(64),
            upstreamStatus: 200,
            responseKind: 'sse',
            usageShape: 'root-terminal',
            usageRewritten: true,
          },
        ],
      })
    ).toBe('first_task:s200:sse:root-terminal:rewritten_1:inflight_1');
    expect(formatTokenBudgetWebProxyDiagnostic({ maxInFlight: 99, requests: [] })).toBe(
      'first_none:s0:unknown:unknown:rewritten_0:inflight_overflow'
    );
  });

  it('rejects ledgers missing any required continuation section', () => {
    const sections = parseContinuationLedger(
      '## Objective and constraints\ncontinue\n' +
        '## Decisions and rationale\npreserve\n' +
        '## Workspace mutations\nMUTATION_7f31ABCDEF12 status=applied\n' +
        '## Verification evidence\nFAILED_19acABCDEF12 status=failed\n' +
        '## Active tasks and background work\nnone\n' +
        '## Open risks or blockers\nnone'
    );
    expect(() =>
      assertContinuationLedger(sections, {
        mutation: 'MUTATION_7f31ABCDEF12',
        failedVerification: 'FAILED_19acABCDEF12',
        pendingAction: 'PENDING_a8d2ABCDEF12',
      })
    ).toThrow('required section');
  });

  it('rejects out-of-order headings and sentinels absent from authoritative sections', () => {
    expect(() =>
      parseContinuationLedger(
        '## Decisions and rationale\npreserve\n' +
          '## Objective and constraints\ncontinue\n' +
          '## Workspace mutations\nMUTATION_7f31ABCDEF12\n' +
          '## Verification evidence\nfailed FAILED_19acABCDEF12\n' +
          '## Active tasks and background work\nnone\n' +
          '## Open risks or blockers\nnone\n' +
          '## Exact next action\nPENDING_a8d2ABCDEF12 status=pending'
      )
    ).toThrow('order');

    const wrongSection = parseContinuationLedger(
      '## Objective and constraints\ncontinue\n' +
        '## Decisions and rationale\npreserve\n' +
        '## Workspace mutations\nMUTATION_7f31ABCDEF12 status=applied\n' +
        '## Verification evidence\nFAILED_19acABCDEF12 status=failed\n' +
        '## Active tasks and background work\nPENDING_a8d2ABCDEF12 status=pending\n' +
        '## Open risks or blockers\nnone\n' +
        '## Exact next action\ncontinue'
    );
    expect(() =>
      assertContinuationLedger(wrongSection, {
        mutation: 'MUTATION_7f31ABCDEF12',
        failedVerification: 'FAILED_19acABCDEF12',
        pendingAction: 'PENDING_a8d2ABCDEF12',
      })
    ).toThrow('pending action sentinel');

    const mutationInWrongSection = parseContinuationLedger(
      '## Objective and constraints\ncontinue\n' +
        '## Decisions and rationale\npreserve\n' +
        '## Workspace mutations\nnone\n' +
        '## Verification evidence\nMUTATION_7f31ABCDEF12 status=applied\n' +
        '## Active tasks and background work\nnone\n' +
        '## Open risks or blockers\nnone\n' +
        '## Exact next action\nMUTATION_7f31ABCDEF12 status=pending'
    );
    expect(() =>
      assertContinuationLedger(mutationInWrongSection, {
        mutation: 'MUTATION_7f31ABCDEF12',
        failedVerification: 'MUTATION_7f31ABCDEF12',
        pendingAction: 'MUTATION_7f31ABCDEF12',
      })
    ).toThrow('mutation sentinel');
  });

  it('validates the bounded structural Provider request sequence', () => {
    const evidence: TokenBudgetProxyEvidence = {
      maxInFlight: 1,
      requests: [
        {
          ordinal: 1,
          kind: 'task',
          markerOccurrences: 0,
          bodyBytes: 10,
          bodySha256: 'a'.repeat(64),
          targetPromptTokens: 70_000,
          usageRewritten: true,
        },
        {
          ordinal: 2,
          kind: 'task',
          markerOccurrences: 1,
          bodyBytes: 10,
          bodySha256: 'b'.repeat(64),
          targetPromptTokens: 80_000,
          usageRewritten: true,
        },
        {
          ordinal: 3,
          kind: 'compaction',
          markerOccurrences: 0,
          bodyBytes: 10,
          bodySha256: 'c'.repeat(64),
          usageRewritten: false,
        },
        {
          ordinal: 4,
          kind: 'task',
          markerOccurrences: 0,
          bodyBytes: 10,
          bodySha256: 'd'.repeat(64),
          usageRewritten: false,
        },
        {
          ordinal: 5,
          kind: 'task',
          markerOccurrences: 0,
          bodyBytes: 10,
          bodySha256: 'e'.repeat(64),
          usageRewritten: false,
        },
      ],
    };
    const targets = {
      handoffPromptTokens: 70_000,
      compactionPromptTokens: 80_000,
    };
    expect(() => assertTokenBudgetRequestSequence(evidence, targets)).not.toThrow();
    const retryEvidence: TokenBudgetProxyEvidence = {
      maxInFlight: 1,
      requests: [
        ...evidence.requests.slice(0, 2),
        {
          ...evidence.requests[2]!,
          upstreamStatus: 503,
          responseKind: 'json',
          injectedFailure: 'compaction_transient',
        },
        {
          ...evidence.requests[2]!,
          ordinal: 4,
          bodySha256: 'f'.repeat(64),
          upstreamStatus: 200,
        },
        {
          ...evidence.requests[3]!,
          ordinal: 5,
          bodySha256: '1'.repeat(64),
        },
        {
          ...evidence.requests[4]!,
          ordinal: 6,
          bodySha256: '2'.repeat(64),
        },
      ],
    };
    expect(() =>
      assertTokenBudgetRequestSequence(retryEvidence, targets, {
        expectCompactionRetry: true,
      })
    ).not.toThrow();
    expect(() =>
      assertTokenBudgetRequestSequence(evidence, targets, {
        expectCompactionRetry: true,
      })
    ).toThrow('6 to 10 requests');
    expect(() =>
      assertTokenBudgetRequestSequence(
        {
          ...evidence,
          requests: [
            ...evidence.requests,
            {
              ...evidence.requests[4]!,
              ordinal: 6,
              bodySha256: 'f'.repeat(64),
            },
            {
              ...evidence.requests[4]!,
              ordinal: 7,
              bodySha256: '1'.repeat(64),
            },
          ],
        },
        targets
      )
    ).not.toThrow();
    expect(() =>
      assertTokenBudgetRequestSequence(
        { ...evidence, requests: evidence.requests.slice(0, 4) },
        targets
      )
    ).toThrow(
      'count=4; sequence=1:task:m0:r1:s0:kunknown:uunknown,' +
        '2:task:m1:r1:s0:kunknown:uunknown,' +
        '3:compaction:m0:r0:s0:kunknown:uunknown,' +
        '4:task:m0:r0:s0:kunknown:uunknown'
    );
    expect(() =>
      assertTokenBudgetRequestSequence(
        {
          ...evidence,
          requests: evidence.requests.map((request, index) =>
            index === 1 ? { ...request, markerOccurrences: 2 } : request
          ),
        },
        targets
      )
    ).toThrow('marker');
    expect(() =>
      assertTokenBudgetRequestSequence(
        {
          ...evidence,
          requests: [
            ...evidence.requests,
            {
              ...evidence.requests[4]!,
              ordinal: 6,
              kind: 'compaction',
              bodySha256: 'f'.repeat(64),
            },
          ],
        },
        targets
      )
    ).toThrow('corrective request 6');
  });

  it('validates append-only marker, checkpoint, ledger, tools, and final file', async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'blade-handoff-transcript-'));
    roots.push(workspace);
    const fixture = await createTokenBudgetHandoffFixture(
      workspace,
      'Transcript1234567'
    );
    mkdirSync(path.dirname(fixture.targetPath), { recursive: true });
    writeFileSync(fixture.targetPath, fixture.targetContent);
    const events = transcript(fixture);

    expect(() => assertTokenBudgetTranscript(events, fixture)).not.toThrow();
    expect(() =>
      assertTokenBudgetTranscript(events, fixture, {
        expectedSampleAttempts: 2,
      })
    ).not.toThrow();
    expect(() => assertTokenBudgetTranscript([...events, events[2]!], fixture)).toThrow(
      'one v1 marker'
    );
    const projected = projectTokenBudgetHandoffEvent(events[2]!);
    if (!projected) throw new Error('Expected projected transcript marker');
    expect(() =>
      assertTokenBudgetTranscript(transcript(fixture, [projected]), fixture)
    ).toThrow('replacement');
    const leakedSuffix: Extract<SessionEvent, { type: 'part_created' }> = {
      ...eventBase('leaked-suffix', 'part_created'),
      type: 'part_created',
      data: {
        partId: 'leaked-suffix',
        messageId: 'leaked-suffix-message',
        partType: 'text',
        payload: { text: TOKEN_BUDGET_HANDOFF_TAG },
        createdAt: '2026-08-19T00:00:02.000Z',
      },
    };
    expect(() =>
      assertTokenBudgetTranscript([...events, leakedSuffix], fixture)
    ).toThrow('suffix');
    const leakedSessionUpdate = {
      ...eventBase('leaked-session-update', 'session_updated'),
      type: 'session_updated',
      data: { taskPromptSummary: TOKEN_BUDGET_HANDOFF_TAG },
    } satisfies Extract<SessionEvent, { type: 'session_updated' }>;
    expect(() =>
      assertTokenBudgetTranscript([...events, leakedSessionUpdate], fixture)
    ).toThrow('suffix');
  });

  it('rejects secrets present anywhere in transcript evidence', async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'blade-handoff-secret-'));
    roots.push(workspace);
    const fixture = await createTokenBudgetHandoffFixture(
      workspace,
      'SecretTrace123456'
    );
    mkdirSync(path.dirname(fixture.targetPath), { recursive: true });
    writeFileSync(fixture.targetPath, fixture.targetContent);
    const events = transcript(fixture);
    const secret = 'provider-secret-value';
    expect(() =>
      assertTokenBudgetEvidenceSafe({ events, diagnostic: { provider: secret } }, [
        secret,
      ])
    ).toThrow('Secret material');
  });

  it('rejects secrets and hidden marker structures in evidence', () => {
    expect(() =>
      assertTokenBudgetEvidenceSafe({ request: { ordinal: 1 } }, ['secret-value'])
    ).not.toThrow();
    expect(() =>
      assertTokenBudgetEvidenceSafe({ nested: new Set(['secret-value']) }, [
        'secret-value',
      ])
    ).toThrow('Secret material');
    expect(() =>
      assertTokenBudgetEvidenceSafe({ text: TOKEN_BUDGET_HANDOFF_TAG }, [])
    ).toThrow('hidden marker');
  });

  it('retains only a bounded diagnostic tail and removes listeners on close', () => {
    expect(() => new BoundedStringSink(0)).toThrow('positive');
    const sink = new BoundedStringSink(5);
    sink.on('drain', () => undefined);
    expect(sink.write('abc')).toBe(true);
    expect(sink.write(Buffer.from('def'))).toBe(true);
    expect(sink.value()).toBe('bcdef');
    sink.close();
    expect(sink.eventNames()).toEqual([]);
  });

  it('preserves UTF-8 characters split across bounded sink Buffer writes', () => {
    const sink = new BoundedStringSink(5);
    const bytes = Buffer.from('éTAIL');
    sink.write(bytes.subarray(0, 1));
    sink.write(bytes.subarray(1));
    expect(sink.value()).toBe('éTAIL');
    sink.close();
  });

  it('does not flush a partial UTF-8 character for an empty string write', () => {
    const sink = new BoundedStringSink(5);
    const bytes = Buffer.from('éTAIL');
    sink.write(bytes.subarray(0, 1));
    sink.write('');
    sink.write(bytes.subarray(1));
    expect(sink.value()).toBe('éTAIL');
    sink.close();
  });

  it('projects only safe surface facts after strict completion checks', () => {
    const recovery = {
      kind: 'cold_projection' as const,
      completed: true,
      providerRequestsBefore: 4,
      providerRequestsAfter: 4,
    };
    const evidence = assertAndProjectSurfaceEvidence({
      surface: 'headless',
      sessionId: 'safe-session',
      exitCode: 0,
      output: 'FINAL_OK_1234567890\n',
      stderr: '',
      expected: 'FINAL_OK_1234567890',
      forbidden: [TOKEN_BUDGET_HANDOFF_TAG, 'handoff-message-1'],
      recovery,
    });
    expect(evidence).toEqual({
      surface: 'headless',
      sessionId: 'safe-session',
      finalMarkerSeen: true,
      hiddenMarkerSeen: false,
      recovery,
      faults: [],
    });
    expect(evidence).not.toHaveProperty('output');
    expect(() =>
      assertAndProjectSurfaceEvidence({
        surface: 'headless',
        sessionId: 'safe-session',
        exitCode: 1,
        output: 'FINAL_OK_1234567890',
        stderr: '',
        expected: 'FINAL_OK_1234567890',
        forbidden: [],
        recovery,
      })
    ).toThrow('exit');
    expect(() =>
      assertAndProjectSurfaceEvidence({
        surface: 'headless',
        sessionId: 'safe-session',
        exitCode: 0,
        output: `${TOKEN_BUDGET_HANDOFF_TAG} FINAL_OK_1234567890`,
        stderr: '',
        expected: 'FINAL_OK_1234567890',
        forbidden: [TOKEN_BUDGET_HANDOFF_TAG],
        recovery,
      })
    ).toThrow('forbidden');
    expect(() =>
      assertAndProjectSurfaceEvidence({
        surface: 'headless',
        sessionId: 'unsafe\nsession',
        exitCode: 0,
        output: 'FINAL_OK_1234567890',
        stderr: '',
        expected: 'FINAL_OK_1234567890',
        forbidden: [],
        recovery,
      })
    ).toThrow('session');
  });

  it('parses only bounded safe cold-projection evidence', () => {
    const safe = {
      modelHasMarker: false,
      publicHasMarker: false,
      modelMessageCount: 3,
      publicMessageCount: 8,
    };
    const encode = (value: unknown): string =>
      `${TOKEN_BUDGET_PROJECTION_EVIDENCE_PREFIX}${JSON.stringify(value)}\n`;
    expect(parseTokenBudgetHandoffProjectionEvidence(encode(safe))).toEqual(safe);
    expect(() =>
      parseTokenBudgetHandoffProjectionEvidence(
        encode({ ...safe, modelHasMarker: true })
      )
    ).toThrow('marker');
    expect(() =>
      parseTokenBudgetHandoffProjectionEvidence(
        encode({ ...safe, diagnostic: TOKEN_BUDGET_HANDOFF_TAG })
      )
    ).toThrow('hidden');
    expect(() =>
      parseTokenBudgetHandoffProjectionEvidence(
        encode({ ...safe, diagnostic: 'projection-secret' }),
        ['projection-secret']
      )
    ).toThrow('secret');
    expect(() =>
      parseTokenBudgetHandoffProjectionEvidence(encode({ ...safe, extra: true }))
    ).toThrow('keys');
    expect(() =>
      parseTokenBudgetHandoffProjectionEvidence(`${JSON.stringify(safe)}\n`)
    ).toThrow('prefix');
    expect(() =>
      parseTokenBudgetHandoffProjectionEvidence(
        `${TOKEN_BUDGET_PROJECTION_EVIDENCE_PREFIX}{"modelHasMarker":true,"modelHasMarker":false,"publicHasMarker":false,"modelMessageCount":3,"publicMessageCount":8}\n`
      )
    ).toThrow('canonical');
    expect(() =>
      parseTokenBudgetHandoffProjectionEvidence(`\n${encode(safe)}`)
    ).toThrow('prefix');
    expect(() =>
      parseTokenBudgetHandoffProjectionEvidence(encode(safe).trimEnd())
    ).toThrow('prefix');
    expect(() =>
      parseTokenBudgetHandoffProjectionEvidence(
        encode(safe),
        ['stderr-secret'],
        'stderr-secret'
      )
    ).toThrow('secret');
    expect(() =>
      parseTokenBudgetHandoffProjectionEvidence(
        encode(safe),
        [],
        'unexpected diagnostic'
      )
    ).toThrow('stderr');
    expect(() => parseTokenBudgetHandoffProjectionEvidence('x'.repeat(64_001))).toThrow(
      'budget'
    );
  });

  it('rejects unsafe projection runner isolation before spawning', async () => {
    const base = {
      sessionId: 'safe-session',
      workspace: '/tmp/token-budget-workspace',
      home: '/tmp/token-budget-home',
      storageRoot: '/tmp/token-budget-storage',
    };
    await expect(
      runTokenBudgetHandoffProjectionRunner({ ...base, home: 'relative-home' })
    ).rejects.toThrow('absolute');
    await expect(
      runTokenBudgetHandoffProjectionRunner({
        ...base,
        storageRoot: 'relative-storage',
      })
    ).rejects.toThrow('absolute');
    await expect(
      runTokenBudgetHandoffProjectionRunner({ ...base, timeoutMs: 0 })
    ).rejects.toThrow('timeout');
  });

  it('latches hidden output split across chunks before bounded-tail eviction', () => {
    const sink = new TokenBudgetHandoffOutputSink(8, [TOKEN_BUDGET_HANDOFF_TAG]);
    const midpoint = Math.floor(TOKEN_BUDGET_HANDOFF_TAG.length / 2);
    sink.write(TOKEN_BUDGET_HANDOFF_TAG.slice(0, midpoint));
    sink.write(TOKEN_BUDGET_HANDOFF_TAG.slice(midpoint));
    sink.write('x'.repeat(64));
    sink.close();

    expect(sink.value()).toBe('xxxxxxxx');
    expect(sink.forbiddenSeen()).toBe(true);
  });

  it('validates bounded PTY task and resume evidence', () => {
    const safe = {
      ...baseSurfaceEvidence('pty'),
      recovery: { ...safeRecovery, kind: 'pty_resume' as const },
      composerReady: true,
      bracketedPasteAccepted: true,
      taskExited: true,
      resumeExited: true,
      processGone: true,
      resumeSubmittedInput: false,
      output: 'FINAL_OK_safe',
    };
    expect(parseTokenBudgetHandoffPtyEvidence(JSON.stringify(safe))).toEqual(safe);
    for (const unsafe of [
      { ...safe, composerReady: false },
      { ...safe, resumeSubmittedInput: true },
      { ...safe, faults: ['timeout'] },
      {
        ...safe,
        recovery: { ...safe.recovery, providerRequestsAfter: 6 },
      },
      { ...safe, output: TOKEN_BUDGET_HANDOFF_TAG },
      { ...safe, output: 'token_budget_handoff_recorded' },
      { ...safe, output: 'handoff-message-1' },
    ]) {
      expect(() =>
        parseTokenBudgetHandoffPtyEvidence(JSON.stringify(unsafe))
      ).toThrow();
    }
    expect(() =>
      parseTokenBudgetHandoffPtyEvidence(
        JSON.stringify({ ...safe, output: 'pty-secret' }),
        ['pty-secret']
      )
    ).toThrow('secret');
  });

  it('fails a PTY wait as soon as a nonmatching durable final is authoritative', () => {
    expect(classifyTokenBudgetPtyFinal(undefined, 'FINAL_OK_expected')).toBe('pending');
    expect(classifyTokenBudgetPtyFinal('FINAL_OK_expected', 'FINAL_OK_expected')).toBe(
      'matched'
    );
    expect(
      classifyTokenBudgetPtyFinal('FINAL_OK_expected\nextra text', 'FINAL_OK_expected')
    ).toBe('mismatched');
  });

  it('validates bounded ACP task and load evidence', () => {
    const safe = {
      ...baseSurfaceEvidence('acp'),
      recovery: { ...safeRecovery, kind: 'acp_load' as const },
      stopReason: 'end_turn' as const,
      hiddenUserChunkSeen: false,
      terminalCreationCount: 1,
      terminalReleaseCount: 1,
      activeTerminalCount: 0,
      releasedProcessesGone: true,
      taskRunnerExited: true,
      loadRunnerExited: true,
    };
    expect(parseTokenBudgetHandoffAcpEvidence(JSON.stringify(safe))).toEqual(safe);
    for (const unsafe of [
      { ...safe, stopReason: 'cancelled' },
      { ...safe, hiddenUserChunkSeen: true },
      { ...safe, terminalReleaseCount: 0 },
      { ...safe, activeTerminalCount: 1 },
      { ...safe, releasedProcessesGone: false },
      { ...safe, nested: { text: TOKEN_BUDGET_HANDOFF_TAG } },
      {
        ...safe,
        recovery: { ...safe.recovery, providerRequestsAfter: 6 },
      },
    ]) {
      expect(() =>
        parseTokenBudgetHandoffAcpEvidence(JSON.stringify(unsafe))
      ).toThrow();
    }
    expect(() =>
      parseTokenBudgetHandoffAcpEvidence(
        JSON.stringify({ ...safe, nested: { text: 'acp-secret' } }),
        ['acp-secret']
      )
    ).toThrow('secret');
  });

  it('parses only exact canonical bounded ACP runner failure evidence', () => {
    const expectedFinal = 'FINAL_OK_RUNNER_FAILURE_1234567890';
    const taskExpectation = { mode: 'task' as const, finalMarker: expectedFinal };
    const loadExpectation = { mode: 'load' as const, finalMarker: expectedFinal };
    const safe = {
      success: false,
      mode: 'task',
      stage: 'prompt',
      timedOut: true,
      promptAttempted: true,
      stopReason: null,
      finalMarkerSeen: false,
      hiddenMaterialSeen: false,
      surfaceFinalPresent: true,
      surfaceFinalByteSizeBucket: '1_4096',
      surfaceFinalSha256Prefix: 'a1b2c3d4e5f6',
      terminalCreationCount: 1,
      terminalReleaseCount: 1,
      activeTerminalCount: 0,
      releasedProcessesGone: true,
      cleanupComplete: true,
      exited: true,
      faults: ['runner_failed', 'timeout', 'final_missing'],
    } as const;

    expect(
      parseTokenBudgetAcpRunnerFailure(JSON.stringify(safe), taskExpectation)
    ).toEqual(safe);
    const promptBudgetExpiredBeforeStart = {
      ...safe,
      promptAttempted: false,
      finalMarkerSeen: false,
      surfaceFinalPresent: false,
      surfaceFinalByteSizeBucket: 0,
      surfaceFinalSha256Prefix: null,
      faults: ['runner_failed', 'timeout'],
    } as const;
    expect(
      parseTokenBudgetAcpRunnerFailure(
        JSON.stringify(promptBudgetExpiredBeforeStart),
        taskExpectation
      )
    ).toEqual(promptBudgetExpiredBeforeStart);
    expect(() =>
      parseTokenBudgetAcpRunnerFailure(
        JSON.stringify({ ...safe, extra: true }),
        taskExpectation
      )
    ).toThrow('incomplete');
    expect(() =>
      parseTokenBudgetAcpRunnerFailure(
        JSON.stringify({ ...safe, detail: 'runner-failure-secret' }),
        { ...taskExpectation, secrets: ['runner-failure-secret'] }
      )
    ).toThrow('secret');
    expect(() =>
      parseTokenBudgetAcpRunnerFailure(
        JSON.stringify({ ...safe, surfaceFinalSha256Prefix: 'INVALID_HASH' }),
        taskExpectation
      )
    ).toThrow('incomplete');
    for (const stage of ['initialize', 'new_session', 'set_mode'] as const) {
      expect(() =>
        parseTokenBudgetAcpRunnerFailure(
          JSON.stringify({
            ...safe,
            stage,
            timedOut: false,
            promptAttempted: false,
            surfaceFinalPresent: false,
            surfaceFinalByteSizeBucket: 0,
            surfaceFinalSha256Prefix: null,
            faults: ['runner_failed', 'final_missing'],
          }),
          taskExpectation
        )
      ).toThrow('incomplete');
    }
    const invalidModeStages = [
      { evidence: { ...safe, stage: 'load' }, expected: taskExpectation },
      {
        evidence: {
          ...safe,
          mode: 'load',
          stage: 'prompt',
          promptAttempted: false,
          faults: ['runner_failed', 'timeout'],
        },
        expected: loadExpectation,
      },
      { evidence: { ...safe, stage: 'cleanup' }, expected: taskExpectation },
      {
        evidence: { ...safe, mode: 'load', stage: 'load' },
        expected: taskExpectation,
      },
    ];
    for (const invalid of invalidModeStages) {
      expect(() =>
        parseTokenBudgetAcpRunnerFailure(
          JSON.stringify(invalid.evidence),
          invalid.expected
        )
      ).toThrow('incomplete');
    }
    expect(() =>
      parseTokenBudgetAcpRunnerFailure(
        JSON.stringify({
          ...safe,
          terminalReleaseCount: 0,
          releasedProcessesGone: false,
        }),
        taskExpectation
      )
    ).toThrow('incomplete');
    expect(() =>
      parseTokenBudgetAcpRunnerFailure(
        JSON.stringify({
          ...safe,
          surfaceFinalByteSizeBucket: 0,
        }),
        taskExpectation
      )
    ).toThrow('incomplete');
    const impossible = [
      {
        evidence: {
          ...safe,
          mode: 'load',
          stage: 'load',
          timedOut: false,
          promptAttempted: false,
          stopReason: 'end_turn',
          finalMarkerSeen: false,
          faults: ['runner_failed'],
        },
        expected: loadExpectation,
      },
      {
        evidence: {
          ...safe,
          stage: 'initialize',
          timedOut: false,
          promptAttempted: false,
          faults: ['runner_failed'],
        },
        expected: taskExpectation,
      },
      {
        evidence: {
          ...safe,
          stage: 'cleanup',
          timedOut: false,
          cleanupComplete: true,
          faults: ['runner_failed', 'final_missing'],
        },
        expected: taskExpectation,
      },
      {
        evidence: {
          ...safe,
          timedOut: false,
          surfaceFinalPresent: false,
          surfaceFinalByteSizeBucket: 0,
          surfaceFinalSha256Prefix: null,
          faults: ['runner_failed'],
        },
        expected: taskExpectation,
      },
    ];
    for (const entry of impossible) {
      expect(() =>
        parseTokenBudgetAcpRunnerFailure(JSON.stringify(entry.evidence), entry.expected)
      ).toThrow('incomplete');
    }
    expect(() =>
      parseTokenBudgetAcpRunnerFailure(JSON.stringify(safe, null, 2), taskExpectation)
    ).toThrow('canonical');
    expect(() =>
      parseTokenBudgetAcpRunnerFailure('x'.repeat(64_001), taskExpectation)
    ).toThrow('budget');
    expect(() =>
      parseTokenBudgetAcpRunnerFailure('界'.repeat(22_000), taskExpectation)
    ).toThrow('budget');
  });

  it('parses only internally consistent ACP runner success evidence', () => {
    const expectedFinal = 'FINAL_OK_RUNNER_SUCCESS_1234567890';
    const expectedHash = createHash('sha256')
      .update(expectedFinal)
      .digest('hex')
      .slice(0, 12);
    const taskExpectation = { mode: 'task' as const, finalMarker: expectedFinal };
    const loadExpectation = { mode: 'load' as const, finalMarker: expectedFinal };
    const safe = {
      success: true,
      mode: 'task',
      sessionId: 'safe-runner-session',
      stopReason: 'end_turn',
      finalMarkerSeen: true,
      surfaceFinalPresent: true,
      surfaceFinalByteSizeBucket: '1_4096',
      surfaceFinalSha256Prefix: expectedHash,
      hiddenMarkerSeen: false,
      hiddenUserChunkSeen: false,
      terminalCreationCount: 0,
      terminalReleaseCount: 0,
      activeTerminalCount: 0,
      releasedProcessesGone: true,
      exited: true,
      faults: [],
    } as const;

    expect(
      parseTokenBudgetAcpRunnerSuccess(JSON.stringify(safe), taskExpectation)
    ).toEqual(safe);
    expect(() =>
      parseTokenBudgetAcpRunnerSuccess(
        JSON.stringify({
          ...safe,
          surfaceFinalByteSizeBucket: '16385_plus',
          surfaceFinalSha256Prefix: 'deadbeefcafe',
        }),
        taskExpectation
      )
    ).toThrow('incomplete');
    expect(() =>
      parseTokenBudgetAcpRunnerSuccess(
        JSON.stringify({ ...safe, finalMarkerSeen: false }),
        taskExpectation
      )
    ).toThrow('incomplete');
    const validLoad = {
      ...safe,
      mode: 'load',
      stopReason: null,
      finalMarkerSeen: false,
      surfaceFinalPresent: false,
      surfaceFinalByteSizeBucket: 0,
      surfaceFinalSha256Prefix: null,
    } as const;
    expect(
      parseTokenBudgetAcpRunnerSuccess(JSON.stringify(validLoad), loadExpectation)
    ).toEqual(validLoad);
    const unsafe: Array<{
      evidence: Record<string, unknown>;
      expected: typeof taskExpectation | typeof loadExpectation;
    }> = [
      { evidence: { ...safe, surfaceFinalPresent: false }, expected: taskExpectation },
      {
        evidence: { ...safe, surfaceFinalByteSizeBucket: 0 },
        expected: taskExpectation,
      },
      {
        evidence: { ...safe, surfaceFinalSha256Prefix: null },
        expected: taskExpectation,
      },
      {
        evidence: { ...safe, mode: 'load', stopReason: null, finalMarkerSeen: false },
        expected: loadExpectation,
      },
      {
        evidence: {
          ...validLoad,
          surfaceFinalByteSizeBucket: '1_4096',
        },
        expected: loadExpectation,
      },
    ];
    for (const entry of unsafe) {
      expect(() =>
        parseTokenBudgetAcpRunnerSuccess(JSON.stringify(entry.evidence), entry.expected)
      ).toThrow('incomplete');
    }
  });

  it('describes an ACP runner rejection using only validated stdout evidence', () => {
    const stderrSecret = 'runner-stderr-secret';
    const rawPath = '/private/token-budget/workspace/private-file.txt';
    const safe = {
      success: false,
      mode: 'load',
      stage: 'load',
      timedOut: false,
      promptAttempted: false,
      stopReason: null,
      finalMarkerSeen: false,
      hiddenMaterialSeen: false,
      surfaceFinalPresent: false,
      surfaceFinalByteSizeBucket: 0,
      surfaceFinalSha256Prefix: null,
      terminalCreationCount: 0,
      terminalReleaseCount: 0,
      activeTerminalCount: 0,
      releasedProcessesGone: true,
      cleanupComplete: true,
      exited: true,
      faults: ['runner_failed'],
    } as const;

    const message = describeTokenBudgetAcpRunnerFailure(
      {
        stdout: JSON.stringify(safe),
        stderr: `provider said ${stderrSecret}`,
        message: `runner failed in ${rawPath}`,
        code: 1,
        signal: null,
        killed: false,
      },
      {
        mode: 'load',
        finalMarker: 'FINAL_OK_RUNNER_FAILURE_1234567890',
        secrets: [stderrSecret],
      }
    );

    expect(message).toBe(
      `Token-budget ACP runner failed; diagnostic=${JSON.stringify(safe)}`
    );
    expect(message).not.toContain(stderrSecret);
    expect(message).not.toContain(rawPath);
  });

  it('uses fixed process diagnostics when ACP runner stdout is unavailable or unsafe', () => {
    const secret = 'unsafe-runner-stdout-secret';
    expect(
      describeTokenBudgetAcpRunnerFailure(
        { code: 'ETIMEDOUT', killed: false, stderr: secret },
        {
          mode: 'task',
          finalMarker: 'FINAL_OK_RUNNER_FAILURE_1234567890',
          secrets: [secret],
        }
      )
    ).toBe(
      'Token-budget ACP runner failed; diagnostic=' +
        '{"stage":"process","exitKind":"timeout"}'
    );
    expect(
      describeTokenBudgetAcpRunnerFailure(
        { killed: true, signal: 'SIGKILL', stderr: secret },
        {
          mode: 'task',
          finalMarker: 'FINAL_OK_RUNNER_FAILURE_1234567890',
          secrets: [secret],
        }
      )
    ).toBe(
      'Token-budget ACP runner failed; diagnostic=' +
        '{"stage":"process","exitKind":"timeout"}'
    );
    expect(
      describeTokenBudgetAcpRunnerFailure(
        {
          stdout: JSON.stringify({ success: false, detail: secret }),
          stderr: `unsafe stderr ${secret}`,
          code: 7,
        },
        {
          mode: 'task',
          finalMarker: 'FINAL_OK_RUNNER_FAILURE_1234567890',
          secrets: [secret],
        }
      )
    ).toBe(
      'Token-budget ACP runner failed; diagnostic=' +
        '{"stage":"process","exitKind":"nonzero"}'
    );
  });

  it('projects only fixed safe facts from cleanup probe failures', () => {
    const secret = 'cleanup-probe-diagnostic-secret';
    const path = `/private/cleanup/${secret}`;
    const incomplete = JSON.stringify({
      stage: 'set_mode',
      promptAttempted: false,
      timedOut: true,
      cancelled: true,
      closed: false,
      naturalExit: false,
    });

    expect(
      describeTokenBudgetAcpCleanupProbeFailure(
        { stdout: incomplete, stderr: secret, message: path, code: 1 },
        1
      )
    ).toBe(
      'Token-budget ACP cleanup probe failed; diagnostic=' +
        '{"stage":"runner","requestCount":"1","evidence":' +
        '{"stage":"set_mode","promptAttempted":false,' +
        '"timedOut":true,"cancelled":true,"closed":false,' +
        '"naturalExit":false}}'
    );
    expect(
      describeTokenBudgetAcpCleanupProbeFailure(
        { code: 'ETIMEDOUT', killed: true, stderr: secret, message: path },
        0
      )
    ).toBe(
      'Token-budget ACP cleanup probe failed; diagnostic=' +
        '{"stage":"process","requestCount":"0","exitKind":"timeout"}'
    );
  });

  it('distinguishes cleanup probe teardown boundaries without raw errors', () => {
    expect(
      describeTokenBudgetAcpCleanupProbeTeardownFailure({
        providerCloseFailed: true,
        rootCleanupFailed: false,
      })
    ).toBe(
      'Token-budget ACP cleanup probe teardown failed; diagnostic=' +
        '{"providerCloseFailed":true,"rootCleanupFailed":false}'
    );
  });

  it('latches only forbidden user message text during ACP load', () => {
    const hiddenMarker = '<token-budget-handoff version="1">';
    const forbidden = ['', hiddenMarker];
    const visibleUserChunk = {
      sessionId: 'token-budget-load-session',
      update: {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'ordinary replayed user text' },
      },
    } satisfies acp.SessionNotification;
    const hiddenUserChunk = {
      sessionId: 'token-budget-load-session',
      update: {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: `prefix ${hiddenMarker} suffix` },
      },
    } satisfies acp.SessionNotification;
    const splitHiddenUserChunks = [
      {
        sessionId: 'token-budget-load-session',
        update: {
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text: '<token-budget-hand' },
        },
      },
      {
        sessionId: 'token-budget-load-session',
        update: {
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text: 'off version="1">' },
        },
      },
    ] satisfies acp.SessionNotification[];

    expect(hasUnexpectedLoadUserChunk('load', [visibleUserChunk], forbidden)).toBe(
      false
    );
    expect(hasUnexpectedLoadUserChunk('load', [hiddenUserChunk], forbidden)).toBe(true);
    expect(hasUnexpectedLoadUserChunk('load', splitHiddenUserChunks, forbidden)).toBe(
      true
    );
    const splitAgentChunks = splitHiddenUserChunks.map((notification) => ({
      ...notification,
      update: {
        ...notification.update,
        sessionUpdate: 'agent_message_chunk' as const,
      },
    }));
    expect(hasUnexpectedSurfaceMessageChunk(splitAgentChunks, forbidden)).toBe(true);
    expect(hasUnexpectedLoadUserChunk('task', [hiddenUserChunk], forbidden)).toBe(
      false
    );
    expect(hasUnexpectedLoadUserChunk('load', [], forbidden)).toBe(false);
  });

  it('projects only assistant chunks after the final ACP tool boundary', () => {
    const sessionId = 'token-budget-task-session';
    const updates = [
      {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'I will inspect the workspace.' },
        },
      },
      {
        sessionId,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'call-1',
          status: 'in_progress',
          title: 'Executing Bash',
          content: [],
          kind: 'execute',
        },
      },
      {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'FINAL_OK_' },
        },
      },
      {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'ABCDEF1234567890' },
        },
      },
    ] satisfies acp.SessionNotification[];

    expect(finalAgentTextFromUpdates(updates)).toBe('FINAL_OK_ABCDEF1234567890');
  });

  it('projects only content after the final Headless tool boundary', () => {
    expect(
      finalHeadlessTextFromEvents([
        {
          event_version: 1,
          type: 'content_delta',
          delta: 'I will inspect the workspace.',
        },
        {
          event_version: 1,
          type: 'tool_start',
          tool_name: 'Bash',
          summary: 'Run verification',
        },
        {
          event_version: 1,
          type: 'content_delta',
          delta: 'FINAL_OK_',
        },
        {
          event_version: 1,
          type: 'content_delta',
          delta: 'ABCDEF1234567890',
        },
      ])
    ).toBe('FINAL_OK_ABCDEF1234567890');
  });

  it('bounds ACP task final failures to surface and durable structural facts', () => {
    const secret = 'acp-task-final-diagnostic-secret';
    const events: SessionEvent[] = [
      toolPart('acp-diag-call', 'acp-diag', 'Bash', 'tool_call', {
        input: { command: `bun test ${secret}` },
      }),
      toolPart('acp-diag-result', 'acp-diag', 'Bash', 'tool_result', {
        output: { stdout: secret },
        error: null,
      }),
    ];

    const diagnostic = formatTokenBudgetAcpTaskFailureDiagnostic({
      stopReason: 'end_turn',
      surfaceFinalSeen: false,
      surfaceFinalPresent: true,
      surfaceFinalByteSizeBucket: '1_4096',
      surfaceFinalSha256Prefix: 'a1b2c3d4e5f6',
      providerRequests: 4,
      terminalCreationCount: 1,
      terminalReleaseCount: 1,
      activeTerminalCount: 0,
      releasedProcessesGone: true,
      events,
      expectedFinal: `FINAL_OK_${secret}`,
    });

    expect(diagnostic).toContain(
      'stop_end_turn:surface_final_0:surface_present_1:surface_bytes_1_4096:' +
        'surface_sha_a1b2c3d4e5f6:requests_4:terminals_1_1_0:gone_1:'
    );
    expect(diagnostic).toContain(
      'transcript_read={"tools":{"bashCalls":1,"bashSuccesses":1'
    );
    expect(diagnostic).not.toContain(secret);
    expect(Buffer.byteLength(diagnostic)).toBeLessThanOrEqual(2_048);
  });

  it('gives each ACP operation bounded parent-process cleanup grace', () => {
    const startedAt = 1_000_000;
    const deadlineAt = startedAt + 270_000;

    const task = resolveTokenBudgetAcpRunTimeouts({
      stage: 'task',
      deadlineAt,
      now: startedAt,
    });
    const load = resolveTokenBudgetAcpRunTimeouts({
      stage: 'load',
      deadlineAt,
      now: startedAt + 250_000,
    });

    expect(task).toEqual({
      operationTimeoutMs: 230_000,
      processTimeoutMs: 240_000,
    });
    expect(load).toEqual({
      operationTimeoutMs: 10_000,
      processTimeoutMs: 20_000,
    });
    expect(task.processTimeoutMs).toBeGreaterThan(task.operationTimeoutMs);
    expect(load.processTimeoutMs).toBeGreaterThan(load.operationTimeoutMs);
  });

  it('keeps cleanup-probe setup separate from the intentional prompt timeout', () => {
    expect(resolveTokenBudgetAcpCleanupProbeTimeouts()).toEqual({
      setupTimeoutMs: 30_000,
      promptTimeoutMs: 20_000,
      processTimeoutMs: 70_000,
    });
  });

  it('passes only the selected hashed Provider key to ACP runner children', () => {
    const selected = 'selected-provider-secret';
    const other = 'other-provider-secret';
    const env = buildTokenBudgetAcpRunnerEnvironment({
      source: {
        PATH: '/usr/bin',
        DEEPSEEK_API_KEY: selected,
        CLAUDE_API_KEY: other,
        BLADE_MODEL_API_KEY_A1B2: selected,
        BLADE_REAL_API_PROVIDER_KEY_C3D4: selected,
        BLADE_REAL_API_PROVIDER_KEY_E5F6: other,
        SAFE_SETTING: 'visible',
      },
      home: '/tmp/blade-acp-home',
      storageRoot: '/tmp/blade-acp-storage',
      encodedInput: 'canonical-input',
      secrets: [selected],
    });

    expect(env).toEqual({
      PATH: '/usr/bin',
      BLADE_MODEL_API_KEY_A1B2: selected,
      BLADE_REAL_API_PROVIDER_KEY_C3D4: selected,
      SAFE_SETTING: 'visible',
      HOME: '/tmp/blade-acp-home',
      BLADE_STORAGE_ROOT: '/tmp/blade-acp-storage',
      BLADE_AUTO_MEMORY: '0',
      BLADE_TELEMETRY_DISABLED: '1',
      TERM: 'xterm-256color',
      BLADE_TOKEN_BUDGET_ACP_INPUT: 'canonical-input',
    });
    expect(env).not.toHaveProperty('DEEPSEEK_API_KEY');
    expect(env).not.toHaveProperty('CLAUDE_API_KEY');
    expect(env).not.toHaveProperty('BLADE_REAL_API_PROVIDER_KEY_E5F6');
  });

  it(
    'preserves visible ACP surface facts when the prompt rejects or times out',
    () => {
      const runner = path.resolve(
        import.meta.dirname,
        '../../support/tokenBudgetHandoffAcpRunner.ts'
      );
      const visibleText = 'VISIBLE_PARTIAL_FINAL';
      for (const probe of ['visible-rejection', 'visible-timeout'] as const) {
        const result = spawnSync('bun', [runner, '--failure-evidence-probe', probe], {
          cwd: path.resolve(import.meta.dirname, '../../..'),
          encoding: 'utf8',
          timeout: ACP_FAILURE_PROBE_PROCESS_TIMEOUT_MS,
          killSignal: 'SIGKILL',
        });
        const timedOut = probe === 'visible-timeout';
        const finalMarker = timedOut ? visibleText : 'FINAL_OK_PROBE';

        expect(result.status).toBe(0);
        expect(result.stderr).toBe('');
        expect(
          parseTokenBudgetAcpRunnerFailure(result.stdout, {
            mode: 'task',
            finalMarker,
          })
        ).toEqual({
          success: false,
          mode: 'task',
          stage: 'prompt',
          timedOut,
          promptAttempted: true,
          stopReason: null,
          finalMarkerSeen: timedOut,
          hiddenMaterialSeen: false,
          surfaceFinalPresent: true,
          surfaceFinalByteSizeBucket: '1_4096',
          surfaceFinalSha256Prefix: createHash('sha256')
            .update(visibleText)
            .digest('hex')
            .slice(0, 12),
          terminalCreationCount: 0,
          terminalReleaseCount: 0,
          activeTerminalCount: 0,
          releasedProcessesGone: true,
          cleanupComplete: true,
          exited: true,
          faults: [
            'runner_failed',
            ...(timedOut ? (['timeout'] as const) : []),
            ...(timedOut ? [] : (['final_missing'] as const)),
          ],
        });
      }
    },
    ACP_FAILURE_PROBE_DOUBLE_TEST_TIMEOUT_MS
  );

  it(
    'times out ACP setup inside the operation budget and still closes cleanly',
    () => {
      const runner = path.resolve(
        import.meta.dirname,
        '../../support/tokenBudgetHandoffAcpRunner.ts'
      );
      const result = spawnSync(
        'bun',
        [runner, '--failure-evidence-probe', 'set-mode-timeout'],
        {
          cwd: path.resolve(import.meta.dirname, '../../..'),
          encoding: 'utf8',
          timeout: ACP_FAILURE_PROBE_PROCESS_TIMEOUT_MS,
          killSignal: 'SIGKILL',
        }
      );

      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(
        parseTokenBudgetAcpRunnerFailure(result.stdout, {
          mode: 'task',
          finalMarker: 'FINAL_OK_PROBE',
        })
      ).toEqual({
        success: false,
        mode: 'task',
        stage: 'set_mode',
        timedOut: true,
        promptAttempted: false,
        stopReason: null,
        finalMarkerSeen: false,
        hiddenMaterialSeen: false,
        surfaceFinalPresent: false,
        surfaceFinalByteSizeBucket: 0,
        surfaceFinalSha256Prefix: null,
        terminalCreationCount: 0,
        terminalReleaseCount: 0,
        activeTerminalCount: 0,
        releasedProcessesGone: true,
        cleanupComplete: true,
        exited: true,
        faults: ['runner_failed', 'timeout'],
      });
    },
    ACP_FAILURE_PROBE_SINGLE_TEST_TIMEOUT_MS
  );

  it(
    'does not report a missing ACP final before prompt starts',
    () => {
      const runner = path.resolve(
        import.meta.dirname,
        '../../support/tokenBudgetHandoffAcpRunner.ts'
      );
      const result = spawnSync(
        'bun',
        [runner, '--failure-evidence-probe', 'pre-prompt-failure'],
        {
          cwd: path.resolve(import.meta.dirname, '../../..'),
          encoding: 'utf8',
          timeout: ACP_FAILURE_PROBE_PROCESS_TIMEOUT_MS,
          killSignal: 'SIGKILL',
        }
      );

      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(
        parseTokenBudgetAcpRunnerFailure(result.stdout, {
          mode: 'task',
          finalMarker: 'FINAL_OK_PROBE',
        })
      ).toEqual({
        success: false,
        mode: 'task',
        stage: 'initialize',
        timedOut: false,
        promptAttempted: false,
        stopReason: null,
        finalMarkerSeen: false,
        hiddenMaterialSeen: false,
        surfaceFinalPresent: false,
        surfaceFinalByteSizeBucket: 0,
        surfaceFinalSha256Prefix: null,
        terminalCreationCount: 0,
        terminalReleaseCount: 0,
        activeTerminalCount: 0,
        releasedProcessesGone: true,
        cleanupComplete: true,
        exited: true,
        faults: ['runner_failed'],
      });
    },
    ACP_FAILURE_PROBE_SINGLE_TEST_TIMEOUT_MS
  );

  it(
    'reports a falsy ACP rejection instead of accepting a load as successful',
    () => {
      const runner = path.resolve(
        import.meta.dirname,
        '../../support/tokenBudgetHandoffAcpRunner.ts'
      );
      const result = spawnSync(
        'bun',
        [runner, '--failure-evidence-probe', 'falsy-load-rejection'],
        {
          cwd: path.resolve(import.meta.dirname, '../../..'),
          encoding: 'utf8',
          timeout: ACP_FAILURE_PROBE_PROCESS_TIMEOUT_MS,
          killSignal: 'SIGKILL',
        }
      );

      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(
        parseTokenBudgetAcpRunnerFailure(result.stdout, {
          mode: 'load',
          finalMarker: 'FINAL_OK_PROBE',
        })
      ).toEqual({
        success: false,
        mode: 'load',
        stage: 'load',
        timedOut: false,
        promptAttempted: false,
        stopReason: null,
        finalMarkerSeen: false,
        hiddenMaterialSeen: false,
        surfaceFinalPresent: false,
        surfaceFinalByteSizeBucket: 0,
        surfaceFinalSha256Prefix: null,
        terminalCreationCount: 0,
        terminalReleaseCount: 0,
        activeTerminalCount: 0,
        releasedProcessesGone: true,
        cleanupComplete: true,
        exited: true,
        faults: ['runner_failed'],
      });
    },
    ACP_FAILURE_PROBE_SINGLE_TEST_TIMEOUT_MS
  );

  it(
    'reports a falsy ACP cleanup rejection instead of accepting success',
    () => {
      const runner = path.resolve(
        import.meta.dirname,
        '../../support/tokenBudgetHandoffAcpRunner.ts'
      );
      const result = spawnSync(
        'bun',
        [runner, '--failure-evidence-probe', 'falsy-cleanup-rejection'],
        {
          cwd: path.resolve(import.meta.dirname, '../../..'),
          encoding: 'utf8',
          timeout: ACP_FAILURE_PROBE_PROCESS_TIMEOUT_MS,
          killSignal: 'SIGKILL',
        }
      );

      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(
        parseTokenBudgetAcpRunnerFailure(result.stdout, {
          mode: 'load',
          finalMarker: 'FINAL_OK_PROBE',
        })
      ).toEqual({
        success: false,
        mode: 'load',
        stage: 'cleanup',
        timedOut: false,
        promptAttempted: false,
        stopReason: null,
        finalMarkerSeen: false,
        hiddenMaterialSeen: false,
        surfaceFinalPresent: false,
        surfaceFinalByteSizeBucket: 0,
        surfaceFinalSha256Prefix: null,
        terminalCreationCount: 0,
        terminalReleaseCount: 0,
        activeTerminalCount: 0,
        releasedProcessesGone: true,
        cleanupComplete: false,
        exited: true,
        faults: ['runner_failed', 'cleanup_incomplete'],
      });
    },
    ACP_FAILURE_PROBE_SINGLE_TEST_TIMEOUT_MS
  );

  it('refuses to start an ACP stage inside the cleanup reserve', () => {
    expect(
      resolveTokenBudgetAcpRunTimeouts({
        stage: 'load',
        deadlineAt: 1_270_000,
        now: 1_260_000,
      })
    ).toEqual({ operationTimeoutMs: 0, processTimeoutMs: 0 });
    expect(
      resolveTokenBudgetAcpRunTimeouts({
        stage: 'task',
        deadlineAt: 1_270_000,
        now: 1_230_000,
      })
    ).toEqual({ operationTimeoutMs: 0, processTimeoutMs: 0 });
  });

  it('caps each ACP stage and rejects unsafe deadline inputs', () => {
    expect(
      resolveTokenBudgetAcpRunTimeouts({
        stage: 'task',
        deadlineAt: 1_400_000,
        now: 1_000_000,
      })
    ).toEqual({ operationTimeoutMs: 270_000, processTimeoutMs: 280_000 });
    expect(
      resolveTokenBudgetAcpRunTimeouts({
        stage: 'load',
        deadlineAt: 1_100_000,
        now: 1_000_000,
      })
    ).toEqual({ operationTimeoutMs: 30_000, processTimeoutMs: 40_000 });
    expect(() =>
      resolveTokenBudgetAcpRunTimeouts({
        stage: 'load',
        deadlineAt: Number.MAX_SAFE_INTEGER + 1,
        now: 1_000_000,
      })
    ).toThrow('Token-budget ACP deadline is invalid');
    expect(() =>
      resolveTokenBudgetAcpRunTimeouts({
        stage: 'load',
        deadlineAt: 1_100_000,
        now: Number.MAX_SAFE_INTEGER + 1,
      })
    ).toThrow('Token-budget ACP deadline is invalid');
  });

  it('validates bounded Web reload and cleanup evidence', () => {
    const safe = {
      ...baseSurfaceEvidence('web'),
      recovery: { ...safeRecovery, kind: 'web_reload' as const },
      httpHistoryClean: true,
      sseClean: true,
      domClean: true,
      htmlClean: true,
      reloadCompleted: true,
      launcherGone: true,
      portReusable: true,
    };
    expect(parseTokenBudgetHandoffWebEvidence(JSON.stringify(safe))).toEqual(safe);
    for (const unsafe of [
      { ...safe, httpHistoryClean: false },
      { ...safe, sseClean: false },
      { ...safe, domClean: false },
      { ...safe, reloadCompleted: false },
      { ...safe, launcherGone: false },
      { ...safe, portReusable: false },
      { ...safe, faults: ['pageerror'] },
      { ...safe, nested: { html: TOKEN_BUDGET_HANDOFF_TAG } },
      {
        ...safe,
        recovery: { ...safe.recovery, providerRequestsAfter: 6 },
      },
    ]) {
      expect(() =>
        parseTokenBudgetHandoffWebEvidence(JSON.stringify(unsafe))
      ).toThrow();
    }
    expect(() =>
      parseTokenBudgetHandoffWebEvidence(
        JSON.stringify({ ...safe, nested: { html: 'web-secret' } }),
        ['web-secret']
      )
    ).toThrow('secret');
  });
});
