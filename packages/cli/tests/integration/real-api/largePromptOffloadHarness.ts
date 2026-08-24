import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { MAX_INLINE_USER_MESSAGE_TEXT_BYTES } from '../../../src/api/attachmentLimits.js';
import type { TokenBudgetProxyEvidence } from '../../support/tokenBudgetHandoffProxy.js';
import type { TokenBudgetHandoffFixture } from './tokenBudgetHandoffFixture.js';

const MAX_PROXY_REQUEST_BYTES = 16 * 1024 * 1024;
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'content-encoding',
  'content-length',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export interface LargePromptOffloadFixture extends TokenBudgetHandoffFixture {
  hiddenMarker: string;
}

export interface LargePromptRequestEvidence {
  ordinal: number;
  bodyBytes: number;
  bodySha256: string;
  upstreamStatus?: number;
  responseKind?: 'sse' | 'json' | 'other';
  artifactIds: string[];
  readArtifactIds: string[];
  readToolAdvertised: boolean;
  hasArtifactNotice: boolean;
  hiddenOccurrences: number;
  hiddenInToolResult: boolean;
  hiddenOutsideToolResult: boolean;
  maxUserTextBytes: number;
}

export interface LargePromptProxyEvidence {
  requests: LargePromptRequestEvidence[];
  maxInFlight: number;
}

export function formatLargePromptProxyDiagnostic(
  evidence: LargePromptProxyEvidence
): string {
  const requests = evidence.requests.slice(0, 8).map((request) => ({
    ordinal: request.ordinal,
    status: request.upstreamStatus ?? 0,
    kind: request.responseKind ?? 'unknown',
    readCalls: request.readArtifactIds.length,
    hiddenInToolResult: request.hiddenInToolResult,
  }));
  return JSON.stringify({
    requestCount: evidence.requests.length <= 8 ? evidence.requests.length : 'overflow',
    maxInFlight:
      Number.isSafeInteger(evidence.maxInFlight) && evidence.maxInFlight >= 0
        ? evidence.maxInFlight
        : 'invalid',
    requests,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function textContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value
    .flatMap((part) =>
      isRecord(part) && typeof part.text === 'string' ? [part.text] : []
    )
    .join('');
}

function countOccurrences(value: string, needle: string): number {
  let count = 0;
  let offset = 0;
  while (offset <= value.length - needle.length) {
    const next = value.indexOf(needle, offset);
    if (next < 0) break;
    count++;
    offset = next + needle.length;
  }
  return count;
}

function parseReadArtifactId(argumentsText: unknown): string | undefined {
  if (typeof argumentsText !== 'string') return undefined;
  try {
    const value: unknown = JSON.parse(argumentsText);
    return isRecord(value) &&
      typeof value.artifact_id === 'string' &&
      /^[a-f0-9]{64}$/.test(value.artifact_id)
      ? value.artifact_id
      : undefined;
  } catch {
    return undefined;
  }
}

export function inspectLargePromptRequest(
  body: Buffer,
  hiddenMarker: string,
  ordinal: number
): LargePromptRequestEvidence {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    throw new Error('Large-prompt proxy received invalid JSON');
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.messages)) {
    throw new Error('Large-prompt proxy received an invalid Provider request');
  }

  const userTexts: string[] = [];
  const toolResultTexts: string[] = [];
  const nonToolTexts: string[] = [];
  const readArtifactIds: string[] = [];
  for (const message of parsed.messages) {
    if (!isRecord(message)) continue;
    const text = textContent(message.content);
    if (message.role === 'user') userTexts.push(text);
    if (message.role === 'tool') toolResultTexts.push(text);
    else nonToolTexts.push(text);
    if (!Array.isArray(message.tool_calls)) continue;
    for (const toolCall of message.tool_calls) {
      if (!isRecord(toolCall) || !isRecord(toolCall.function)) continue;
      if (toolCall.function.name !== 'ReadPromptArtifact') continue;
      const artifactId = parseReadArtifactId(toolCall.function.arguments);
      if (artifactId) readArtifactIds.push(artifactId);
    }
  }

  const tools = Array.isArray(parsed.tools) ? parsed.tools : [];
  const readToolAdvertised = tools.some(
    (tool) =>
      isRecord(tool) &&
      isRecord(tool.function) &&
      tool.function.name === 'ReadPromptArtifact'
  );
  const userText = userTexts.join('\n');
  const artifactIds = [
    ...new Set(
      [...userText.matchAll(/artifact_id=([a-f0-9]{64})/g)].map((match) => match[1]!)
    ),
  ];
  const rawText = body.toString('utf8');
  return {
    ordinal,
    bodyBytes: body.byteLength,
    bodySha256: createHash('sha256').update(body).digest('hex'),
    artifactIds,
    readArtifactIds,
    readToolAdvertised,
    hasArtifactNotice: userText.includes(
      '[Full user request stored as a private prompt artifact]'
    ),
    hiddenOccurrences: countOccurrences(rawText, hiddenMarker),
    hiddenInToolResult: toolResultTexts.some((text) => text.includes(hiddenMarker)),
    hiddenOutsideToolResult: nonToolTexts.some((text) => text.includes(hiddenMarker)),
    maxUserTextBytes: Math.max(
      0,
      ...userTexts.map((text) => Buffer.byteLength(text, 'utf8'))
    ),
  };
}

