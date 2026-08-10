import { createHash } from 'node:crypto';

export const MAX_MCP_TOOL_RESULT_CONTENTS = 64;
export const MAX_MCP_TOOL_TEXT_PART_BYTES = 1024 * 1024;
export const MAX_MCP_TOOL_TEXT_TOTAL_BYTES = 4 * 1024 * 1024;
export const MAX_MCP_TOOL_STRUCTURED_BYTES = 4 * 1024 * 1024;
export const MAX_MCP_TOOL_BINARY_PART_BYTES = 8 * 1024 * 1024;
export const MAX_MCP_TOOL_BINARY_TOTAL_BYTES = 16 * 1024 * 1024;
export const MAX_MCP_TOOL_INLINE_BYTES = 100 * 1024;
export const MAX_MCP_TOOL_ERROR_BYTES = 4 * 1024;

const MAX_IDENTITY_CHARS = 8_192;
const MAX_NAME_CHARS = 256;
const MAX_DESCRIPTION_BYTES = 16 * 1024;
const MAX_MIME_TYPE_CHARS = 256;
const PREVIEW_HEAD_BYTES = 8 * 1024;
const PREVIEW_TAIL_BYTES = 2 * 1024;

export type McpToolArtifactKind = 'text' | 'image' | 'audio' | 'resource';

export interface McpToolArtifactWriteRequest {
  kind: McpToolArtifactKind;
  bytes: Buffer;
  mimeType?: string;
  sourceUri?: string;
}

export interface McpToolArtifact {
  id: string;
  kind: McpToolArtifactKind;
  size: number;
  sha256: string;
  persisted: boolean;
  mimeType?: string;
  sourceUri?: string;
  path?: string;
}

export interface McpToolArtifactWriter {
  write(request: McpToolArtifactWriteRequest): Promise<McpToolArtifact>;
}

export interface McpToolResultMetadata {
  contentCount: number;
  textBytes: number;
  structuredBytes: number;
  artifactCount: number;
  truncated: boolean;
  binaryOmitted: boolean;
  artifacts: McpToolArtifact[];
}

export interface McpNormalizedToolResult {
  isError: boolean;
  llmContent: string;
  metadata: McpToolResultMetadata;
}

interface NormalizationBudget {
  textBytes: number;
  binaryBytes: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function containsUnsafeControls(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return (
      code === 0 ||
      (code >= 1 && code <= 8) ||
      code === 11 ||
      code === 12 ||
      (code >= 14 && code <= 31) ||
      code === 127
    );
  });
}

function stripUnsafeControls(value: string): string {
  return [...value]
    .filter((character) => {
      const code = character.charCodeAt(0);
      return !(
        code === 0 ||
        (code >= 1 && code <= 8) ||
        code === 11 ||
        code === 12 ||
        (code >= 14 && code <= 31) ||
        code === 127
      );
    })
    .join('');
}

function boundedText(value: unknown, label: string, maximumBytes: number): string {
  if (typeof value !== 'string') {
    throw new Error(`MCP tool ${label} must be a string`);
  }
  if (containsUnsafeControls(value)) {
    throw new Error(`MCP tool ${label} contains unsafe control characters`);
  }
  if (Buffer.byteLength(value) > maximumBytes) {
    throw new Error(`MCP tool ${label} exceeds ${maximumBytes} bytes`);
  }
  return value;
}

function boundedIdentity(value: unknown, label: string, maximum: number): string {
  const normalized = boundedText(value, label, maximum * 4).trim();
  if (!normalized || normalized.length > maximum) {
    throw new Error(`MCP tool ${label} is invalid`);
  }
  return normalized;
}

function consumeText(budget: NormalizationBudget, value: string, label: string): void {
  const bytes = Buffer.byteLength(value);
  if (bytes > MAX_MCP_TOOL_TEXT_PART_BYTES) {
    throw new Error(`MCP tool ${label} exceeds ${MAX_MCP_TOOL_TEXT_PART_BYTES} bytes`);
  }
  budget.textBytes += bytes;
  if (budget.textBytes > MAX_MCP_TOOL_TEXT_TOTAL_BYTES) {
    throw new Error(
      `MCP tool text exceeds ${MAX_MCP_TOOL_TEXT_TOTAL_BYTES} total bytes`
    );
  }
}

function sliceUtf8(value: string, maximumBytes: number, fromEnd = false): string {
  const bytes = Buffer.from(value);
  if (bytes.length <= maximumBytes) return value;
  const slice = fromEnd
    ? bytes.subarray(bytes.length - maximumBytes)
    : bytes.subarray(0, maximumBytes);
  let result = slice.toString('utf8');
  while (Buffer.byteLength(result) > maximumBytes) {
    result = fromEnd ? result.slice(1) : result.slice(0, -1);
  }
  return result.replace(fromEnd ? /^\uFFFD/ : /\uFFFD$/, '');
}

