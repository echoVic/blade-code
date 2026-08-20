import { createHash } from 'node:crypto';
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { TOKEN_BUDGET_HANDOFF_TAG } from '../../src/context/TokenBudgetHandoff.js';

export interface TokenBudgetRequestEvidence {
  ordinal: number;
  kind: 'task' | 'compaction';
  markerOccurrences: number;
  bodyBytes: number;
  bodySha256: string;
  targetPromptTokens?: number;
  upstreamStatus?: number;
  responseKind?: 'sse' | 'json' | 'other';
  usageShape?:
    | 'root-empty'
    | 'root-terminal'
    | 'root-nonempty'
    | 'choice'
    | 'missing'
    | 'invalid';
  usageRewritten: boolean;
}

export interface TokenBudgetProxyEvidence {
  requests: TokenBudgetRequestEvidence[];
  maxInFlight: number;
}

interface RequestFacts {
  kind: TokenBudgetRequestEvidence['kind'];
  markerOccurrences: number;
  bodyBytes: number;
  bodySha256: string;
}

interface ReadRequestResult {
  body: Buffer;
  parsed: unknown;
  bodySha256: string;
}

interface FrameBoundary {
  index: number;
  length: number;
}

interface RewrittenSseFrame {
  bytes: Buffer;
  rewritten: boolean;
  usageShape: NonNullable<TokenBudgetRequestEvidence['usageShape']>;
}

interface SseDataSegment {
  dataStart: number;
  dataEnd: number;
  frameStart: number;
  value: string;
}

interface JsonPropertySpan {
  key: string;
  valueStart: number;
  valueEnd: number;
}

interface JsonObjectSpans {
  end: number;
  properties: JsonPropertySpan[];
}

interface ByteReplacement {
  start: number;
  end: number;
  value: string;
}

export interface ProxyWritableResponse {
  readonly destroyed: boolean;
  readonly writableEnded: boolean;
  write(chunk: Uint8Array): boolean;
  once(event: 'drain' | 'close', listener: () => void): void;
  off(event: 'drain' | 'close', listener: () => void): void;
}

const MAX_REQUEST_BODY_BYTES = 16 * 1024 * 1024;
const MAX_TARGET_SSE_VALIDATION_BYTES = 16 * 1024 * 1024;
const CONTINUATION_LEDGER_HEADINGS = [
  'Objective and constraints',
  'Decisions and rationale',
  'Workspace mutations',
  'Verification evidence',
  'Active tasks and background work',
  'Open risks or blockers',
  'Exact next action',
] as const;
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

class InvalidRequestJsonError extends Error {}
class RequestBodyTooLargeError extends Error {}
class TargetUsageMissingError extends Error {}
class TargetSseValidationLimitError extends Error {}
class TargetSseInvalidEncodingError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return isNonNegativeSafeInteger(value) && value > 0;
}

function messageContentTexts(body: unknown): string[] {
  if (!isRecord(body) || !Array.isArray(body.messages)) return [];

  const texts: string[] = [];
  for (const message of body.messages) {
    if (!isRecord(message)) continue;
    const content = message.content;
    if (typeof content === 'string') {
      texts.push(content);
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (typeof part === 'string') {
        texts.push(part);
      } else if (isRecord(part) && typeof part.text === 'string') {
        texts.push(part.text);
      }
    }
  }
  return texts;
}

function countExactOccurrences(text: string, markerTag: string): number {
  let count = 0;
  let offset = 0;
  while (offset <= text.length - markerTag.length) {
    const next = text.indexOf(markerTag, offset);
    if (next < 0) break;
    count++;
    offset = next + markerTag.length;
  }
  return count;
}

