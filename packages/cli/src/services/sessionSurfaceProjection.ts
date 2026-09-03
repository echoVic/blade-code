import { createHash } from 'node:crypto';
import type { SessionSurfaceMessage } from '../api/sessionSurfaceSchemas.js';
import type { AcpRemoteWorkspaceDescriptorV1, SessionEvent } from '../context/types.js';
import type { Message } from './ChatServiceInterface.js';
import { isClientVisibleMessage } from './clientMessageVisibility.js';
import { materializeSessionEvents } from './sessionRewind.js';
import {
  renderUserShellCommandForDisplay,
  userShellCommandRecordFromMetadata,
} from './UserShellCommandService.js';

const DEFAULT_MAX_CONTENT_BYTES = 256 * 1024;
const DIGEST_DOMAIN = 'session-surface-message\0';
const PRIVATE_PATH_PLACEHOLDER = '[private state path]';
const TRUNCATION_MARKER = '[content truncated]';
const TRUNCATION_MARKER_WITH_NEWLINE = `\n${TRUNCATION_MARKER}`;
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const C1_OSC = String.fromCharCode(0x9d);
const C1_ST = String.fromCharCode(0x9c);
const C1_CSI = String.fromCharCode(0x9b);
const OSC_SEQUENCE = new RegExp(
  `(?:${escapeForRegExp(ESC)}\\]|${escapeForRegExp(C1_OSC)})[\\s\\S]*?(?:${escapeForRegExp(
    BEL
  )}|${escapeForRegExp(ESC)}\\\\|${escapeForRegExp(C1_ST)})`,
  'g'
);
const CSI_SEQUENCE = new RegExp(
  `(?:${escapeForRegExp(ESC)}\\[|${escapeForRegExp(C1_CSI)})[0-?]*[ -/]*[@-~]`,
  'g'
);

type MessageCreatedEvent = Extract<SessionEvent, { type: 'message_created' }>;
type PartEvent = Extract<
  SessionEvent,
  { type: 'part_created' } | { type: 'part_updated' }
>;

export interface SessionSurfaceProjectionOptions {
  privateRoots: readonly string[];
  caseInsensitivePrivateRoots?: readonly string[];
  privateValues?: readonly string[];
  bladeStorageRoots?: readonly string[];
  maxContentBytes?: number;
}

export type SessionSurfaceRedactionOptions = Pick<
  SessionSurfaceProjectionOptions,
  'privateRoots' | 'caseInsensitivePrivateRoots' | 'privateValues' | 'bladeStorageRoots'
>;

export function remoteSessionSurfaceRedactionOptions(
  hostStateRoot: string,
  descriptor: AcpRemoteWorkspaceDescriptorV1
): SessionSurfaceRedactionOptions {
  const options: SessionSurfaceRedactionOptions = {
    privateRoots: [hostStateRoot],
    privateValues: [descriptor.exactIdentity, descriptor.collisionIdentity],
  };
  if (descriptor.style === 'win32') {
    options.caseInsensitivePrivateRoots = [descriptor.wirePath];
  } else {
    options.privateRoots = [hostStateRoot, descriptor.wirePath];
  }
  return options;
}

interface ProjectedPart {
  partId: string;
  type: 'text' | 'image';
  content: string;
}

interface ProjectedMessageState {
  event: MessageCreatedEvent;
  orderedPartIds: string[];
  partsById: Map<string, ProjectedPart>;
}

export class SessionSurfaceProjectionError extends Error {
  readonly code = 'session_surface_state_invalid';

  constructor() {
    super('session surface projection state is invalid');
    this.name = 'SessionSurfaceProjectionError';
  }
}