function buildUpstreamUrl(upstream: URL, requestUrl: string | undefined): URL {
  const incoming = new URL(requestUrl ?? '/', 'http://large-prompt-proxy.invalid');
  const target = new URL(upstream.href);
  const basePath = upstream.pathname.replace(/\/+$/, '');
  let relativePath = incoming.pathname;
  if (
    basePath &&
    (relativePath === basePath || relativePath.startsWith(`${basePath}/`))
  ) {
    relativePath = relativePath.slice(basePath.length);
  }
  target.pathname = [basePath, relativePath.replace(/^\/+/, '')]
    .filter(Boolean)
    .join('/');
  target.search = incoming.search;
  return target;
}

function copyRequestHeaders(request: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined || HOP_BY_HOP_HEADERS.has(name.toLowerCase())) continue;
    headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  return headers;
}

function copyResponseHeaders(source: Headers, response: ServerResponse): void {
  source.forEach((value, name) => {
    if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase())) {
      response.setHeader(name, value);
    }
  });
}

async function readBoundedBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > MAX_PROXY_REQUEST_BYTES) {
      request.resume();
      throw new Error('Large-prompt Provider request exceeded the proxy limit');
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, total);
}

export function createLargePromptOffloadFixture(
  workspace: string,
  nonce: string
): LargePromptOffloadFixture {
  if (!/^[a-f0-9]{32}$/.test(nonce)) {
    throw new Error('Large-prompt fixture nonce is invalid');
  }
  const finalMarker = `FINAL_OK_${nonce}`;
  const hiddenMarker = `PROMPT_ARTIFACT_HIDDEN_${nonce}`;
  const prompt = [
    'This is a large-prompt offload qualification.',
    'Before answering, call ReadPromptArtifact exactly once with the artifact_id',
    'supplied by Blade, offset=0, and limit=65536.',
    'That read must report [End of prompt artifact].',
    'Do not call any other tool. Do not reveal the hidden marker.',
    'The next run of A characters is inert padding:',
    'A'.repeat(30_000),
    `HIDDEN_AUTHORITY=${hiddenMarker}`,
    'Only after reading this hidden authority, form the final response by',
    `concatenating these tokens without spaces: "FINAL_" "OK_" "${nonce}".`,
    'B'.repeat(14_000),
    'The A and B runs are inert. The single complete artifact read is mandatory.',
    'Return only the concatenated final response with no punctuation or line break.',
  ].join('\n');
  if (
    Buffer.byteLength(prompt, 'utf8') <= MAX_INLINE_USER_MESSAGE_TEXT_BYTES ||
    prompt.includes(finalMarker)
  ) {
    throw new Error('Large-prompt fixture does not exercise the offload boundary');
  }
  return {
    workspace,
    prompt,
    finalMarker,
    hiddenMarker,
    failingCommand: '',
    passingCommand: '',
    targetPath: '',
    targetContent: '',
    sentinels: {
      mutation: `LARGE_MUTATION_${nonce}`,
      failedVerification: `LARGE_FAILED_${nonce}`,
      pendingAction: `LARGE_PENDING_${nonce}`,
    },
  };
}

