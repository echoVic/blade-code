import { createHash } from 'node:crypto';
import type {
  Prompt,
  Resource,
  ResourceTemplate,
} from '@modelcontextprotocol/sdk/types.js';

export const MAX_MCP_CONTENT_PAGES = 100;
export const MAX_MCP_RESOURCES = 1_000;
export const MAX_MCP_RESOURCE_TEMPLATES = 1_000;
export const MAX_MCP_PROMPTS = 1_000;
export const MAX_MCP_RESOURCE_SUBSCRIPTIONS = 100;
export const MAX_MCP_RESOURCE_CONTENTS = 64;
export const MAX_MCP_RESOURCE_TEXT_BYTES = 1024 * 1024;
export const MAX_MCP_RESOURCE_RESULT_BYTES = 4 * 1024 * 1024;

const MAX_NAME_CHARS = 256;
const MAX_URI_CHARS = 8_192;
const MAX_MIME_TYPE_CHARS = 256;
const MAX_DESCRIPTION_BYTES = 16 * 1024;
const MAX_PROMPT_ARGUMENTS = 64;
const MAX_ARGUMENT_DESCRIPTION_BYTES = 4 * 1024;
const MAX_CATALOG_BYTES = 4 * 1024 * 1024;
const MAX_MCP_PROMPT_MESSAGES = 128;

export interface McpResourceDefinition {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  size?: number;
}

export interface McpResourceTemplateDefinition {
  uriTemplate: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

export interface McpPromptArgumentDefinition {
  name: string;
  description?: string;
  required: boolean;
}

export interface McpPromptDefinition {
  name: string;
  title?: string;
  description?: string;
  arguments: McpPromptArgumentDefinition[];
}

export interface McpContentCatalogSnapshot {
  resources: McpResourceDefinition[];
  resourceTemplates: McpResourceTemplateDefinition[];
  prompts: McpPromptDefinition[];
}

export interface McpContentCatalogDelta {
  added: string[];
  removed: string[];
  updated: string[];
}

export type McpContentCatalogKind = 'resources' | 'resourceTemplates' | 'prompts';

function containsControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

function containsUnsafeTextControls(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return (
      code === 0x00 ||
      (code >= 0x01 && code <= 0x08) ||
      code === 0x0b ||
      code === 0x0c ||
      (code >= 0x0e && code <= 0x1f) ||
      code === 0x7f
    );
  });
}

function boundedText(
  value: string | undefined,
  label: string,
  maxBytes: number
): string | undefined {
  if (value === undefined) return undefined;
  if (
    label === 'description'
      ? containsUnsafeTextControls(value)
      : containsControlCharacters(value)
  ) {
    throw new Error(`MCP ${label} contains control characters`);
  }
  if (Buffer.byteLength(value) > maxBytes) {
    throw new Error(`MCP ${label} exceeds ${maxBytes} bytes`);
  }
  return value;
}

function requiredIdentity(value: string, label: string, maxChars: number): string {
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > maxChars ||
    containsControlCharacters(normalized)
  ) {
    throw new Error(`MCP ${label} is invalid`);
  }
  return normalized;
}

function catalogBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

function enforceCatalogBytes(value: unknown, label: string): void {
  if (catalogBytes(value) > MAX_CATALOG_BYTES) {
    throw new Error(`MCP ${label} catalog exceeds ${MAX_CATALOG_BYTES} bytes`);
  }
}

function assertUnique(values: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      throw new Error(`MCP ${label} catalog contains duplicate "${value}"`);
    }
    seen.add(value);
  }
}

export function normalizeMcpResources(
  resources: readonly Resource[]
): McpResourceDefinition[] {
  if (resources.length > MAX_MCP_RESOURCES) {
    throw new Error(`MCP resource catalog exceeds ${MAX_MCP_RESOURCES} entries`);
  }
  const normalized = resources.map((resource) => ({
    uri: requiredIdentity(resource.uri, 'resource URI', MAX_URI_CHARS),
    name: requiredIdentity(resource.name, 'resource name', MAX_NAME_CHARS),
    ...(boundedText(resource.title, 'resource title', MAX_NAME_CHARS)
      ? { title: resource.title }
      : {}),
    ...(boundedText(resource.description, 'description', MAX_DESCRIPTION_BYTES)
      ? { description: resource.description }
      : {}),
    ...(boundedText(resource.mimeType, 'resource MIME type', MAX_MIME_TYPE_CHARS)
      ? { mimeType: resource.mimeType }
      : {}),
    ...(resource.size !== undefined &&
    Number.isSafeInteger(resource.size) &&
    resource.size >= 0
      ? { size: resource.size }
      : {}),
  }));
  assertUnique(
    normalized.map((resource) => resource.uri),
    'resource'
  );
  enforceCatalogBytes(normalized, 'resource');
  return normalized;
}