function strictBase64(value: unknown, label: string): Buffer {
  if (typeof value !== 'string') {
    throw new Error(`MCP tool ${label} must contain base64 data`);
  }
  const maximumEncodedLength = Math.ceil((MAX_MCP_TOOL_BINARY_PART_BYTES * 4) / 3) + 4;
  if (
    value.length > maximumEncodedLength ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
  ) {
    throw new Error(`MCP tool ${label} contains invalid or oversized base64`);
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > MAX_MCP_TOOL_BINARY_PART_BYTES) {
    throw new Error(
      `MCP tool ${label} exceeds ${MAX_MCP_TOOL_BINARY_PART_BYTES} decoded bytes`
    );
  }
  return bytes;
}

async function projectArtifact(
  request: McpToolArtifactWriteRequest,
  writer?: McpToolArtifactWriter
): Promise<McpToolArtifact> {
  const sha256 = createHash('sha256').update(request.bytes).digest('hex');
  const fallback: McpToolArtifact = {
    id: sha256,
    kind: request.kind,
    size: request.bytes.length,
    sha256,
    persisted: false,
    ...(request.mimeType ? { mimeType: request.mimeType } : {}),
    ...(request.sourceUri ? { sourceUri: request.sourceUri } : {}),
  };
  if (!writer) return fallback;
  try {
    const artifact = await writer.write(request);
    return {
      ...fallback,
      ...artifact,
      id: sha256,
      sha256,
      size: request.bytes.length,
    };
  } catch {
    return fallback;
  }
}

function artifactLine(artifact: McpToolArtifact): string {
  const location = artifact.path
    ? ` path=${JSON.stringify(artifact.path)}`
    : artifact.persisted
      ? ` artifact_id=${artifact.id}`
      : ' content_omitted=true';
  return (
    `[${artifact.kind} artifact: size=${artifact.size} ` +
    `sha256=${artifact.sha256}` +
    `${artifact.mimeType ? ` mime_type=${JSON.stringify(artifact.mimeType)}` : ''}` +
    `${artifact.sourceUri ? ` uri=${JSON.stringify(artifact.sourceUri)}` : ''}` +
    `${location}]`
  );
}

function structuredContent(
  value: unknown
): { text: string; bytes: number } | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error('MCP tool structuredContent must be an object');
  }
  let text: string;
  try {
    text = JSON.stringify(value, null, 2);
  } catch {
    throw new Error('MCP tool structuredContent is not serializable');
  }
  const bytes = Buffer.byteLength(text);
  if (bytes > MAX_MCP_TOOL_STRUCTURED_BYTES) {
    throw new Error(
      `MCP tool structuredContent exceeds ${MAX_MCP_TOOL_STRUCTURED_BYTES} bytes`
    );
  }
  return { text, bytes };
}