function classifyRequest(
  body: unknown,
  markerTag: string
): {
  kind: TokenBudgetRequestEvidence['kind'];
  markerOccurrences: number;
} {
  const texts = messageContentTexts(body);
  const markerOccurrences = texts.reduce(
    (total, text) => total + countExactOccurrences(text, markerTag),
    0
  );
  const toolsAreEmpty =
    isRecord(body) &&
    (body.tools === undefined ||
      (Array.isArray(body.tools) && body.tools.length === 0));
  const hasCompleteLedger = CONTINUATION_LEDGER_HEADINGS.every((heading) =>
    texts.some((text) => text.includes(heading))
  );
  return {
    kind: toolsAreEmpty && hasCompleteLedger ? 'compaction' : 'task',
    markerOccurrences,
  };
}

function inspectParsedRequest(
  body: unknown,
  rawBody: Uint8Array,
  bodySha256: string,
  markerTag: string
): RequestFacts {
  const classification = classifyRequest(body, markerTag);
  return {
    ...classification,
    bodyBytes: rawBody.byteLength,
    bodySha256,
  };
}

export function inspectTokenBudgetRequest(
  body: unknown
): Omit<
  TokenBudgetRequestEvidence,
  'ordinal' | 'targetPromptTokens' | 'usageRewritten'
> {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(body);
  } catch {
    throw new InvalidRequestJsonError('Token budget request must be JSON-serializable');
  }
  if (serialized === undefined) {
    throw new InvalidRequestJsonError('Token budget request must be JSON-serializable');
  }
  const rawBody = Buffer.from(serialized);
  return inspectParsedRequest(
    body,
    rawBody,
    createHash('sha256').update(rawBody).digest('hex'),
    TOKEN_BUDGET_HANDOFF_TAG
  );
}

async function readJsonRequest(request: IncomingMessage): Promise<ReadRequestResult> {
  const chunks: Buffer[] = [];
  const hash = createHash('sha256');
  let bodyBytes = 0;

  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bodyBytes += bytes.byteLength;
    if (bodyBytes > MAX_REQUEST_BODY_BYTES) {
      request.resume();
      throw new RequestBodyTooLargeError('Request body exceeds proxy limit');
    }
    hash.update(bytes);
    chunks.push(bytes);
  }

  const body = Buffer.concat(chunks, bodyBytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    throw new InvalidRequestJsonError('Request body is not valid JSON');
  }
  return { body, parsed, bodySha256: hash.digest('hex') };
}

function connectionHeaderNames(value: string | string[] | undefined): Set<string> {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return new Set(
    values
      .flatMap((entry) => entry.split(','))
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean)
  );
}

function copyRequestHeaders(request: IncomingMessage): Headers {
  const copied = new Headers();
  const dynamicHopHeaders = connectionHeaderNames(request.headers.connection);
  for (const [name, value] of Object.entries(request.headers)) {
    const normalizedName = name.toLowerCase();
    if (
      value === undefined ||
      normalizedName === 'host' ||
      normalizedName === 'content-length' ||
      HOP_BY_HOP_HEADERS.has(normalizedName) ||
      dynamicHopHeaders.has(normalizedName)
    ) {
      continue;
    }
    copied.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  return copied;
}

function copyResponseHeaders(headers: Headers): OutgoingHttpHeaders {
  const copied: OutgoingHttpHeaders = {};
  const dynamicHopHeaders = connectionHeaderNames(
    headers.get('connection') ?? undefined
  );
  headers.forEach((value, name) => {
    const normalizedName = name.toLowerCase();
    if (
      !HOP_BY_HOP_HEADERS.has(normalizedName) &&
      !dynamicHopHeaders.has(normalizedName) &&
      normalizedName !== 'content-encoding' &&
      normalizedName !== 'content-length'
    ) {
      copied[name] = value;
    }
  });
  const setCookies = headers.getSetCookie();
  if (setCookies.length > 0) copied['set-cookie'] = setCookies;
  return copied;
}

function buildUpstreamUrl(upstream: URL, requestUrl: string): URL {
  const incoming = new URL(requestUrl, 'http://token-budget-proxy.invalid');
  const target = new URL(upstream.href);
  const exposedBasePath = upstream.pathname.replace(/\/+$/, '');
  let relativePath = incoming.pathname;
  if (
    exposedBasePath &&
    (relativePath === exposedBasePath || relativePath.startsWith(`${exposedBasePath}/`))
  ) {
    relativePath = relativePath.slice(exposedBasePath.length);
  }
  target.pathname = [exposedBasePath, relativePath.replace(/^\/+/, '')]
    .filter(Boolean)
    .join('/');
  for (const [name, value] of incoming.searchParams) {
    target.searchParams.append(name, value);
  }
  return target;
}

function writeUpstreamHead(upstreamResponse: Response, response: ServerResponse): void {
  response.writeHead(
    upstreamResponse.status,
    upstreamResponse.statusText,
    copyResponseHeaders(upstreamResponse.headers)
  );
}

export async function writeWithBackpressure(
  response: ProxyWritableResponse,
  chunk: Uint8Array
): Promise<void> {
  if (response.destroyed || response.writableEnded) {
    throw new Error('Token budget proxy downstream is closed');
  }
  if (response.write(chunk)) return;

  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      response.off('drain', onDrain);
      response.off('close', onClose);
    };
    const onDrain = (): void => {
      cleanup();
      resolve();
    };
    const onClose = (): void => {
      cleanup();
      reject(new Error('Token budget proxy downstream closed during streaming'));
    };
    response.once('drain', onDrain);
    response.once('close', onClose);
    if (response.destroyed || response.writableEnded) onClose();
  });
}

