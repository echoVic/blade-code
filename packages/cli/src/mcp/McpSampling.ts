import type {
  CreateMessageRequest,
  CreateMessageResult,
} from '@modelcontextprotocol/sdk/types.js';
import {
  MAX_INLINE_ATTACHMENT_BYTES,
  MAX_INLINE_ATTACHMENT_COUNT,
} from '../api/attachmentLimits.js';
import type {
  ChatResponse,
  ContentPart,
  Message,
} from '../services/ChatServiceInterface.js';

const DEFAULT_MAX_TOKENS = 1_024;
const MAX_MAX_TOKENS = 4_096;
const DEFAULT_MAX_REQUESTS = 2;
const MAX_MAX_REQUESTS = 8;
const DEFAULT_MAX_INPUT_BYTES = 64 * 1024;
const MAX_MAX_INPUT_BYTES = 1024 * 1024;
const MAX_MESSAGES = 50;
const MAX_SYSTEM_PROMPT_CHARS = 16_000;
const MAX_STOP_SEQUENCES = 4;
const MAX_STOP_SEQUENCE_CHARS = 100;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const SUPPORTED_IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

export interface McpSamplingPolicyConfig {
  enabled: boolean;
  maxTokens?: number;
  maxRequestsPerToolCall?: number;
  maxInputBytes?: number;
}

export interface McpSamplingPolicy {
  enabled: boolean;
  maxTokens: number;
  maxRequestsPerToolCall: number;
  maxInputBytes: number;
}

export interface NormalizedMcpSamplingRequest {
  messages: Message[];
  maxTokens: number;
  temperature?: number;
  stopSequences: string[];
  preview: string;
}

export type McpSamplingHandler = (
  request: NormalizedMcpSamplingRequest,
  signal: AbortSignal
) => Promise<CreateMessageResult>;

type SamplingParams = CreateMessageRequest['params'];
type SamplingContent = SamplingParams['messages'][number]['content'];
type SamplingContentBlock =
  | Exclude<SamplingContent, unknown[]>
  | Extract<SamplingContent, unknown[]>[number];

export function normalizeMcpSamplingPolicy(
  input: McpSamplingPolicyConfig | undefined
): McpSamplingPolicy {
  if (!input) {
    return {
      enabled: false,
      maxTokens: DEFAULT_MAX_TOKENS,
      maxRequestsPerToolCall: DEFAULT_MAX_REQUESTS,
      maxInputBytes: DEFAULT_MAX_INPUT_BYTES,
    };
  }
  if (typeof input.enabled !== 'boolean') {
    throw new Error('MCP sampling.enabled must be a boolean');
  }
  return {
    enabled: input.enabled,
    maxTokens: boundedInteger(
      input.maxTokens ?? DEFAULT_MAX_TOKENS,
      1,
      MAX_MAX_TOKENS,
      'MCP sampling.maxTokens'
    ),
    maxRequestsPerToolCall: boundedInteger(
      input.maxRequestsPerToolCall ?? DEFAULT_MAX_REQUESTS,
      1,
      MAX_MAX_REQUESTS,
      'MCP sampling.maxRequestsPerToolCall'
    ),
    maxInputBytes: boundedInteger(
      input.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES,
      1,
      MAX_MAX_INPUT_BYTES,
      'MCP sampling.maxInputBytes'
    ),
  };
}

