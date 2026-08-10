import type {
  ElicitRequestParams,
  ElicitResult,
} from '@modelcontextprotocol/sdk/types.js';
import { safeParseSchema, type TSchema, Type } from '../schema/index.js';

const MAX_MESSAGE_LENGTH = 4_000;
const MAX_URL_LENGTH = 4_096;
const MAX_FIELDS = 32;
const MAX_FIELD_NAME_LENGTH = 128;
const MAX_FIELD_TEXT_LENGTH = 1_000;
const MAX_OPTIONS = 100;
const MAX_CONTENT_BYTES = 64 * 1024;
const BLOCKED_FIELD_NAMES = new Set(['__proto__', 'constructor', 'prototype']);

export type McpElicitationAction = ElicitResult['action'];
export type McpElicitationContentValue = string | number | boolean | string[];
export type McpElicitationContent = Record<string, McpElicitationContentValue>;

export interface McpElicitationOption {
  value: string;
  label: string;
}

export interface McpElicitationField {
  name: string;
  type: 'string' | 'number' | 'integer' | 'boolean' | 'select' | 'multi-select';
  title: string;
  description?: string;
  required: boolean;
  defaultValue?: McpElicitationContentValue;
  options?: McpElicitationOption[];
  format?: 'date' | 'uri' | 'email' | 'date-time';
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
}

export interface McpElicitationDetails {
  serverName: string;
  mode: 'form' | 'url';
  message: string;
  fields?: McpElicitationField[];
  requestedSchema?: Record<string, unknown>;
  url?: string;
  domain?: string;
  elicitationId?: string;
}

export interface McpElicitationResponse {
  action: McpElicitationAction;
  content?: McpElicitationContent;
}

type RawFieldSchema = {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array';
  title?: string;
  description?: string;
  default?: unknown;
  enum?: string[];
  enumNames?: string[];
  oneOf?: Array<{ const: string; title: string }>;
  items?: {
    type?: 'string';
    enum?: string[];
    anyOf?: Array<{ const: string; title: string }>;
  };
  format?: 'date' | 'uri' | 'email' | 'date-time';
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
};

export function normalizeMcpElicitation(
  serverName: string,
  params: ElicitRequestParams
): McpElicitationDetails {
  if (!serverName.trim()) throw new Error('MCP elicitation server name is empty');
  if (!params.message.trim()) throw new Error('MCP elicitation message is empty');
  if (params.message.length > MAX_MESSAGE_LENGTH) {
    throw new Error(`MCP elicitation message exceeds ${MAX_MESSAGE_LENGTH} characters`);
  }

  if (params.mode === 'url') {
    const parsedUrl = parseSafeElicitationUrl(params.url);
    if (!params.elicitationId.trim()) {
      throw new Error('MCP URL elicitation ID is empty');
    }
    return {
      serverName,
      mode: 'url',
      message: params.message,
      url: parsedUrl.toString(),
      domain: parsedUrl.hostname,
      elicitationId: params.elicitationId,
    };
  }

  const entries = Object.entries(params.requestedSchema.properties);
  if (entries.length > MAX_FIELDS) {
    throw new Error(`MCP elicitation exceeds the ${MAX_FIELDS} field limit`);
  }
  const required = new Set(params.requestedSchema.required ?? []);
  for (const name of required) {
    if (!Object.hasOwn(params.requestedSchema.properties, name)) {
      throw new Error(`MCP elicitation requires an unknown field: ${name}`);
    }
  }

  return {
    serverName,
    mode: 'form',
    message: params.message,
    fields: entries.map(([name, schema]) =>
      normalizeField(name, schema as RawFieldSchema, required.has(name))
    ),
    requestedSchema: structuredClone(params.requestedSchema) as Record<string, unknown>,
  };
}

export function initialMcpElicitationContent(
  details: McpElicitationDetails
): McpElicitationContent {
  const content = Object.create(null) as McpElicitationContent;
  for (const field of details.fields ?? []) {
    if (field.defaultValue !== undefined) {
      content[field.name] = Array.isArray(field.defaultValue)
        ? [...field.defaultValue]
        : field.defaultValue;
    }
  }
  return content;
}

export function parseMcpElicitationInput(
  field: McpElicitationField,
  value: string
): McpElicitationContentValue | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    if (field.defaultValue !== undefined) return field.defaultValue;
    if (!field.required) return undefined;
    throw new Error(`${field.title} is required`);
  }

  if (field.type === 'number' || field.type === 'integer') {
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) {
      throw new Error(`${field.title} must be a finite number`);
    }
    if (field.type === 'integer' && !Number.isSafeInteger(parsed)) {
      throw new Error(`${field.title} must be a safe integer`);
    }
    return parsed;
  }

  if (field.type === 'boolean') {
    if (['true', 'yes', 'y', '1'].includes(trimmed.toLowerCase())) return true;
    if (['false', 'no', 'n', '0'].includes(trimmed.toLowerCase())) return false;
    throw new Error(`${field.title} must be true or false`);
  }

  return trimmed;
}