export async function normalizeMcpToolResult(
  result: unknown,
  writer?: McpToolArtifactWriter
): Promise<McpNormalizedToolResult> {
  if (!isRecord(result) || !Array.isArray(result.content)) {
    throw new Error('MCP tool result is malformed');
  }
  if (result.content.length > MAX_MCP_TOOL_RESULT_CONTENTS) {
    throw new Error(
      `MCP tool result exceeds ${MAX_MCP_TOOL_RESULT_CONTENTS} content parts`
    );
  }

  const budget: NormalizationBudget = { textBytes: 0, binaryBytes: 0 };
  const parts: string[] = [];
  const artifacts: McpToolArtifact[] = [];

  for (const [index, value] of result.content.entries()) {
    if (!isRecord(value)) {
      throw new Error(`MCP tool content[${index}] is malformed`);
    }
    if (value.type === 'text') {
      const text = boundedText(
        value.text,
        `content[${index}] text`,
        MAX_MCP_TOOL_TEXT_PART_BYTES
      );
      consumeText(budget, text, `content[${index}] text`);
      parts.push(text);
      continue;
    }
    if (value.type === 'image' || value.type === 'audio') {
      const mimeType = boundedIdentity(
        value.mimeType,
        `content[${index}] MIME type`,
        MAX_MIME_TYPE_CHARS
      );
      const bytes = strictBase64(value.data, `content[${index}] ${value.type}`);
      budget.binaryBytes += bytes.length;
      if (budget.binaryBytes > MAX_MCP_TOOL_BINARY_TOTAL_BYTES) {
        throw new Error(
          `MCP tool binary content exceeds ${MAX_MCP_TOOL_BINARY_TOTAL_BYTES} total bytes`
        );
      }
      const artifact = await projectArtifact(
        { kind: value.type, bytes, mimeType },
        writer
      );
      artifacts.push(artifact);
      parts.push(artifactLine(artifact));
      continue;
    }
    if (value.type === 'resource_link') {
      const uri = boundedIdentity(
        value.uri,
        `content[${index}] resource link URI`,
        MAX_IDENTITY_CHARS
      );
      const name = boundedIdentity(
        value.name,
        `content[${index}] resource link name`,
        MAX_NAME_CHARS
      );
      const description =
        value.description === undefined
          ? undefined
          : boundedText(
              value.description,
              `content[${index}] resource link description`,
              MAX_DESCRIPTION_BYTES
            );
      const mimeType =
        value.mimeType === undefined
          ? undefined
          : boundedIdentity(
              value.mimeType,
              `content[${index}] MIME type`,
              MAX_MIME_TYPE_CHARS
            );
      parts.push(
        `[resource link: name=${JSON.stringify(name)} uri=${JSON.stringify(uri)}` +
          `${mimeType ? ` mime_type=${JSON.stringify(mimeType)}` : ''}` +
          `${description ? ` description=${JSON.stringify(description)}` : ''}]`
      );
      continue;
    }
    if (value.type === 'resource' && isRecord(value.resource)) {
      const resource = value.resource;
      const uri = boundedIdentity(
        resource.uri,
        `content[${index}] resource URI`,
        MAX_IDENTITY_CHARS
      );
      const mimeType =
        resource.mimeType === undefined
          ? undefined
          : boundedIdentity(
              resource.mimeType,
              `content[${index}] resource MIME type`,
              MAX_MIME_TYPE_CHARS
            );
      if (typeof resource.text === 'string') {
        const text = boundedText(
          resource.text,
          `content[${index}] resource text`,
          MAX_MCP_TOOL_TEXT_PART_BYTES
        );
        consumeText(budget, text, `content[${index}] resource text`);
        parts.push(
          `[resource: uri=${JSON.stringify(uri)}` +
            `${mimeType ? ` mime_type=${JSON.stringify(mimeType)}` : ''}]\n${text}`
        );
        continue;
      }
      const bytes = strictBase64(resource.blob, `content[${index}] resource blob`);
      budget.binaryBytes += bytes.length;
      if (budget.binaryBytes > MAX_MCP_TOOL_BINARY_TOTAL_BYTES) {
        throw new Error(
          `MCP tool binary content exceeds ${MAX_MCP_TOOL_BINARY_TOTAL_BYTES} total bytes`
        );
      }
      const artifact = await projectArtifact(
        { kind: 'resource', bytes, mimeType, sourceUri: uri },
        writer
      );
      artifacts.push(artifact);
      parts.push(artifactLine(artifact));
      continue;
    }
    throw new Error(`Unsupported MCP tool content type: ${String(value.type)}`);
  }

  const structured = structuredContent(result.structuredContent);
  if (structured) {
    parts.push(`[structuredContent]\n${structured.text}`);
  }
  let llmContent = parts.join('\n\n') || 'MCP tool returned no content.';
  if (Buffer.byteLength(llmContent) > MAX_MCP_TOOL_TEXT_TOTAL_BYTES) {
    throw new Error(
      `MCP tool normalized result exceeds ${MAX_MCP_TOOL_TEXT_TOTAL_BYTES} bytes`
    );
  }

  let truncated = false;
  if (Buffer.byteLength(llmContent) > MAX_MCP_TOOL_INLINE_BYTES) {
    const fullBytes = Buffer.from(llmContent);
    const artifact = await projectArtifact(
      { kind: 'text', bytes: fullBytes, mimeType: 'text/plain' },
      writer
    );
    artifacts.push(artifact);
    const head = sliceUtf8(llmContent, PREVIEW_HEAD_BYTES);
    const tail = sliceUtf8(llmContent, PREVIEW_TAIL_BYTES, true);
    llmContent =
      `MCP tool result exceeded the ${MAX_MCP_TOOL_INLINE_BYTES}-byte inline budget.\n` +
      `${artifactLine(artifact)}\n\nPreview (head):\n${head}\n\n` +
      `Preview (tail):\n${tail}`;
    truncated = true;
  }

  return {
    isError: result.isError === true,
    llmContent,
    metadata: {
      contentCount: result.content.length,
      textBytes: budget.textBytes,
      structuredBytes: structured?.bytes ?? 0,
      artifactCount: artifacts.length,
      truncated,
      binaryOmitted: budget.binaryBytes > 0,
      artifacts,
    },
  };
}

export function sanitizeMcpToolError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const sanitized = stripUnsafeControls(
    message
      .replace(/\bhttps?:\/\/[^\s"'`]+/gi, '[redacted-url]')
      .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
      .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[redacted]')
  ).trim();
  return sliceUtf8(sanitized || 'MCP tool execution failed', MAX_MCP_TOOL_ERROR_BYTES);
}