async function forwardTransparentBody(
  body: ReadableStream<Uint8Array> | null,
  response: ServerResponse
): Promise<void> {
  if (!body) {
    response.end();
    return;
  }
  const reader = body.getReader();
  let fullyRead = false;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        fullyRead = true;
        break;
      }
      await writeWithBackpressure(response, next.value);
    }
    response.end();
  } finally {
    if (!fullyRead) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function cloneUsageWithTarget(
  value: unknown,
  targetPromptTokens: number
): Record<string, unknown> | undefined {
  if (!isRecord(value) || !isNonNegativeSafeInteger(value.completion_tokens)) {
    return undefined;
  }
  const totalTokens = targetPromptTokens + value.completion_tokens;
  if (!Number.isSafeInteger(totalTokens)) return undefined;
  return {
    ...value,
    prompt_tokens: targetPromptTokens,
    total_tokens: totalTokens,
  };
}

function classifyUsageShape(
  value: unknown
): NonNullable<TokenBudgetRequestEvidence['usageShape']> {
  if (!isRecord(value)) return 'missing';
  const choices = Array.isArray(value.choices) ? value.choices : undefined;
  if (isRecord(value.usage)) {
    if (choices?.length === 0) return 'root-empty';
    if (
      choices &&
      choices.length > 0 &&
      choices.every(
        (choice) =>
          isRecord(choice) &&
          typeof choice.finish_reason === 'string' &&
          choice.finish_reason.length > 0
      )
    ) {
      return 'root-terminal';
    }
    return 'root-nonempty';
  }
  if (choices?.some((choice) => isRecord(choice) && isRecord(choice.usage))) {
    return 'choice';
  }
  return 'missing';
}

function classifyJsonUsageShape(
  body: Uint8Array
): NonNullable<TokenBudgetRequestEvidence['usageShape']> {
  try {
    return classifyUsageShape(JSON.parse(Buffer.from(body).toString('utf8')));
  } catch {
    return 'invalid';
  }
}

function rewriteJsonBody(
  body: Uint8Array,
  targetPromptTokens: number
): Buffer | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body).toString('utf8'));
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const usage = cloneUsageWithTarget(parsed.usage, targetPromptTokens);
  if (!usage) return undefined;
  return Buffer.from(JSON.stringify({ ...parsed, usage }));
}