export function normalizeMcpSamplingRequest(
  params: SamplingParams,
  policy: McpSamplingPolicy
): NormalizedMcpSamplingRequest {
  if (!policy.enabled) throw new Error('MCP sampling is disabled');
  if (params.task) throw new Error('Task-based MCP sampling is not supported');
  if (params.tools?.length) {
    throw new Error('MCP sampling tools were not negotiated');
  }
  if (params.includeContext && params.includeContext !== 'none') {
    throw new Error('MCP sampling server context was not negotiated');
  }
  if (params.messages.length === 0 || params.messages.length > MAX_MESSAGES) {
    throw new Error(`MCP sampling messages must contain 1-${MAX_MESSAGES} entries`);
  }
  if (
    params.systemPrompt !== undefined &&
    params.systemPrompt.length > MAX_SYSTEM_PROMPT_CHARS
  ) {
    throw new Error(
      `MCP sampling system prompt exceeds ${MAX_SYSTEM_PROMPT_CHARS} characters`
    );
  }
  if (
    params.temperature !== undefined &&
    (!Number.isFinite(params.temperature) ||
      params.temperature < 0 ||
      params.temperature > 2)
  ) {
    throw new Error('MCP sampling temperature must be between 0 and 2');
  }
  const stopSequences = params.stopSequences ?? [];
  if (
    stopSequences.length > MAX_STOP_SEQUENCES ||
    stopSequences.some(
      (sequence) =>
        !sequence ||
        sequence.length > MAX_STOP_SEQUENCE_CHARS ||
        sequence.includes('\0')
    )
  ) {
    throw new Error(
      `MCP sampling stop sequences must contain at most ${MAX_STOP_SEQUENCES} non-empty bounded values`
    );
  }

  const messages: Message[] = [];
  let inputBytes = 0;
  let imageBytes = 0;
  let imageCount = 0;
  const previewLines: string[] = [];
  if (params.systemPrompt) {
    inputBytes += Buffer.byteLength(params.systemPrompt, 'utf8');
    messages.push({ role: 'system', content: params.systemPrompt });
    previewLines.push(`System: ${boundedPreview(params.systemPrompt)}`);
  }

  for (const message of params.messages) {
    const blocks = Array.isArray(message.content) ? message.content : [message.content];
    const parts: ContentPart[] = [];
    const messagePreview: string[] = [];
    for (const block of blocks as SamplingContentBlock[]) {
      if (block.type === 'text') {
        inputBytes += Buffer.byteLength(block.text, 'utf8');
        parts.push({ type: 'text', text: block.text });
        messagePreview.push(boundedPreview(block.text));
        continue;
      }
      if (block.type === 'image') {
        if (message.role !== 'user') {
          throw new Error('MCP sampling images are only supported in user messages');
        }
        if (!SUPPORTED_IMAGE_TYPES.has(block.mimeType)) {
          throw new Error(`Unsupported MCP sampling image type: ${block.mimeType}`);
        }
        const bytes = decodeBase64Size(block.data);
        imageBytes += bytes;
        imageCount++;
        parts.push({
          type: 'image_url',
          image_url: {
            url: `data:${block.mimeType};base64,${block.data}`,
          },
        });
        messagePreview.push(`[${block.mimeType} image, ${bytes} bytes]`);
        continue;
      }
      throw new Error(`Unsupported MCP sampling content type: ${block.type}`);
    }
    if (parts.length === 0) {
      throw new Error('MCP sampling message has no supported content');
    }
    messages.push({
      role: message.role,
      content: parts.length === 1 && parts[0]?.type === 'text' ? parts[0].text : parts,
    });
    previewLines.push(
      `${message.role === 'user' ? 'User' : 'Assistant'}: ${messagePreview.join(' ')}`
    );
  }

  if (inputBytes + imageBytes > policy.maxInputBytes) {
    throw new Error(`MCP sampling input exceeds ${policy.maxInputBytes} bytes`);
  }
  if (
    imageCount > MAX_INLINE_ATTACHMENT_COUNT ||
    imageBytes > MAX_INLINE_ATTACHMENT_BYTES
  ) {
    throw new Error('MCP sampling image input exceeds the shared attachment budget');
  }

  const requestedMaxTokens = boundedInteger(
    params.maxTokens,
    1,
    Number.MAX_SAFE_INTEGER,
    'MCP sampling maxTokens'
  );
  return {
    messages,
    maxTokens: Math.min(requestedMaxTokens, policy.maxTokens),
    ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
    stopSequences: [...stopSequences],
    preview: previewLines.join('\n').slice(0, 8_000),
  };
}

export function finalizeMcpSamplingResponse(
  response: ChatResponse,
  model: string,
  request: NormalizedMcpSamplingRequest
): CreateMessageResult {
  if (response.toolCalls?.length) {
    throw new Error('Model returned tools for basic MCP sampling');
  }
  let text = response.content;
  let stopReason: string =
    response.finishReason === 'length' || response.finishReason === 'max_tokens'
      ? 'maxTokens'
      : 'endTurn';
  let firstStopIndex = -1;
  for (const sequence of request.stopSequences) {
    const index = text.indexOf(sequence);
    if (index >= 0 && (firstStopIndex === -1 || index < firstStopIndex)) {
      firstStopIndex = index;
    }
  }
  if (firstStopIndex >= 0) {
    text = text.slice(0, firstStopIndex);
    stopReason = 'stopSequence';
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
    throw new Error(`MCP sampling response exceeds ${MAX_RESPONSE_BYTES} bytes`);
  }
  return {
    model,
    role: 'assistant',
    content: {
      type: 'text',
      text,
    },
    stopReason,
  };
}

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  label: string
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function decodeBase64Size(data: string): number {
  if (!data || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
    throw new Error('MCP sampling image contains invalid base64 data');
  }
  return Buffer.from(data, 'base64').byteLength;
}

function boundedPreview(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 1_000);
}