export function normalizeMcpResourceTemplates(
  templates: readonly ResourceTemplate[]
): McpResourceTemplateDefinition[] {
  if (templates.length > MAX_MCP_RESOURCE_TEMPLATES) {
    throw new Error(
      `MCP resource template catalog exceeds ${MAX_MCP_RESOURCE_TEMPLATES} entries`
    );
  }
  const normalized = templates.map((template) => ({
    uriTemplate: requiredIdentity(
      template.uriTemplate,
      'resource template URI',
      MAX_URI_CHARS
    ),
    name: requiredIdentity(template.name, 'resource template name', MAX_NAME_CHARS),
    ...(boundedText(template.title, 'resource template title', MAX_NAME_CHARS)
      ? { title: template.title }
      : {}),
    ...(boundedText(template.description, 'description', MAX_DESCRIPTION_BYTES)
      ? { description: template.description }
      : {}),
    ...(boundedText(
      template.mimeType,
      'resource template MIME type',
      MAX_MIME_TYPE_CHARS
    )
      ? { mimeType: template.mimeType }
      : {}),
  }));
  assertUnique(
    normalized.map((template) => template.uriTemplate),
    'resource template'
  );
  enforceCatalogBytes(normalized, 'resource template');
  return normalized;
}

export function normalizeMcpPrompts(prompts: readonly Prompt[]): McpPromptDefinition[] {
  if (prompts.length > MAX_MCP_PROMPTS) {
    throw new Error(`MCP prompt catalog exceeds ${MAX_MCP_PROMPTS} entries`);
  }
  const normalized = prompts.map((prompt) => {
    if ((prompt.arguments?.length ?? 0) > MAX_PROMPT_ARGUMENTS) {
      throw new Error(
        `MCP prompt "${prompt.name}" exceeds ${MAX_PROMPT_ARGUMENTS} arguments`
      );
    }
    const arguments_ = (prompt.arguments ?? []).map((argument) => {
      const name = requiredIdentity(
        argument.name,
        'prompt argument name',
        MAX_NAME_CHARS
      );
      if (['__proto__', 'constructor', 'prototype'].includes(name)) {
        throw new Error(`MCP prompt argument name "${name}" is unsafe`);
      }
      return {
        name,
        ...(boundedText(
          argument.description,
          'description',
          MAX_ARGUMENT_DESCRIPTION_BYTES
        )
          ? { description: argument.description }
          : {}),
        required: argument.required === true,
      };
    });
    assertUnique(
      arguments_.map((argument) => argument.name),
      `prompt "${prompt.name}" argument`
    );
    return {
      name: requiredIdentity(prompt.name, 'prompt name', MAX_NAME_CHARS),
      ...(boundedText(prompt.title, 'prompt title', MAX_NAME_CHARS)
        ? { title: prompt.title }
        : {}),
      ...(boundedText(prompt.description, 'description', MAX_DESCRIPTION_BYTES)
        ? { description: prompt.description }
        : {}),
      arguments: arguments_,
    };
  });
  assertUnique(
    normalized.map((prompt) => prompt.name),
    'prompt'
  );
  enforceCatalogBytes(normalized, 'prompt');
  return normalized;
}

