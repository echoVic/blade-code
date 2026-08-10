import { createHash } from 'node:crypto';
import { UriTemplate } from '@modelcontextprotocol/sdk/shared/uriTemplate.js';
import type { CompleteResult } from '@modelcontextprotocol/sdk/types.js';
import type { McpContentCatalogSnapshot } from './McpContentCatalog.js';

export const MAX_MCP_COMPLETION_VALUES = 100;
export const MAX_MCP_COMPLETION_VALUE_BYTES = 4 * 1024;
export const MAX_MCP_COMPLETION_RESULT_BYTES = 64 * 1024;
export const MAX_MCP_COMPLETION_SOURCE_BYTES = 1024 * 1024;
export const MAX_MCP_COMPLETION_CONTEXT_ARGUMENTS = 32;
export const MAX_MCP_COMPLETION_CONTEXT_BYTES = 64 * 1024;
export const MAX_MCP_COMPLETION_CONCURRENCY = 4;
export const MCP_COMPLETION_TIMEOUT_MS = 15_000;

const MAX_ARGUMENT_NAME_BYTES = 256;
const MAX_ARGUMENT_VALUE_BYTES = 16 * 1024;
const MAX_PROMPT_NAME_BYTES = 256;
const MAX_RESOURCE_TEMPLATE_BYTES = 8 * 1024;
const UNSAFE_UNICODE = /[\p{Cf}\p{Co}\p{Cn}]/u;

export type McpCompletionReference =
  | { type: 'prompt'; name: string }
  | { type: 'resource'; uri: string };

export interface McpCompletionInput {
  reference: McpCompletionReference;
  argument: {
    name: string;
    value: string;
  };
  context?: Record<string, string>;
}

export interface McpValidatedCompletionInput {
  ref: { type: 'ref/prompt'; name: string } | { type: 'ref/resource'; uri: string };
  argument: {
    name: string;
    value: string;
  };
  context?: {
    arguments: Record<string, string>;
  };
}

export interface McpNormalizedCompletionResult {
  values: string[];
  total?: number;
  hasMore: boolean;
  sourceValueCount: number;
  sourceBytes: number;
  projectedBytes: number;
  sha256: string;
  truncated: boolean;
}

export function getMcpResourceTemplateVariables(uri: string): string[] {
  return [...new Set(new UriTemplate(uri).variableNames)];
}

export function validateMcpCompletionInput(
  input: McpCompletionInput,
  catalog: McpContentCatalogSnapshot
): McpValidatedCompletionInput {
  const argumentName = validateIdentity(
    input.argument.name,
    'completion argument name',
    MAX_ARGUMENT_NAME_BYTES
  );
  const argumentValue = validateValue(
    input.argument.value,
    'completion argument value',
    MAX_ARGUMENT_VALUE_BYTES
  );
  let allowedArguments: Set<string>;
  let ref: McpValidatedCompletionInput['ref'];

  if (input.reference.type === 'prompt') {
    const name = validateIdentity(
      input.reference.name,
      'completion prompt name',
      MAX_PROMPT_NAME_BYTES
    );
    const prompt = catalog.prompts.find((candidate) => candidate.name === name);
    if (!prompt) {
      throw new Error(`MCP prompt "${name}" is not present in the current catalog`);
    }
    allowedArguments = new Set(prompt.arguments.map((argument) => argument.name));
    ref = { type: 'ref/prompt', name };
  } else {
    const uri = validateIdentity(
      input.reference.uri,
      'completion resource template URI',
      MAX_RESOURCE_TEMPLATE_BYTES
    );
    const template = catalog.resourceTemplates.find(
      (candidate) => candidate.uriTemplate === uri
    );
    if (!template) {
      throw new Error(
        `MCP resource template "${uri}" is not present in the current catalog`
      );
    }
    let variableNames: string[];
    try {
      variableNames = getMcpResourceTemplateVariables(uri);
    } catch {
      throw new Error(`MCP resource template "${uri}" is invalid`);
    }
    allowedArguments = new Set(variableNames);
    ref = { type: 'ref/resource', uri };
  }

  if (!allowedArguments.has(argumentName)) {
    throw new Error(
      `MCP ${input.reference.type} completion argument "${argumentName}" is not declared`
    );
  }

  const contextEntries = Object.entries(input.context ?? {});
  if (contextEntries.length > MAX_MCP_COMPLETION_CONTEXT_ARGUMENTS) {
    throw new Error(
      `MCP completion context exceeds ${MAX_MCP_COMPLETION_CONTEXT_ARGUMENTS} arguments`
    );
  }
  const contextArguments = Object.create(null) as Record<string, string>;
  let contextBytes = 0;
  for (const [rawName, rawValue] of contextEntries) {
    const name = validateIdentity(
      rawName,
      'completion context argument name',
      MAX_ARGUMENT_NAME_BYTES
    );
    if (isUnsafeProperty(name)) {
      throw new Error(`Unsafe MCP completion context argument "${name}"`);
    }
    if (!allowedArguments.has(name)) {
      throw new Error(`Unknown MCP completion context argument "${name}"`);
    }
    const value = validateValue(
      rawValue,
      `completion context argument "${name}"`,
      MAX_ARGUMENT_VALUE_BYTES
    );
    contextBytes += Buffer.byteLength(name) + Buffer.byteLength(value);
    if (contextBytes > MAX_MCP_COMPLETION_CONTEXT_BYTES) {
      throw new Error(
        `MCP completion context exceeds ${MAX_MCP_COMPLETION_CONTEXT_BYTES} bytes`
      );
    }
    contextArguments[name] = value;
  }

  return {
    ref,
    argument: {
      name: argumentName,
      value: argumentValue,
    },
    ...(contextEntries.length > 0
      ? {
          context: {
            arguments: contextArguments,
          },
        }
      : {}),
  };
}

