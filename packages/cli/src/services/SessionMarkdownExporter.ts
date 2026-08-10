import { createHash } from 'node:crypto';
import path from 'node:path';
import type {
  CommunicationStyleSelection,
  ReasoningEffortSelection,
  ResponseVerbositySelection,
  ServiceTierSelection,
} from '../config/types.js';
import type { SessionEvent } from '../context/types.js';
import type { JsonValue } from '../store/types.js';
import { materializeSessionEvents } from './sessionRewind.js';

export const MAX_SESSION_MARKDOWN_EXPORT_BYTES = 16 * 1024 * 1024;
export const MAX_SESSION_MARKDOWN_ACTIVITY_BYTES = 64 * 1024;
export const MAX_ACP_INLINE_SESSION_EXPORT_BYTES = 1024 * 1024;

const MAX_ACTIVITY_DEPTH = 8;
const MAX_ACTIVITY_ENTRIES = 200;
const SENSITIVE_KEY =
  /(?:^|[_-])(?:api[_-]?key|authorization|bearer|cookie|credential|password|passwd|private[_-]?key|refresh[_-]?token|secret|session[_-]?token|token)(?:$|[_-])/i;
const ABSOLUTE_PATH = /(?<![:/A-Za-z0-9._-])\/[^\s"'`<>]+/g;
const WINDOWS_ABSOLUTE_PATH = /(?<![A-Za-z0-9._-])[A-Za-z]:[\\/][^\s"'`<>]+/g;
const ANSI_ESCAPE = new RegExp(
  '\\u001b(?:\\[[0-?]*[ -/]*[@-~]|\\][^\\u0007]*(?:\\u0007|\\u001b\\\\))',
  'g'
);
const PRIVATE_KEY_BLOCK =
  /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g;

export interface SessionMarkdownMetadata {
  sessionId: string;
  projectPath: string;
  title?: string;
  selectedModelId?: string;
  taskModelId?: string;
  taskSourceProjectPath?: string;
  reasoningEffort?: ReasoningEffortSelection;
  serviceTier?: ServiceTierSelection;
  responseVerbosity?: ResponseVerbositySelection;
  communicationStyle?: CommunicationStyleSelection;
  communicationStyleDigest?: string;
  projectInstructionsDigest?: string;
  archivedAt?: string;
  firstMessageTime: string;
  lastMessageTime: string;
}

export interface SessionMarkdownExportOptions {
  includeReasoning?: boolean;
}

export interface SessionMarkdownExport {
  filename: string;
  markdown: string;
  contentSha256: string;
  contentBytes: number;
  messageCount: number;
  activityCount: number;
  reasoningIncluded: boolean;
  reasoningCount: number;
  redactionCount: number;
}

interface RedactionState {
  count: number;
}

interface ProjectedPart {
  order: number;
  event: Extract<SessionEvent, { type: 'part_created' | 'part_updated' }>;
}

interface ProjectedMessage {
  order: number;
  role: string;
  parts: ProjectedPart[];
}

function redact(state: RedactionState, replacement: string): string {
  state.count += 1;
  return replacement;
}

function isSensitiveKey(value: string): boolean {
  return SENSITIVE_KEY.test(
    value.replace(/[A-Z]/g, (character) => `_${character.toLowerCase()}`)
  );
}

function stripUnsafeUnicode(value: string): string {
  return [...value]
    .filter((character) => {
      if (character === '\n' || character === '\r' || character === '\t') {
        return true;
      }
      const codePoint = character.codePointAt(0) ?? 0;
      if (codePoint < 0x20 || codePoint === 0x7f) return false;
      if (codePoint >= 0xe000 && codePoint <= 0xf8ff) return false;
      if (codePoint >= 0xf0000 && codePoint <= 0xffffd) return false;
      if (codePoint >= 0x100000 && codePoint <= 0x10fffd) return false;
      if (codePoint >= 0xe0000 && codePoint <= 0xe007f) return false;
      return !/[\p{Cf}\p{Cn}]/u.test(character);
    })
    .join('');
}

function sanitizeCredentialText(value: string, state: RedactionState): string {
  let result = value.normalize('NFKC');
  const withoutAnsi = result.replace(ANSI_ESCAPE, '');
  if (withoutAnsi !== result) state.count += 1;
  result = withoutAnsi;
  result = result.replace(PRIVATE_KEY_BLOCK, () =>
    redact(state, '[redacted-private-key]')
  );
  result = result
    .replace(/\bBearer\s+[^\s"'`]+/gi, () => redact(state, 'Bearer [redacted]'))
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, () => redact(state, '[redacted-key]'))
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, () => redact(state, '[redacted-aws-key]'))
    .replace(
      /\b(api[_-]?key|access[_-]?token|authorization|cookie|password|passwd|refresh[_-]?token|secret|session[_-]?token)\b(\s*[:=]\s*)([^\s,;]+)/gi,
      (_match, key: string, separator: string) =>
        `${key}${separator}${redact(state, '[redacted]')}`
    );
  const withoutUnsafeUnicode = stripUnsafeUnicode(result);
  if (withoutUnsafeUnicode !== result) state.count += 1;
  return withoutUnsafeUnicode.replace(/\r\n?/g, '\n');
}

function sanitizeToolString(
  value: string,
  workspaceRoot: string,
  state: RedactionState
): string {
  if (/^data:[^;,]+;base64,/i.test(value)) {
    return redact(state, '[binary omitted]');
  }
  let result = sanitizeCredentialText(value, state);
  const normalizedWorkspace = path.resolve(workspaceRoot);
  for (const workspace of [
    normalizedWorkspace,
    normalizedWorkspace.startsWith('/private/')
      ? normalizedWorkspace.slice('/private'.length)
      : `/private${normalizedWorkspace}`,
  ]) {
    result = result.replaceAll(workspace, '.');
  }
  result = result.replace(ABSOLUTE_PATH, (candidate) =>
    candidate.startsWith('./') ? candidate : redact(state, '[host-path]')
  );
  result = result.replace(WINDOWS_ABSOLUTE_PATH, () => redact(state, '[host-path]'));
  result = result.replace(/\bhttps?:\/\/[^\s"'`]+/gi, (candidate) => {
    try {
      const url = new URL(candidate);
      if (url.username || url.password || url.search || url.hash) {
        state.count += 1;
      }
      url.username = '';
      url.password = '';
      url.search = '';
      url.hash = '';
      return url.toString();
    } catch {
      return redact(state, '[redacted-url]');
    }
  });
  return result;
}

function sanitizeActivityValue(
  value: unknown,
  workspaceRoot: string,
  state: RedactionState,
  depth = 0,
  key?: string
): JsonValue {
  if (key && isSensitiveKey(key)) {
    return redact(state, '[redacted]');
  }
  if (depth >= MAX_ACTIVITY_DEPTH) {
    return redact(state, '[depth limit]');
  }
  if (typeof value === 'string') {
    return sanitizeToolString(value, workspaceRoot, state);
  }
  if (
    value === null ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return value as JsonValue;
  }
  if (Array.isArray(value)) {
    const entries = value
      .slice(0, MAX_ACTIVITY_ENTRIES)
      .map((entry) => sanitizeActivityValue(entry, workspaceRoot, state, depth + 1));
    if (value.length > entries.length) {
      entries.push(redact(state, `[${value.length - entries.length} items omitted]`));
    }
    return entries;
  }
  if (value && typeof value === 'object') {
    const output: Record<string, JsonValue> = {};
    const entries = Object.entries(value as Record<string, unknown>);
    for (const [entryKey, entryValue] of entries.slice(0, MAX_ACTIVITY_ENTRIES)) {
      output[sanitizeCredentialText(entryKey, state)] = sanitizeActivityValue(
        entryValue,
        workspaceRoot,
        state,
        depth + 1,
        entryKey
      );
    }
    if (entries.length > MAX_ACTIVITY_ENTRIES) {
      output['[entries omitted]'] = entries.length - MAX_ACTIVITY_ENTRIES;
    }
    return output;
  }
  return String(value);
}

function sliceUtf8(value: string, maximumBytes: number): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= maximumBytes) return value;
  let result = bytes.subarray(0, maximumBytes).toString('utf8');
  while (Buffer.byteLength(result, 'utf8') > maximumBytes) {
    result = result.slice(0, -1);
  }
  return result;
}