export function projectSessionSurfaceMessages(
  events: readonly SessionEvent[],
  options: SessionSurfaceProjectionOptions
): SessionSurfaceMessage[] {
  const maxContentBytes = resolveMaxContentBytes(options.maxContentBytes);
  const privateRoots = resolvePrivateRoots(
    options.privateRoots,
    options.bladeStorageRoots ?? []
  );
  const caseInsensitivePrivateRoots = resolvePrivateRoots(
    options.caseInsensitivePrivateRoots ?? [],
    []
  );
  const privateValues = resolvePrivateValues(options.privateValues ?? []);
  const materialized = materializeSessionEvents(events);
  const messages = new Map<string, ProjectedMessageState>();

  for (const event of materialized) {
    assertCommittedSequence(event.seq);

    if (event.type === 'message_created') {
      messages.set(event.data.messageId, {
        event,
        orderedPartIds: [],
        partsById: new Map<string, ProjectedPart>(),
      });
      continue;
    }

    if (event.type !== 'part_created' && event.type !== 'part_updated') {
      continue;
    }

    const state = messages.get(event.data.messageId);
    if (!state) continue;
    applyPartEvent(state, event);
  }

  const projected: SessionSurfaceMessage[] = [];
  for (const state of messages.values()) {
    const surfaceMessage = projectMessageState(
      state,
      privateRoots,
      caseInsensitivePrivateRoots,
      privateValues,
      maxContentBytes
    );
    if (surfaceMessage) {
      projected.push(surfaceMessage);
    }
  }

  return projected;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function projectMessageState(
  state: ProjectedMessageState,
  privateRoots: readonly string[],
  caseInsensitivePrivateRoots: readonly string[],
  privateValues: readonly string[],
  maxContentBytes: number
): SessionSurfaceMessage | undefined {
  const role = state.event.data.role;
  if (role !== 'user' && role !== 'assistant') {
    return undefined;
  }

  const rawContent = projectRawContent(state);
  const normalizedTerminalContent = stripUnsafeTerminalContent(rawContent);
  const message: Message = {
    role,
    content: normalizedTerminalContent,
    ...(state.event.data.metadata !== undefined
      ? { metadata: state.event.data.metadata }
      : {}),
  };
  if (!isClientVisibleMessage(message)) {
    return undefined;
  }

  const timestamp = validateCanonicalIsoInstant(state.event.data.createdAt);
  const redacted = redactPrivateValues(
    redactPrivateRoots(
      redactPrivateRoots(normalizedTerminalContent, caseInsensitivePrivateRoots, true),
      privateRoots
    ),
    privateValues
  );
  const normalized = redacted.trim();
  if (!normalized) {
    return undefined;
  }

  const truncated = truncateUtf8(normalized, maxContentBytes);
  const id = buildSurfaceMessageId(state.event);
  if (truncated.truncated) {
    return {
      id,
      role,
      content: truncated.content,
      timestamp,
      truncated: true,
    };
  }
  return { id, role, content: truncated.content, timestamp };
}

export function redactSessionSurfaceText(
  value: string,
  options: SessionSurfaceRedactionOptions
): string {
  return redactPrivateValues(
    redactPrivateRoots(
      redactPrivateRoots(
        stripUnsafeTerminalContent(value),
        resolvePrivateRoots(options.caseInsensitivePrivateRoots ?? [], []),
        true
      ),
      resolvePrivateRoots(options.privateRoots, options.bladeStorageRoots ?? [])
    ),
    resolvePrivateValues(options.privateValues ?? [])
  );
}

function projectRawContent(state: ProjectedMessageState): string {
  const shellRecord = userShellCommandRecordFromMetadata(state.event.data.metadata);
  if (shellRecord) {
    return renderUserShellCommandForDisplay(shellRecord);
  }

  return state.orderedPartIds
    .map((partId) => state.partsById.get(partId))
    .flatMap((part) => (part ? [part.content] : []))
    .join('');
}

function applyPartEvent(state: ProjectedMessageState, event: PartEvent): void {
  if (event.data.partType !== 'text' && event.data.partType !== 'image') {
    return;
  }

  const nextPart: ProjectedPart =
    event.data.partType === 'text'
      ? {
          partId: event.data.partId,
          type: 'text',
          content: readTextPayload(event.data.payload),
        }
      : {
          partId: event.data.partId,
          type: 'image',
          content: '[Image]',
        };

  if (!state.partsById.has(event.data.partId)) {
    state.orderedPartIds.push(event.data.partId);
  }
  state.partsById.set(event.data.partId, nextPart);
}

function readTextPayload(payload: unknown): string {
  if (!isRecord(payload)) {
    return '';
  }
  const text = payload.text;
  return typeof text === 'string' ? text : '';
}

function buildSurfaceMessageId(event: MessageCreatedEvent): string {
  const seq = assertCommittedSequence(event.seq);
  return createSessionSurfaceMessageId(seq, event.data.messageId);
}

export function createSessionSurfaceMessageId(
  sequence: number,
  messageId: string
): string {
  const seq = assertCommittedSequence(sequence);
  const digest = createHash('sha256')
    .update(DIGEST_DOMAIN)
    .update(messageId)
    .digest('hex')
    .slice(0, 16);
  return `surface-message:${seq}:${digest}`;
}

function validateCanonicalIsoInstant(value: string): string {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(
      value
    );
  if (!match) {
    throw new SessionSurfaceProjectionError();
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offset = match[8];
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const validOffset =
    offset === 'Z' ||
    (offset !== undefined &&
      Number(offset.slice(1, 3)) <= 23 &&
      Number(offset.slice(4, 6)) <= 59);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    !validOffset ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new SessionSurfaceProjectionError();
  }

  return value;
}

function resolvePrivateRoots(
  privateRoots: readonly string[],
  bladeStorageRoots: readonly string[]
): string[] {
  return [...new Set([...privateRoots, ...bladeStorageRoots].filter(Boolean))].sort(
    (left, right) => right.length - left.length
  );
}

function resolvePrivateValues(privateValues: readonly string[]): string[] {
  return [...new Set(privateValues.filter(Boolean))].sort(
    (left, right) => right.length - left.length
  );
}

function redactPrivateValues(value: string, privateValues: readonly string[]): string {
  let result = value;
  for (const privateValue of privateValues) {
    result = result.split(privateValue).join(PRIVATE_PATH_PLACEHOLDER);
  }
  return result;
}

function redactPrivateRoots(
  value: string,
  roots: readonly string[],
  caseInsensitive = false
): string {
  let result = value;
  for (const root of roots) {
    result = redactPrivateRoot(result, root, caseInsensitive);
  }
  return result;
}

function redactPrivateRoot(
  value: string,
  root: string,
  caseInsensitive: boolean
): string {
  if (!root) return value;

  let cursor = 0;
  let output = '';
  const matcher = caseInsensitive
    ? new RegExp(
        root
          .split(/[\\/]+/)
          .map((segment) => escapeForRegExp(segment))
          .join('[\\\\/]+'),
        'i'
      )
    : undefined;

  while (cursor < value.length) {
    const insensitiveMatch = matcher?.exec(value.slice(cursor));
    const match = matcher
      ? insensitiveMatch
        ? cursor + insensitiveMatch.index
        : -1
      : value.indexOf(root, cursor);
    if (match < 0) {
      output += value.slice(cursor);
      break;
    }

    output += value.slice(cursor, match);
    const matchedLength = insensitiveMatch?.[0].length ?? root.length;
    const end = matchPrivatePathEnd(value, match, matchedLength);
    if (end === match) {
      output += value[match];
      cursor = match + 1;
      continue;
    }

    output += PRIVATE_PATH_PLACEHOLDER;
    cursor = end;
  }

  return output;
}

function matchPrivatePathEnd(value: string, start: number, rootLength: number): number {
  const afterRoot = start + rootLength;
  if (afterRoot >= value.length) {
    return afterRoot;
  }

  const next = value[afterRoot];
  if (next === undefined) {
    return afterRoot;
  }
  if (!isPathSeparator(next) && !isPathTerminator(next)) {
    return start;
  }

  let end = afterRoot;
  while (end < value.length) {
    const candidate = value[end];
    if (candidate === undefined || isPathTerminator(candidate)) {
      break;
    }
    end += 1;
  }
  return end;
}

function isPathSeparator(value: string): boolean {
  return value === '/' || value === '\\';
}

function isPathTerminator(value: string): boolean {
  return (
    value === ' ' ||
    value === '\t' ||
    value === '\n' ||
    value === '\r' ||
    value === '"' ||
    value === "'" ||
    value === '`' ||
    value === '<' ||
    value === '>' ||
    value === '(' ||
    value === ')' ||
    value === '[' ||
    value === ']' ||
    value === '{' ||
    value === '}' ||
    value === ',' ||
    value === ';' ||
    value === ':' ||
    value === '!' ||
    value === '?'
  );
}

function stripUnsafeTerminalContent(value: string): string {
  const normalizedNewlines = value.replace(/\r\n?/g, '\n');
  const withoutEscapes = normalizedNewlines
    .replace(OSC_SEQUENCE, '')
    .replace(CSI_SEQUENCE, '')
    .split(`${ESC}\\`)
    .join('');
  return [...withoutEscapes]
    .filter((character) => {
      const code = character.charCodeAt(0);
      return !(
        code === 0 ||
        (code >= 1 && code <= 8) ||
        code === 11 ||
        code === 12 ||
        (code >= 14 && code <= 31) ||
        (code >= 127 && code <= 159)
      );
    })
    .join('');
}

function truncateUtf8(
  value: string,
  maxContentBytes: number
): { content: string; truncated: boolean } {
  if (Buffer.byteLength(value, 'utf8') <= maxContentBytes) {
    return { content: value, truncated: false };
  }

  const suffix = truncateMarker(maxContentBytes);
  const suffixBytes = Buffer.byteLength(suffix, 'utf8');
  const contentBudget = Math.max(0, maxContentBytes - suffixBytes);
  const prefix = sliceUtf8(value, contentBudget);
  return {
    content: `${prefix}${suffix}`,
    truncated: true,
  };
}

function sliceUtf8(value: string, maximumBytes: number): string {
  if (maximumBytes <= 0) {
    return '';
  }
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= maximumBytes) {
    return value;
  }
  let result = bytes.subarray(0, maximumBytes).toString('utf8');
  while (Buffer.byteLength(result, 'utf8') > maximumBytes) {
    result = result.slice(0, -1);
  }
  return result.replace(/\uFFFD$/, '');
}

function truncateMarker(maximumBytes: number): string {
  const newlineMarkerBytes = Buffer.byteLength(TRUNCATION_MARKER_WITH_NEWLINE, 'utf8');
  if (maximumBytes >= newlineMarkerBytes) {
    return TRUNCATION_MARKER_WITH_NEWLINE;
  }

  const plainMarkerBytes = Buffer.byteLength(TRUNCATION_MARKER, 'utf8');
  if (maximumBytes >= plainMarkerBytes) {
    return TRUNCATION_MARKER;
  }

  return sliceUtf8(TRUNCATION_MARKER, maximumBytes);
}

function resolveMaxContentBytes(value: number | undefined): number {
  const maxContentBytes = value ?? DEFAULT_MAX_CONTENT_BYTES;
  if (!Number.isSafeInteger(maxContentBytes) || maxContentBytes <= 0) {
    throw new SessionSurfaceProjectionError();
  }
  return maxContentBytes;
}

function assertCommittedSequence(value: number | undefined): number {
  const seq = value;
  if (seq === undefined || !Number.isSafeInteger(seq) || seq <= 0) {
    throw new SessionSurfaceProjectionError();
  }
  return seq;
}