function earliestFrameBoundary(buffer: Buffer): FrameBoundary | undefined {
  const lineEndingLength = (index: number): number => {
    if (buffer[index] === 0x0a) return 1;
    if (buffer[index] !== 0x0d) return 0;
    return buffer[index + 1] === 0x0a ? 2 : 1;
  };
  let cursor = 0;
  while (cursor < buffer.byteLength) {
    const firstLength = lineEndingLength(cursor);
    if (firstLength === 0) {
      cursor++;
      continue;
    }
    const secondStart = cursor + firstLength;
    const secondLength = lineEndingLength(secondStart);
    if (secondLength > 0) {
      return { index: cursor, length: firstLength + secondLength };
    }
    cursor = secondStart;
  }
  return undefined;
}

function extractSseData(frame: Buffer):
  | {
      data: string;
      segments: SseDataSegment[];
    }
  | undefined {
  const segments: SseDataSegment[] = [];
  const decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    decoder.decode(frame);
  } catch {
    return undefined;
  }
  let data = '';
  let lineStart = 0;
  while (lineStart <= frame.byteLength) {
    let lineEnd = lineStart;
    while (
      lineEnd < frame.byteLength &&
      frame[lineEnd] !== 0x0a &&
      frame[lineEnd] !== 0x0d
    ) {
      lineEnd++;
    }
    const line = frame.subarray(lineStart, lineEnd);
    let valueOffset: number | undefined;
    if (line.byteLength === 4 && line.toString('ascii') === 'data') {
      valueOffset = 4;
    } else if (
      line.byteLength >= 5 &&
      line[0] === 0x64 &&
      line[1] === 0x61 &&
      line[2] === 0x74 &&
      line[3] === 0x61 &&
      line[4] === 0x3a
    ) {
      valueOffset = line[5] === 0x20 ? 6 : 5;
    }
    if (valueOffset !== undefined) {
      if (segments.length > 0) data += '\n';
      let value: string;
      try {
        value = decoder.decode(line.subarray(valueOffset));
      } catch {
        return undefined;
      }
      const dataStart = data.length;
      data += value;
      segments.push({
        dataStart,
        dataEnd: data.length,
        frameStart: lineStart + valueOffset,
        value,
      });
    }
    if (lineEnd >= frame.byteLength) break;
    lineStart =
      frame[lineEnd] === 0x0d && frame[lineEnd + 1] === 0x0a
        ? lineEnd + 2
        : lineEnd + 1;
  }
  return { data, segments };
}

function skipJsonWhitespace(source: string, start: number): number {
  let index = start;
  while (index < source.length && /[\t\n\r ]/.test(source[index] ?? '')) index++;
  return index;
}

function scanJsonString(
  source: string,
  start: number
): { end: number; value: string } | undefined {
  if (source[start] !== '"') return undefined;
  let index = start + 1;
  while (index < source.length) {
    const character = source[index];
    if (character === '"') {
      const end = index + 1;
      try {
        const value: unknown = JSON.parse(source.slice(start, end));
        return typeof value === 'string' ? { end, value } : undefined;
      } catch {
        return undefined;
      }
    }
    if (character === '\\') index++;
    index++;
  }
  return undefined;
}

function scanJsonValueEnd(
  source: string,
  start: number,
  depth = 0
): number | undefined {
  if (depth > 128) return undefined;
  const index = skipJsonWhitespace(source, start);
  const character = source[index];
  if (character === '"') return scanJsonString(source, index)?.end;
  if (character === '{') return scanJsonObject(source, index, depth + 1)?.end;
  if (character === '[') {
    let cursor = skipJsonWhitespace(source, index + 1);
    if (source[cursor] === ']') return cursor + 1;
    while (cursor < source.length) {
      const valueEnd = scanJsonValueEnd(source, cursor, depth + 1);
      if (valueEnd === undefined) return undefined;
      cursor = skipJsonWhitespace(source, valueEnd);
      if (source[cursor] === ']') return cursor + 1;
      if (source[cursor] !== ',') return undefined;
      cursor = skipJsonWhitespace(source, cursor + 1);
    }
    return undefined;
  }
  const literal = /^(?:true|false|null)/.exec(source.slice(index));
  if (literal?.[0]) return index + literal[0].length;
  const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(
    source.slice(index)
  );
  return number?.[0] ? index + number[0].length : undefined;
}