function stringifyActivity(
  value: unknown,
  workspaceRoot: string,
  state: RedactionState
): string {
  const serialized = JSON.stringify(
    sanitizeActivityValue(value, workspaceRoot, state),
    null,
    2
  );
  if (Buffer.byteLength(serialized, 'utf8') <= MAX_SESSION_MARKDOWN_ACTIVITY_BYTES) {
    return serialized;
  }
  state.count += 1;
  const suffix = '\n... [activity truncated]';
  return (
    sliceUtf8(
      serialized,
      MAX_SESSION_MARKDOWN_ACTIVITY_BYTES - Buffer.byteLength(suffix)
    ) + suffix
  );
}

function markdownFence(value: string, language = ''): string {
  const longestRun = Math.max(
    2,
    ...[...value.matchAll(/`+/g)].map((match) => match[0].length)
  );
  const fence = '`'.repeat(longestRun + 1);
  return `${fence}${language}\n${value}\n${fence}`;
}

function inline(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function projectMessages(events: readonly SessionEvent[]): ProjectedMessage[] {
  const messages = new Map<string, ProjectedMessage>();
  const orphanMessages = new Map<string, ProjectedMessage>();
  const parts = new Map<string, ProjectedPart>();
  let order = 0;
  for (const event of materializeSessionEvents(events)) {
    if (event.type === 'message_created') {
      const orphan = orphanMessages.get(event.data.messageId);
      if (orphan) {
        orphan.role = event.data.role;
        messages.set(event.data.messageId, orphan);
        orphanMessages.delete(event.data.messageId);
      } else if (!messages.has(event.data.messageId)) {
        messages.set(event.data.messageId, {
          order: order++,
          role: event.data.role,
          parts: [],
        });
      }
      continue;
    }
    if (event.type !== 'part_created' && event.type !== 'part_updated') continue;
    let message =
      messages.get(event.data.messageId) ?? orphanMessages.get(event.data.messageId);
    if (!message) {
      message = {
        order: order++,
        role: 'activity',
        parts: [],
      };
      orphanMessages.set(event.data.messageId, message);
    }
    const key = `${event.data.messageId}\0${event.data.partType}\0${event.data.partId}`;
    const existing = parts.get(key);
    if (existing) {
      existing.event = event;
      continue;
    }
    const projected = { order: order++, event };
    parts.set(key, projected);
    message.parts.push(projected);
  }
  return [...messages.values(), ...orphanMessages.values()].sort(
    (left, right) => left.order - right.order
  );
}

function renderActivity(
  heading: string,
  value: unknown,
  metadata: SessionMarkdownMetadata,
  state: RedactionState
): string {
  return `## Activity: ${heading}\n\n${markdownFence(
    stringifyActivity(value, metadata.projectPath, state),
    'json'
  )}`;
}

export function renderSessionMarkdown(
  events: readonly SessionEvent[],
  metadata: SessionMarkdownMetadata,
  options: SessionMarkdownExportOptions = {}
): SessionMarkdownExport {
  const state: RedactionState = { count: 0 };
  const includeReasoning = options.includeReasoning === true;
  const sections: string[] = [];
  let messageCount = 0;
  let activityCount = 0;
  let reasoningCount = 0;

  for (const message of projectMessages(events)) {
    const textParts: string[] = [];
    const imageParts: string[] = [];
    const messageSections: Array<{ order: number; markdown: string }> = [];
    let visibleMessageOrder = Number.POSITIVE_INFINITY;
    for (const part of message.parts.sort((left, right) => left.order - right.order)) {
      const { partType, payload } = part.event.data;
      if (partType === 'text') {
        const text = (payload as { text?: unknown }).text;
        if (typeof text === 'string' && text.trim()) {
          textParts.push(sanitizeCredentialText(text, state));
          visibleMessageOrder = Math.min(visibleMessageOrder, part.order);
        }
      } else if (partType === 'image') {
        const mimeType = (payload as { mimeType?: unknown }).mimeType;
        imageParts.push(
          typeof mimeType === 'string'
            ? `[Image: ${sanitizeCredentialText(mimeType, state)}]`
            : '[Image]'
        );
        visibleMessageOrder = Math.min(visibleMessageOrder, part.order);
      } else if (partType === 'reasoning' && includeReasoning) {
        const text = (payload as { text?: unknown }).text;
        if (typeof text === 'string' && text.trim()) {
          messageSections.push({
            order: part.order,
            markdown: `## Reasoning\n\n${sanitizeCredentialText(text, state).trim()}`,
          });
          reasoningCount += 1;
        }
      } else if (partType === 'tool_call') {
        const tool = payload as {
          toolName?: unknown;
          input?: unknown;
        };
        const name =
          typeof tool.toolName === 'string'
            ? sanitizeCredentialText(tool.toolName, state)
            : 'unknown';
        messageSections.push({
          order: part.order,
          markdown: renderActivity(`${name} call`, tool.input ?? {}, metadata, state),
        });
        activityCount += 1;
      } else if (partType === 'tool_result') {
        const tool = payload as {
          toolName?: unknown;
          output?: unknown;
          error?: unknown;
        };
        const name =
          typeof tool.toolName === 'string'
            ? sanitizeCredentialText(tool.toolName, state)
            : 'unknown';
        messageSections.push({
          order: part.order,
          markdown: renderActivity(
            `${name} result`,
            typeof tool.error === 'string'
              ? { error: tool.error }
              : { output: tool.output ?? null },
            metadata,
            state
          ),
        });
        activityCount += 1;
      } else if (partType === 'summary') {
        const text = (payload as { text?: unknown }).text;
        if (typeof text === 'string' && text.trim()) {
          messageSections.push({
            order: part.order,
            markdown: `## Summary\n\n${sanitizeCredentialText(text, state).trim()}`,
          });
        }
      } else if (partType === 'subtask_ref') {
        messageSections.push({
          order: part.order,
          markdown: renderActivity('Subagent', payload, metadata, state),
        });
        activityCount += 1;
      } else if (partType === 'diff' || partType === 'patch') {
        const value =
          typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
        messageSections.push({
          order: part.order,
          markdown: `## File changes\n\n${markdownFence(
            sanitizeToolString(value, metadata.projectPath, state),
            'diff'
          )}`,
        });
        activityCount += 1;
      }
    }

    if (
      (message.role === 'user' || message.role === 'assistant') &&
      (textParts.length > 0 || imageParts.length > 0)
    ) {
      messageSections.push({
        order: visibleMessageOrder,
        markdown: `## ${message.role === 'user' ? 'User' : 'Assistant'}\n\n${[
          ...textParts,
          ...imageParts,
        ]
          .join('\n\n')
          .trim()}`,
      });
      messageCount += 1;
    }
    sections.push(
      ...messageSections
        .sort((left, right) => left.order - right.order)
        .map((section) => section.markdown)
    );
  }

  if (sections.length === 0) {
    throw new Error('No conversation content to export');
  }

  const body = `${sections.join('\n\n')}\n`;
  const contentBytes = Buffer.byteLength(body, 'utf8');
  if (contentBytes > MAX_SESSION_MARKDOWN_EXPORT_BYTES) {
    throw new Error(
      `Session export exceeds ${MAX_SESSION_MARKDOWN_EXPORT_BYTES} bytes`
    );
  }
  const contentSha256 = createHash('sha256').update(body).digest('hex');
  const projectName = path.basename(
    metadata.taskSourceProjectPath ?? metadata.projectPath
  );
  const model = metadata.selectedModelId ?? metadata.taskModelId;
  const header =
    [
      '# Blade conversation',
      '',
      `- Session: \`${metadata.sessionId}\``,
      ...(metadata.title
        ? [`- Title: ${inline(sanitizeCredentialText(metadata.title, state))}`]
        : []),
      `- Project: \`${inline(sanitizeCredentialText(projectName, state))}\``,
      ...(model
        ? [`- Model: \`${inline(sanitizeCredentialText(model, state))}\``]
        : []),
      `- Created: ${metadata.firstMessageTime}`,
      `- Updated: ${metadata.lastMessageTime}`,
      `- State: ${metadata.archivedAt ? 'archived' : 'active'}`,
      `- Reasoning: ${includeReasoning ? 'included' : 'omitted'}`,
      ...(metadata.reasoningEffort
        ? [`- Reasoning effort: ${metadata.reasoningEffort}`]
        : []),
      ...(metadata.serviceTier ? [`- Service tier: ${metadata.serviceTier}`] : []),
      ...(metadata.responseVerbosity
        ? [`- Response verbosity: ${metadata.responseVerbosity}`]
        : []),
      ...(metadata.communicationStyle
        ? [`- Communication style: ${metadata.communicationStyle}`]
        : []),
      ...(metadata.communicationStyleDigest
        ? [`- Communication style SHA-256: \`${metadata.communicationStyleDigest}\``]
        : []),
      ...(metadata.projectInstructionsDigest
        ? [`- Project instructions SHA-256: \`${metadata.projectInstructionsDigest}\``]
        : []),
      `- Content SHA-256: \`${contentSha256}\``,
      `- Content bytes: ${contentBytes}`,
      `- Redactions: ${state.count}`,
      '',
      '---',
      '',
    ].join('\n') + '\n';
  const markdown = header + body;
  if (Buffer.byteLength(markdown, 'utf8') > MAX_SESSION_MARKDOWN_EXPORT_BYTES) {
    throw new Error(
      `Session export exceeds ${MAX_SESSION_MARKDOWN_EXPORT_BYTES} bytes`
    );
  }

  return {
    filename: `blade-session-${metadata.sessionId.slice(0, 12)}.md`,
    markdown,
    contentSha256,
    contentBytes,
    messageCount,
    activityCount,
    reasoningIncluded: includeReasoning,
    reasoningCount,
    redactionCount: state.count,
  };
}