function signature(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function diffMcpContentCatalog<T>(
  previous: readonly T[],
  next: readonly T[],
  identity: (value: T) => string
): McpContentCatalogDelta {
  const before = new Map(previous.map((value) => [identity(value), signature(value)]));
  const after = new Map(next.map((value) => [identity(value), signature(value)]));
  return {
    added: [...after.keys()].filter((key) => !before.has(key)).sort(),
    removed: [...before.keys()].filter((key) => !after.has(key)).sort(),
    updated: [...after.keys()]
      .filter((key) => before.has(key) && before.get(key) !== after.get(key))
      .sort(),
  };
}

export function hasMcpContentChanges(delta: McpContentCatalogDelta): boolean {
  return delta.added.length > 0 || delta.removed.length > 0 || delta.updated.length > 0;
}

export interface McpBinaryContentMetadata {
  size: number;
  sha256: string;
  omitted: true;
}

export interface McpNormalizedResourceContent {
  uri: string;
  mimeType?: string;
  text?: string;
  binary?: McpBinaryContentMetadata;
}

export interface McpNormalizedResourceResult {
  contents: McpNormalizedResourceContent[];
}

export interface McpNormalizedPromptMessage {
  role: 'user' | 'assistant';
  content:
    | { type: 'text'; text: string }
    | { type: 'resource'; resource: McpNormalizedResourceContent }
    | {
        type: 'resource_link';
        uri: string;
        name: string;
        mimeType?: string;
        description?: string;
      }
    | {
        type: 'image' | 'audio';
        mimeType: string;
        binary: McpBinaryContentMetadata;
      };
}

export interface McpNormalizedPromptResult {
  description?: string;
  messages: McpNormalizedPromptMessage[];
}

interface ContentBudget {
  bytes: number;
}

function consumeContentBudget(
  budget: ContentBudget,
  bytes: number,
  label: string
): void {
  budget.bytes += bytes;
  if (budget.bytes > MAX_MCP_RESOURCE_RESULT_BYTES) {
    throw new Error(
      `MCP ${label} exceeds ${MAX_MCP_RESOURCE_RESULT_BYTES} total bytes`
    );
  }
}

function decodeBinaryMetadata(
  data: string,
  label: string,
  budget: ContentBudget
): McpBinaryContentMetadata {
  if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
    throw new Error(`MCP ${label} contains invalid base64`);
  }
  const bytes = Buffer.from(data, 'base64');
  if (bytes.length > MAX_MCP_RESOURCE_RESULT_BYTES) {
    throw new Error(
      `MCP ${label} exceeds ${MAX_MCP_RESOURCE_RESULT_BYTES} decoded bytes`
    );
  }
  consumeContentBudget(budget, bytes.length, label);
  return {
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    omitted: true,
  };
}

function normalizeResourceContent(
  content: Record<string, unknown>,
  budget: ContentBudget
): McpNormalizedResourceContent {
  const uri = requiredIdentity(
    typeof content.uri === 'string' ? content.uri : '',
    'resource content URI',
    MAX_URI_CHARS
  );
  const mimeType =
    typeof content.mimeType === 'string'
      ? boundedText(content.mimeType, 'resource MIME type', MAX_MIME_TYPE_CHARS)
      : undefined;
  if (typeof content.text === 'string') {
    const textBytes = Buffer.byteLength(content.text);
    if (textBytes > MAX_MCP_RESOURCE_TEXT_BYTES) {
      throw new Error(`MCP resource text exceeds ${MAX_MCP_RESOURCE_TEXT_BYTES} bytes`);
    }
    consumeContentBudget(budget, textBytes, 'resource result');
    return {
      uri,
      ...(mimeType ? { mimeType } : {}),
      text: content.text,
    };
  }
  if (typeof content.blob === 'string') {
    return {
      uri,
      ...(mimeType ? { mimeType } : {}),
      binary: decodeBinaryMetadata(content.blob, 'resource blob', budget),
    };
  }
  throw new Error('MCP resource content has neither text nor blob data');
}

export function normalizeMcpResourceResult(
  result: unknown
): McpNormalizedResourceResult {
  const contents =
    result &&
    typeof result === 'object' &&
    Array.isArray((result as { contents?: unknown }).contents)
      ? ((result as { contents: unknown[] }).contents as unknown[])
      : [];
  if (contents.length > MAX_MCP_RESOURCE_CONTENTS) {
    throw new Error(
      `MCP resource result exceeds ${MAX_MCP_RESOURCE_CONTENTS} contents`
    );
  }
  const budget: ContentBudget = { bytes: 0 };
  const normalized = contents.map((content) => {
    if (!content || typeof content !== 'object' || Array.isArray(content)) {
      throw new Error('MCP resource content is malformed');
    }
    return normalizeResourceContent(content as Record<string, unknown>, budget);
  });
  if (catalogBytes(normalized) > MAX_MCP_RESOURCE_RESULT_BYTES) {
    throw new Error(
      `MCP resource result exceeds ${MAX_MCP_RESOURCE_RESULT_BYTES} bytes`
    );
  }
  return { contents: normalized };
}