function scanJsonObject(
  source: string,
  start: number,
  depth = 0
): JsonObjectSpans | undefined {
  if (depth > 128 || source[start] !== '{') return undefined;
  const properties: JsonPropertySpan[] = [];
  let cursor = skipJsonWhitespace(source, start + 1);
  if (source[cursor] === '}') return { end: cursor + 1, properties };
  while (cursor < source.length) {
    const key = scanJsonString(source, cursor);
    if (!key) return undefined;
    cursor = skipJsonWhitespace(source, key.end);
    if (source[cursor] !== ':') return undefined;
    const valueStart = skipJsonWhitespace(source, cursor + 1);
    const valueEnd = scanJsonValueEnd(source, valueStart, depth + 1);
    if (valueEnd === undefined) return undefined;
    properties.push({ key: key.value, valueStart, valueEnd });
    cursor = skipJsonWhitespace(source, valueEnd);
    if (source[cursor] === '}') return { end: cursor + 1, properties };
    if (source[cursor] !== ',') return undefined;
    cursor = skipJsonWhitespace(source, cursor + 1);
  }
  return undefined;
}

function lastProperty(
  properties: readonly JsonPropertySpan[],
  key: string
): JsonPropertySpan | undefined {
  return properties.findLast((property) => property.key === key);
}

function mapDataSpanToFrame(
  segments: readonly SseDataSegment[],
  span: JsonPropertySpan,
  value: string
): ByteReplacement | undefined {
  const segment = segments.find(
    (candidate) =>
      span.valueStart >= candidate.dataStart && span.valueEnd <= candidate.dataEnd
  );
  if (!segment) return undefined;
  const relativeStart = span.valueStart - segment.dataStart;
  const relativeEnd = span.valueEnd - segment.dataStart;
  return {
    start:
      segment.frameStart +
      Buffer.byteLength(segment.value.slice(0, relativeStart), 'utf8'),
    end:
      segment.frameStart +
      Buffer.byteLength(segment.value.slice(0, relativeEnd), 'utf8'),
    value,
  };
}

function applyByteReplacements(
  source: Buffer,
  replacements: readonly ByteReplacement[]
): Buffer {
  let result = source;
  for (const replacement of [...replacements].sort(
    (left, right) => right.start - left.start
  )) {
    result = Buffer.concat([
      result.subarray(0, replacement.start),
      Buffer.from(replacement.value),
      result.subarray(replacement.end),
    ]);
  }
  return result;
}