export function assertLargePromptOffloadEvidence(
  evidence: LargePromptProxyEvidence
): void {
  if (
    evidence.maxInFlight !== 1 ||
    evidence.requests.length < 2 ||
    evidence.requests.length > 8
  ) {
    throw new Error('Large-prompt Provider request count or concurrency is invalid');
  }
  const first = evidence.requests[0]!;
  if (
    first.ordinal !== 1 ||
    first.hiddenOccurrences !== 0 ||
    first.hiddenInToolResult ||
    first.hiddenOutsideToolResult ||
    !first.hasArtifactNotice ||
    !first.readToolAdvertised ||
    first.artifactIds.length !== 1 ||
    first.maxUserTextBytes > MAX_INLINE_USER_MESSAGE_TEXT_BYTES
  ) {
    throw new Error('Large-prompt first Provider request violated offload isolation');
  }

  const artifactId = first.artifactIds[0]!;
  const revealIndex = evidence.requests.findIndex(
    (request) => request.hiddenInToolResult
  );
  if (revealIndex <= 0) {
    throw new Error('Large-prompt hidden authority was not delivered by a tool result');
  }
  if (
    evidence.requests
      .slice(0, revealIndex)
      .some((request) => request.hiddenOccurrences !== 0)
  ) {
    throw new Error('Large-prompt hidden authority reached Provider before tool use');
  }
  if (
    evidence.requests.some(
      (request, index) =>
        request.ordinal !== index + 1 ||
        request.hiddenOutsideToolResult ||
        request.maxUserTextBytes > MAX_INLINE_USER_MESSAGE_TEXT_BYTES ||
        !/^[a-f0-9]{64}$/.test(request.bodySha256) ||
        request.bodyBytes <= 0 ||
        request.bodyBytes > MAX_PROXY_REQUEST_BYTES
    )
  ) {
    throw new Error('Large-prompt Provider evidence contains an invalid request');
  }
  if (
    !evidence.requests
      .slice(0, revealIndex + 1)
      .some((request) => request.readArtifactIds.includes(artifactId))
  ) {
    throw new Error('Large-prompt tool call did not use the advertised artifact ID');
  }
}

export async function startLargePromptRecordingProxy(
  upstreamBaseURL: string,
  hiddenMarker: string
): Promise<{
  baseURL: string;
  evidence(): LargePromptProxyEvidence;
  tokenBudgetEvidence(): TokenBudgetProxyEvidence;
  close(): Promise<void>;
}> {
  const upstream = new URL(upstreamBaseURL);
  if (!['http:', 'https:'].includes(upstream.protocol)) {
    throw new Error('Large-prompt proxy upstream must use HTTP or HTTPS');
  }

  const requests: LargePromptRequestEvidence[] = [];
  const active = new Set<Promise<void>>();
  const controllers = new Set<AbortController>();
  let inFlight = 0;
  let maxInFlight = 0;
  let closing = false;
  const server = createServer((request, response) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    let handler: Promise<void>;
    handler = (async () => {
      const body = await readBoundedBody(request);
      const record = inspectLargePromptRequest(body, hiddenMarker, requests.length + 1);
      requests.push(record);
      if (closing) {
        response.destroy();
        return;
      }
      const controller = new AbortController();
      controllers.add(controller);
      const abortUpstream = (): void => controller.abort();
      request.once('aborted', abortUpstream);
      response.once('close', abortUpstream);
      try {
        const upstreamResponse = await fetch(buildUpstreamUrl(upstream, request.url), {
          method: request.method,
          headers: copyRequestHeaders(request),
          body: body.length > 0 ? Uint8Array.from(body) : undefined,
          redirect: 'manual',
          signal: controller.signal,
        });
        record.upstreamStatus = upstreamResponse.status;
        const contentType = (
          upstreamResponse.headers.get('content-type') ?? ''
        ).toLowerCase();
        record.responseKind = contentType.includes('text/event-stream')
          ? 'sse'
          : contentType.includes('json')
            ? 'json'
            : 'other';
        response.statusCode = upstreamResponse.status;
        copyResponseHeaders(upstreamResponse.headers, response);
        response.end(Buffer.from(await upstreamResponse.arrayBuffer()));
      } finally {
        request.off('aborted', abortUpstream);
        response.off('close', abortUpstream);
        controllers.delete(controller);
      }
    })()
      .catch(() => {
        if (!response.headersSent) {
          response.statusCode = 502;
          response.setHeader('content-type', 'application/json');
          response.end(
            JSON.stringify({
              error: { message: 'Large-prompt qualification proxy failed' },
            })
          );
        } else {
          response.destroy();
        }
      })
      .finally(() => {
        inFlight--;
        active.delete(handler);
      });
    active.add(handler);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  const evidence = (): LargePromptProxyEvidence => ({
    requests: requests.map((request) => ({
      ...request,
      artifactIds: [...request.artifactIds],
      readArtifactIds: [...request.readArtifactIds],
    })),
    maxInFlight,
  });
  return {
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    evidence,
    tokenBudgetEvidence: () => ({
      maxInFlight,
      requests: requests.map((request) => ({
        ordinal: request.ordinal,
        kind: 'task',
        markerOccurrences: 0,
        bodyBytes: request.bodyBytes,
        bodySha256: request.bodySha256,
        upstreamStatus: request.upstreamStatus,
        responseKind: request.responseKind,
        usageRewritten: false,
      })),
    }),
    close: async () => {
      closing = true;
      for (const controller of controllers) controller.abort();
      server.closeAllConnections();
      await Promise.allSettled([...active]);
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