export function normalizeMcpPromptResult(result: unknown): McpNormalizedPromptResult {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error('MCP prompt result is malformed');
  }
  const record = result as Record<string, unknown>;
  const messages = Array.isArray(record.messages) ? record.messages : [];
  if (messages.length > MAX_MCP_PROMPT_MESSAGES) {
    throw new Error(`MCP prompt exceeds ${MAX_MCP_PROMPT_MESSAGES} messages`);
  }
  const budget: ContentBudget = { bytes: 0 };
  const normalized = messages.map((message): McpNormalizedPromptMessage => {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      throw new Error('MCP prompt message is malformed');
    }
    const messageRecord = message as Record<string, unknown>;
    const role = messageRecord.role;
    if (role !== 'user' && role !== 'assistant') {
      throw new Error('MCP prompt message has an invalid role');
    }
    const content = messageRecord.content;
    if (!content || typeof content !== 'object' || Array.isArray(content)) {
      throw new Error('MCP prompt message content is malformed');
    }
    const contentRecord = content as Record<string, unknown>;
    if (contentRecord.type === 'text' && typeof contentRecord.text === 'string') {
      const textBytes = Buffer.byteLength(contentRecord.text);
      if (textBytes > MAX_MCP_RESOURCE_TEXT_BYTES) {
        throw new Error(`MCP prompt text exceeds ${MAX_MCP_RESOURCE_TEXT_BYTES} bytes`);
      }
      consumeContentBudget(budget, textBytes, 'prompt result');
      return { role, content: { type: 'text', text: contentRecord.text } };
    }
    if (
      (contentRecord.type === 'image' || contentRecord.type === 'audio') &&
      typeof contentRecord.data === 'string' &&
      typeof contentRecord.mimeType === 'string'
    ) {
      return {
        role,
        content: {
          type: contentRecord.type,
          mimeType: requiredIdentity(
            contentRecord.mimeType,
            'prompt content MIME type',
            MAX_MIME_TYPE_CHARS
          ),
          binary: decodeBinaryMetadata(
            contentRecord.data,
            `prompt ${contentRecord.type}`,
            budget
          ),
        },
      };
    }
    if (
      contentRecord.type === 'resource' &&
      contentRecord.resource &&
      typeof contentRecord.resource === 'object' &&
      !Array.isArray(contentRecord.resource)
    ) {
      return {
        role,
        content: {
          type: 'resource',
          resource: normalizeResourceContent(
            contentRecord.resource as Record<string, unknown>,
            budget
          ),
        },
      };
    }
    if (
      contentRecord.type === 'resource_link' &&
      typeof contentRecord.uri === 'string' &&
      typeof contentRecord.name === 'string'
    ) {
      return {
        role,
        content: {
          type: 'resource_link',
          uri: requiredIdentity(
            contentRecord.uri,
            'prompt resource link URI',
            MAX_URI_CHARS
          ),
          name: requiredIdentity(
            contentRecord.name,
            'prompt resource link name',
            MAX_NAME_CHARS
          ),
          ...(typeof contentRecord.mimeType === 'string'
            ? {
                mimeType: requiredIdentity(
                  contentRecord.mimeType,
                  'prompt resource link MIME type',
                  MAX_MIME_TYPE_CHARS
                ),
              }
            : {}),
          ...(typeof contentRecord.description === 'string'
            ? {
                description: boundedText(
                  contentRecord.description,
                  'description',
                  MAX_DESCRIPTION_BYTES
                ),
              }
            : {}),
        },
      };
    }
    throw new Error(
      `Unsupported MCP prompt content type: ${String(contentRecord.type)}`
    );
  });
  if (catalogBytes(normalized) > MAX_MCP_RESOURCE_RESULT_BYTES) {
    throw new Error(`MCP prompt result exceeds ${MAX_MCP_RESOURCE_RESULT_BYTES} bytes`);
  }
  return {
    ...(typeof record.description === 'string'
      ? {
          description: boundedText(
            record.description,
            'description',
            MAX_DESCRIPTION_BYTES
          ),
        }
      : {}),
    messages: normalized,
  };
}