function rewriteSseFrame(frame: Buffer, targetPromptTokens: number): RewrittenSseFrame {
  const extracted = extractSseData(frame);
  if (!extracted) throw new TargetSseInvalidEncodingError();
  if (extracted.segments.length === 0 || extracted.data.trim() === '[DONE]') {
    return { bytes: frame, rewritten: false, usageShape: 'missing' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(extracted.data);
  } catch {
    return { bytes: frame, rewritten: false, usageShape: 'invalid' };
  }
  const usageShape = classifyUsageShape(parsed);
  if (
    !isRecord(parsed) ||
    !Array.isArray(parsed.choices) ||
    (usageShape !== 'root-empty' && usageShape !== 'root-terminal') ||
    !isRecord(parsed.usage) ||
    !isNonNegativeSafeInteger(parsed.usage.prompt_tokens) ||
    !isNonNegativeSafeInteger(parsed.usage.completion_tokens) ||
    !isNonNegativeSafeInteger(parsed.usage.total_tokens)
  ) {
    return { bytes: frame, rewritten: false, usageShape };
  }
  const totalTokens = targetPromptTokens + parsed.usage.completion_tokens;
  if (!Number.isSafeInteger(totalTokens)) {
    return { bytes: frame, rewritten: false, usageShape };
  }

  const rootStart = skipJsonWhitespace(extracted.data, 0);
  const root = scanJsonObject(extracted.data, rootStart);
  const usageProperty = root ? lastProperty(root.properties, 'usage') : undefined;
  const usage = usageProperty
    ? scanJsonObject(extracted.data, usageProperty.valueStart)
    : undefined;
  const promptProperty = usage
    ? lastProperty(usage.properties, 'prompt_tokens')
    : undefined;
  const totalProperty = usage
    ? lastProperty(usage.properties, 'total_tokens')
    : undefined;
  if (!promptProperty || !totalProperty) {
    return { bytes: frame, rewritten: false, usageShape };
  }
  if (
    !/^(?:0|[1-9]\d*)$/.test(
      extracted.data.slice(promptProperty.valueStart, promptProperty.valueEnd)
    ) ||
    !/^(?:0|[1-9]\d*)$/.test(
      extracted.data.slice(totalProperty.valueStart, totalProperty.valueEnd)
    )
  ) {
    return { bytes: frame, rewritten: false, usageShape };
  }

  const promptReplacement = mapDataSpanToFrame(
    extracted.segments,
    promptProperty,
    String(targetPromptTokens)
  );
  const totalReplacement = mapDataSpanToFrame(
    extracted.segments,
    totalProperty,
    String(totalTokens)
  );
  if (!promptReplacement || !totalReplacement) {
    return { bytes: frame, rewritten: false, usageShape };
  }
  return {
    bytes: applyByteReplacements(frame, [promptReplacement, totalReplacement]),
    rewritten: true,
    usageShape,
  };
}

function mergeUsageShape(
  current: NonNullable<TokenBudgetRequestEvidence['usageShape']>,
  next: NonNullable<TokenBudgetRequestEvidence['usageShape']>
): NonNullable<TokenBudgetRequestEvidence['usageShape']> {
  const rank = {
    missing: 0,
    invalid: 1,
    choice: 2,
    'root-nonempty': 3,
    'root-terminal': 4,
    'root-empty': 5,
  } as const;
  return rank[next] > rank[current] ? next : current;
}

async function forwardRewrittenSse(
  body: ReadableStream<Uint8Array> | null,
  response: ServerResponse,
  targetPromptTokens: number,
  onValidated: () => void,
  onUsageShape: (
    usageShape: NonNullable<TokenBudgetRequestEvidence['usageShape']>
  ) => void
): Promise<boolean> {
  if (!body) return false;
  const reader = body.getReader();
  let buffered = Buffer.alloc(0);
  let pendingFrames: Buffer[] = [];
  let pendingBytes = 0;
  let usageRewritten = false;
  let fullyRead = false;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        fullyRead = true;
        break;
      }
      if (usageRewritten) {
        await writeWithBackpressure(response, next.value);
        continue;
      }
      buffered = Buffer.concat([buffered, Buffer.from(next.value)]);
      if (pendingBytes + buffered.byteLength > MAX_TARGET_SSE_VALIDATION_BYTES) {
        throw new TargetSseValidationLimitError();
      }
      while (true) {
        const boundary = earliestFrameBoundary(buffered);
        if (!boundary) break;
        const frame = buffered.subarray(0, boundary.index);
        const delimiter = buffered.subarray(
          boundary.index,
          boundary.index + boundary.length
        );
        buffered = buffered.subarray(boundary.index + boundary.length);
        let rewritten: RewrittenSseFrame;
        try {
          rewritten = rewriteSseFrame(frame, targetPromptTokens);
        } catch (error) {
          onUsageShape('invalid');
          throw error;
        }
        onUsageShape(rewritten.usageShape);
        const completeFrame = Buffer.concat([rewritten.bytes, delimiter]);
        pendingFrames.push(completeFrame);
        pendingBytes += completeFrame.byteLength;
        if (pendingBytes + buffered.byteLength > MAX_TARGET_SSE_VALIDATION_BYTES) {
          throw new TargetSseValidationLimitError();
        }
        if (!rewritten.rewritten) continue;

        onValidated();
        for (const pending of pendingFrames) {
          await writeWithBackpressure(response, pending);
        }
        pendingFrames = [];
        pendingBytes = 0;
        usageRewritten = true;
        if (buffered.byteLength > 0) {
          await writeWithBackpressure(response, buffered);
          buffered = Buffer.alloc(0);
        }
        break;
      }
    }
    if (usageRewritten && buffered.byteLength > 0) {
      await writeWithBackpressure(response, buffered);
    }
    if (usageRewritten) response.end();
    return usageRewritten;
  } finally {
    if (!fullyRead) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function sendBoundedError(
  response: ServerResponse,
  status: number,
  message: string
): void {
  if (response.destroyed || response.writableEnded) return;
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(
    JSON.stringify({ error: { message, type: 'token_budget_proxy_error' } })
  );
}

export async function startTokenBudgetHandoffProxy(
  upstreamBaseURL: string,
  options: {
    handoffPromptTokens: number;
    compactionPromptTokens: number;
    markerTag: string;
  }
): Promise<{
  baseURL: string;
  evidence(): TokenBudgetProxyEvidence;
  close(): Promise<void>;
}> {
  let upstream: URL;
  try {
    upstream = new URL(upstreamBaseURL);
  } catch {
    throw new Error('Token budget proxy requires a valid HTTP(S) upstream URL');
  }
  if (upstream.protocol !== 'http:' && upstream.protocol !== 'https:') {
    throw new Error('Token budget proxy upstream must use HTTP or HTTPS');
  }
  if (
    !isPositiveSafeInteger(options.handoffPromptTokens) ||
    !isPositiveSafeInteger(options.compactionPromptTokens)
  ) {
    throw new Error('Token budget proxy targets must be positive safe integers');
  }
  if (typeof options.markerTag !== 'string' || options.markerTag.trim().length === 0) {
    throw new Error('Token budget proxy markerTag must be nonempty');
  }

  const recordedRequests: TokenBudgetRequestEvidence[] = [];
  const controllers = new Set<AbortController>();
  const activeHandlers = new Set<Promise<void>>();
  let requestOrdinal = 0;
  let taskOrdinal = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  let closing = false;
  let closePromise: Promise<void> | undefined;

  const server = createServer((request, response) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    let handler: Promise<void>;
    handler = (async () => {
      const requestResult = await readJsonRequest(request);
      const facts = inspectParsedRequest(
        requestResult.parsed,
        requestResult.body,
        requestResult.bodySha256,
        options.markerTag
      );
      const ordinal = ++requestOrdinal;
      const currentTaskOrdinal = facts.kind === 'task' ? ++taskOrdinal : undefined;
      const targetPromptTokens =
        currentTaskOrdinal === 1
          ? options.handoffPromptTokens
          : currentTaskOrdinal === 2
            ? options.compactionPromptTokens
            : undefined;
      const requestEvidence: TokenBudgetRequestEvidence = {
        ordinal,
        ...facts,
        ...(targetPromptTokens === undefined ? {} : { targetPromptTokens }),
        usageRewritten: false,
      };
      recordedRequests.push(requestEvidence);

      if (closing || response.destroyed) {
        if (!response.destroyed) response.destroy();
        return;
      }
      const controller = new AbortController();
      controllers.add(controller);
      let responseComplete = false;
      const abortUpstream = (): void => {
        if (!responseComplete && !response.writableEnded) controller.abort();
      };
      request.once('aborted', abortUpstream);
      response.once('close', abortUpstream);
      try {
        const method = request.method ?? 'POST';
        const upstreamResponse = await fetch(
          buildUpstreamUrl(upstream, request.url ?? '/'),
          {
            method,
            headers: copyRequestHeaders(request),
            body:
              method === 'GET' || method === 'HEAD' || requestResult.body.length === 0
                ? undefined
                : Uint8Array.from(requestResult.body),
            redirect: 'manual',
            signal: controller.signal,
          }
        );
        requestEvidence.upstreamStatus = upstreamResponse.status;
        const contentType = upstreamResponse.headers.get('content-type') ?? '';
        requestEvidence.responseKind = contentType
          .toLowerCase()
          .includes('text/event-stream')
          ? 'sse'
          : contentType.toLowerCase().includes('json')
            ? 'json'
            : 'other';
        if (closing || response.destroyed) {
          await upstreamResponse.body?.cancel().catch(() => undefined);
          return;
        }

        if (targetPromptTokens === undefined) {
          writeUpstreamHead(upstreamResponse, response);
          await forwardTransparentBody(upstreamResponse.body, response);
          responseComplete = true;
          return;
        }

        if (contentType.toLowerCase().includes('text/event-stream')) {
          requestEvidence.usageShape = 'missing';
          const rewritten = await forwardRewrittenSse(
            upstreamResponse.body,
            response,
            targetPromptTokens,
            () => writeUpstreamHead(upstreamResponse, response),
            (usageShape) => {
              requestEvidence.usageShape = mergeUsageShape(
                requestEvidence.usageShape ?? 'missing',
                usageShape
              );
            }
          );
          requestEvidence.usageRewritten = rewritten;
          if (!rewritten) throw new TargetUsageMissingError();
          responseComplete = true;
          return;
        }

        const upstreamBody = new Uint8Array(await upstreamResponse.arrayBuffer());
        requestEvidence.usageShape = classifyJsonUsageShape(upstreamBody);
        const rewritten = rewriteJsonBody(upstreamBody, targetPromptTokens);
        if (!rewritten) throw new TargetUsageMissingError();
        writeUpstreamHead(upstreamResponse, response);
        response.end(rewritten);
        requestEvidence.usageRewritten = true;
        responseComplete = true;
      } finally {
        responseComplete = true;
        controllers.delete(controller);
        request.off('aborted', abortUpstream);
        response.off('close', abortUpstream);
      }
    })()
      .catch((error: unknown) => {
        if (error instanceof RequestBodyTooLargeError) {
          sendBoundedError(response, 413, 'Provider request body exceeds 16 MiB');
        } else if (error instanceof InvalidRequestJsonError) {
          sendBoundedError(response, 400, 'Provider request body must be valid JSON');
        } else if (error instanceof TargetUsageMissingError) {
          sendBoundedError(
            response,
            502,
            'Targeted Provider response omitted valid usage'
          );
        } else if (error instanceof TargetSseValidationLimitError) {
          sendBoundedError(
            response,
            502,
            'Targeted Provider SSE exceeded validation limit'
          );
        } else if (error instanceof TargetSseInvalidEncodingError) {
          sendBoundedError(response, 502, 'Targeted Provider SSE was not valid UTF-8');
        } else {
          sendBoundedError(response, 502, 'Provider proxy forwarding failed');
        }
      })
      .finally(() => {
        activeHandlers.delete(handler);
        inFlight = Math.max(0, inFlight - 1);
      });
    activeHandlers.add(handler);
    void handler;
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error('Token budget proxy failed to bind a loopback TCP address');
  }
  const exposedPath = upstream.pathname.replace(/\/+$/, '');

  return {
    baseURL: `http://127.0.0.1:${(address as AddressInfo).port}${exposedPath}`,
    evidence: () => ({
      requests: recordedRequests.map((request) => ({ ...request })),
      maxInFlight,
    }),
    close: () => {
      if (closePromise) return closePromise;
      closing = true;
      for (const controller of controllers) controller.abort();
      const serverClosed = new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      server.closeAllConnections();
      closePromise = (async () => {
        await serverClosed;
        while (activeHandlers.size > 0) {
          await Promise.allSettled([...activeHandlers]);
        }
      })();
      return closePromise;
    },
  };
}
