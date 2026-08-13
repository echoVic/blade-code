import type {
  ToolDisplayOutput,
  ToolResult,
  ToolResultMetadata,
} from '../types/ToolTypes.js';
import { ToolErrorType } from '../types/ToolTypes.js';

export const TUI_TOOL_DETAIL_MAX_CHARS = 1_200;
export const HEADLESS_TOOL_DETAIL_MAX_CHARS = 2_000;
export const ACP_TOOL_DETAIL_MAX_CHARS = 2_000;
export const SERVER_TOOL_DETAIL_MAX_CHARS = 2_000;

export interface DurableToolResultPayload {
  toolCallId?: string;
  toolName?: string;
  output?: unknown | null;
  error?: unknown | null;
  metadata?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string | undefined {
  if (typeof error === 'string' && error.length > 0) return error;
  if (isRecord(error) && typeof error.message === 'string') return error.message;
  return undefined;
}

function projectOutput(output: unknown, failure: string | undefined): string | object {
  if (output === null || output === undefined) return failure ?? '';
  if (typeof output === 'string') return output;
  if (typeof output === 'object') return output;
  return String(output);
}

export function projectDurableToolResult(
  payload: DurableToolResultPayload
): ToolResult {
  const failed = payload.error !== null && payload.error !== undefined;
  const message = failed
    ? (errorMessage(payload.error) ?? 'Tool execution failed')
    : undefined;
  const metadata = isRecord(payload.metadata)
    ? (payload.metadata as ToolResultMetadata)
    : undefined;

  return {
    success: !failed,
    llmContent: projectOutput(payload.output, message),
    ...(message
      ? {
          error: {
            type: ToolErrorType.EXECUTION_ERROR,
            message,
          },
        }
      : {}),
    ...(metadata ? { metadata } : {}),
  };
}

function safeHead(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  let end = Math.max(0, maxChars);
  if (
    end > 0 &&
    end < value.length &&
    /[\uD800-\uDBFF]/.test(value.charAt(end - 1))
  ) {
    end -= 1;
  }
  return value.slice(0, end);
}

function safeTail(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  let start = Math.max(0, value.length - maxChars);
  if (start < value.length && /[\uDC00-\uDFFF]/.test(value.charAt(start))) {
    start += 1;
  }
  return value.slice(start);
}

function fitSection(section: string, maxChars: number): string {
  if (section.length <= maxChars) return section;
  if (maxChars <= 0) return '';

  const marker = '\n... (display clipped) ...\n';
  const firstNewline = section.indexOf('\n');
  const firstLine =
    firstNewline >= 0 && /^(?:stdout|stderr):$/.test(section.slice(0, firstNewline))
      ? `${section.slice(0, firstNewline)}\n`
      : '';
  const content = firstLine ? section.slice(firstLine.length) : section;
  const available = maxChars - firstLine.length - marker.length;
  if (available <= 0) return safeTail(section, maxChars);

  const headChars = Math.min(Math.floor(available / 3), content.length);
  const tailChars = Math.max(0, available - headChars);
  return (
    firstLine +
    safeHead(content, headChars) +
    marker +
    safeTail(content, tailChars)
  );
}

function splitTruncationSuffix(detail: string): {
  body: string;
  suffix?: string;
} {
  const lines = detail.split('\n');
  const last = lines.at(-1);
  if (!last?.startsWith('Output truncated')) return { body: detail };
  return {
    body: lines.slice(0, -1).join('\n'),
    suffix: last,
  };
}

function splitStreamSections(body: string): string[] {
  const stderrMarker = '\nstderr:\n';
  const stderrIndex = body.indexOf(stderrMarker);
  if (!body.startsWith('stdout:\n') || stderrIndex < 0) return [body];
  return [
    body.slice(0, stderrIndex),
    body.slice(stderrIndex + 1),
  ];
}

export function fitToolDisplayForSurface(
  display: ToolDisplayOutput,
  maxChars: number
): ToolDisplayOutput {
  if (!Number.isSafeInteger(maxChars) || maxChars <= 0) {
    throw new Error('maxChars must be a positive safe integer');
  }
  if (!display.detail || display.detail.length <= maxChars) return display;

  const { body, suffix } = splitTruncationSuffix(display.detail);
  const suffixText = suffix ? `\n${safeHead(suffix, maxChars)}` : '';
  const bodyBudget = Math.max(0, maxChars - suffixText.length);
  const sections = splitStreamSections(body);
  let fittedBody: string;

  if (sections.length === 2) {
    const separator = '\n';
    const available = Math.max(0, bodyBudget - separator.length);
    const stdoutBudget = Math.floor(available / 2);
    const stderrBudget = available - stdoutBudget;
    fittedBody = `${fitSection(sections[0], stdoutBudget)}${separator}${fitSection(
      sections[1],
      stderrBudget
    )}`;
  } else {
    fittedBody = fitSection(body, bodyBudget);
  }

  const detail = safeHead(`${fittedBody}${suffixText}`, maxChars);
  return { ...display, detail };
}