export function validateMcpElicitationResponse(
  details: McpElicitationDetails,
  response: McpElicitationResponse
): ElicitResult {
  if (response.action !== 'accept') {
    return { action: response.action };
  }
  if (details.mode === 'url') {
    return { action: 'accept' };
  }
  if (!details.requestedSchema) {
    throw new Error('MCP form elicitation schema is unavailable');
  }

  const content = response.content ?? {};
  if (Buffer.byteLength(JSON.stringify(content), 'utf8') > MAX_CONTENT_BYTES) {
    throw new Error(`MCP elicitation response exceeds ${MAX_CONTENT_BYTES} bytes`);
  }
  for (const key of Object.keys(content)) {
    assertSafeFieldName(key);
  }
  for (const value of Object.values(content)) {
    if (
      typeof value === 'number' &&
      (!Number.isFinite(value) ||
        (Number.isInteger(value) && !Number.isSafeInteger(value)))
    ) {
      throw new Error('MCP elicitation response contains an unsafe number');
    }
  }

  const schema = Type.Unsafe<McpElicitationContent>({
    ...details.requestedSchema,
    additionalProperties: false,
  } as TSchema);
  const parsed = safeParseSchema(schema, content);
  if (!parsed.success) {
    throw new Error(`Invalid MCP elicitation response: ${parsed.error.message}`);
  }
  return { action: 'accept', content: parsed.data };
}

function normalizeField(
  name: string,
  schema: RawFieldSchema,
  required: boolean
): McpElicitationField {
  assertSafeFieldName(name);
  const title = boundedText(schema.title?.trim() || name, 'field title');
  const description = schema.description
    ? boundedText(schema.description, 'field description')
    : undefined;
  const common = {
    name,
    title,
    description,
    required,
  };

  if (schema.type === 'boolean') {
    return {
      ...common,
      type: 'boolean',
      ...(typeof schema.default === 'boolean' ? { defaultValue: schema.default } : {}),
    };
  }

  if (schema.type === 'number' || schema.type === 'integer') {
    return {
      ...common,
      type: schema.type,
      ...(typeof schema.default === 'number' ? { defaultValue: schema.default } : {}),
      ...(schema.minimum !== undefined ? { minimum: schema.minimum } : {}),
      ...(schema.maximum !== undefined ? { maximum: schema.maximum } : {}),
    };
  }

  if (schema.type === 'array') {
    const options = normalizeArrayOptions(schema);
    return {
      ...common,
      type: 'multi-select',
      options,
      ...(Array.isArray(schema.default) &&
      schema.default.every((value) => typeof value === 'string')
        ? { defaultValue: [...schema.default] as string[] }
        : {}),
      ...(schema.minItems !== undefined ? { minItems: schema.minItems } : {}),
      ...(schema.maxItems !== undefined ? { maxItems: schema.maxItems } : {}),
    };
  }

  const options = normalizeStringOptions(schema);
  if (options) {
    return {
      ...common,
      type: 'select',
      options,
      ...(typeof schema.default === 'string' ? { defaultValue: schema.default } : {}),
    };
  }

  return {
    ...common,
    type: 'string',
    ...(typeof schema.default === 'string' ? { defaultValue: schema.default } : {}),
    ...(schema.format ? { format: schema.format } : {}),
    ...(schema.minLength !== undefined ? { minLength: schema.minLength } : {}),
    ...(schema.maxLength !== undefined ? { maxLength: schema.maxLength } : {}),
  };
}

function normalizeStringOptions(
  schema: RawFieldSchema
): McpElicitationOption[] | undefined {
  if (schema.oneOf) {
    return boundedOptions(
      schema.oneOf.map((option) => ({
        value: option.const,
        label: option.title,
      }))
    );
  }
  if (!schema.enum) return undefined;
  return boundedOptions(
    schema.enum.map((value, index) => ({
      value,
      label: schema.enumNames?.[index] ?? value,
    }))
  );
}

function normalizeArrayOptions(schema: RawFieldSchema): McpElicitationOption[] {
  if (schema.items?.anyOf) {
    return boundedOptions(
      schema.items.anyOf.map((option) => ({
        value: option.const,
        label: option.title,
      }))
    );
  }
  if (schema.items?.enum) {
    return boundedOptions(schema.items.enum.map((value) => ({ value, label: value })));
  }
  throw new Error('MCP multi-select elicitation is missing enum options');
}

function boundedOptions(options: McpElicitationOption[]): McpElicitationOption[] {
  if (options.length === 0 || options.length > MAX_OPTIONS) {
    throw new Error(`MCP elicitation options must contain 1-${MAX_OPTIONS} items`);
  }
  const values = new Set<string>();
  return options.map((option) => {
    if (values.has(option.value)) {
      throw new Error(`MCP elicitation contains duplicate option: ${option.value}`);
    }
    values.add(option.value);
    return {
      value: boundedText(option.value, 'option value'),
      label: boundedText(option.label, 'option label'),
    };
  });
}

function assertSafeFieldName(name: string): void {
  if (!name || name.length > MAX_FIELD_NAME_LENGTH || BLOCKED_FIELD_NAMES.has(name)) {
    throw new Error(`Unsafe MCP elicitation field name: ${name || '(empty)'}`);
  }
}

function boundedText(value: string, label: string): string {
  if (value.length > MAX_FIELD_TEXT_LENGTH) {
    throw new Error(
      `MCP elicitation ${label} exceeds ${MAX_FIELD_TEXT_LENGTH} characters`
    );
  }
  return value;
}

function parseSafeElicitationUrl(value: string): URL {
  if (value.length > MAX_URL_LENGTH) {
    throw new Error(`MCP elicitation URL exceeds ${MAX_URL_LENGTH} characters`);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('MCP elicitation URL is invalid');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`MCP elicitation URL protocol is not allowed: ${parsed.protocol}`);
  }
  if (parsed.username || parsed.password) {
    throw new Error('MCP elicitation URL must not contain credentials');
  }
  return parsed;
}