export function normalizeMcpCompletionResult(
  result: CompleteResult
): McpNormalizedCompletionResult {
  const rawCompletion = result.completion;
  const serialized = JSON.stringify(rawCompletion);
  const sourceBytes = Buffer.byteLength(serialized);
  const sha256 = createHash('sha256').update(serialized).digest('hex');
  const sourceValueCount = rawCompletion.values.length;
  const values: string[] = [];
  const seen = new Set<string>();
  let projectedBytes = 0;
  let sourceWorkBytes = 0;
  let truncated =
    sourceValueCount > MAX_MCP_COMPLETION_VALUES ||
    sourceBytes > MAX_MCP_COMPLETION_SOURCE_BYTES;

  for (const rawValue of rawCompletion.values.slice(0, MAX_MCP_COMPLETION_VALUES)) {
    const rawBytes = Buffer.byteLength(rawValue);
    const remainingSourceBytes = Math.max(
      0,
      MAX_MCP_COMPLETION_SOURCE_BYTES - sourceWorkBytes
    );
    if (remainingSourceBytes === 0) {
      truncated = true;
      break;
    }
    const boundedSource = sliceUtf8(
      rawValue,
      Math.min(MAX_MCP_COMPLETION_SOURCE_BYTES, remainingSourceBytes)
    );
    sourceWorkBytes += Buffer.byteLength(boundedSource);
    if (rawBytes > Buffer.byteLength(boundedSource)) truncated = true;

    const sanitized = sanitizeMcpCompletionValue(boundedSource);
    const projected = sliceUtf8(sanitized, MAX_MCP_COMPLETION_VALUE_BYTES);
    if (Buffer.byteLength(projected) < Buffer.byteLength(sanitized)) {
      truncated = true;
    }
    if (seen.has(projected)) continue;
    const valueBytes = Buffer.byteLength(projected);
    if (projectedBytes + valueBytes > MAX_MCP_COMPLETION_RESULT_BYTES) {
      truncated = true;
      break;
    }
    seen.add(projected);
    values.push(projected);
    projectedBytes += valueBytes;
  }

  if (values.length < sourceValueCount) truncated = true;
  const total =
    rawCompletion.total !== undefined &&
    Number.isSafeInteger(rawCompletion.total) &&
    rawCompletion.total >= 0
      ? rawCompletion.total
      : undefined;

  return {
    values,
    ...(total !== undefined ? { total } : {}),
    hasMore:
      rawCompletion.hasMore === true ||
      truncated ||
      (total !== undefined && total > values.length),
    sourceValueCount,
    sourceBytes,
    projectedBytes,
    sha256,
    truncated,
  };
}

export function sanitizeMcpCompletionValue(value: string): string {
  return [...value.normalize('NFKC')]
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      if (codePoint < 32 || codePoint === 127) return false;
      return !UNSAFE_UNICODE.test(character);
    })
    .join('');
}

function validateIdentity(value: unknown, label: string, maximumBytes: number): string {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > maximumBytes) {
    throw new Error(`MCP ${label} is invalid`);
  }
  if (sanitizeMcpCompletionValue(value) !== value || hasControlCharacters(value)) {
    throw new Error(`MCP ${label} contains unsafe characters`);
  }
  if (isUnsafeProperty(value)) {
    throw new Error(`MCP ${label} is unsafe`);
  }
  return value;
}

function validateValue(value: unknown, label: string, maximumBytes: number): string {
  if (typeof value !== 'string' || Buffer.byteLength(value) > maximumBytes) {
    throw new Error(`MCP ${label} exceeds ${maximumBytes} bytes`);
  }
  if (hasControlCharacters(value)) {
    throw new Error(`MCP ${label} contains control characters`);
  }
  return value;
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127;
  });
}

function isUnsafeProperty(value: string): boolean {
  return ['__proto__', 'constructor', 'prototype'].includes(value);
}

function sliceUtf8(value: string, maximumBytes: number): string {
  const bytes = Buffer.from(value);
  if (bytes.length <= maximumBytes) return value;
  let result = bytes.subarray(0, Math.max(0, maximumBytes)).toString('utf8');
  while (Buffer.byteLength(result) > maximumBytes) {
    result = result.slice(0, -1);
  }
  return result;
}
