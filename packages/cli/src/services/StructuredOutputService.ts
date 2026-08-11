import { createHash } from 'node:crypto';
import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';
import type { JSONSchema7 } from 'json-schema';
import type { Message } from './ChatServiceInterface.js';
import type { JsonObject, JsonValue } from '../store/types.js';
import type { FunctionDeclaration } from '../tools/types/index.js';

export const STRUCTURED_OUTPUT_TOOL_NAME = 'StructuredOutput';
export const MAX_STRUCTURED_OUTPUT_SCHEMA_BYTES = 64 * 1024;
export const MAX_STRUCTURED_OUTPUT_BYTES = 128 * 1024;
export const MAX_STRUCTURED_OUTPUT_RETRIES = 2;

const MAX_SCHEMA_DEPTH = 20;
const MAX_SCHEMA_NODES = 1_000;
const MAX_SCHEMA_PROPERTIES = 200;

export interface StructuredOutputContract {
  schema: JsonObject;
  schemaDigest: string;
  declaration: FunctionDeclaration;
  validate(value: unknown): StructuredOutputValidationResult;
}

export type StructuredOutputValidationResult =
  | { success: true; output: JsonObject }
  | { success: false; message: string };

export interface RestoredStructuredOutput {
  output: JsonObject;
  completed: boolean;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cloneJsonObject(value: unknown, label: string): JsonObject {
  if (!isObject(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new Error(`${label} must be JSON-serializable`, { cause: error });
  }
  if (serialized === undefined) {
    throw new Error(`${label} must be JSON-serializable`);
  }
  const parsed = JSON.parse(serialized) as unknown;
  if (!isObject(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return parsed as JsonObject;
}

function inspectSchema(schema: JsonObject): void {
  let nodes = 0;
  let properties = 0;

  const visit = (value: JsonValue, depth: number): void => {
    nodes++;
    if (nodes > MAX_SCHEMA_NODES) {
      throw new Error(
        `Output schema exceeds the ${MAX_SCHEMA_NODES} node complexity limit`
      );
    }
    if (depth > MAX_SCHEMA_DEPTH) {
      throw new Error(
        `Output schema exceeds the ${MAX_SCHEMA_DEPTH} level depth limit`
      );
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (!isObject(value)) return;

    if ('$ref' in value) {
      const ref = value.$ref;
      if (
        typeof ref !== 'string' ||
        !(ref === '#' || ref.startsWith('#/$defs/') || ref.startsWith('#/definitions/'))
      ) {
        throw new Error('Output schema only supports self-contained local $ref values');
      }
    }
    if ('properties' in value && isObject(value.properties)) {
      properties += Object.keys(value.properties).length;
      if (properties > MAX_SCHEMA_PROPERTIES) {
        throw new Error(
          `Output schema exceeds the ${MAX_SCHEMA_PROPERTIES} property limit`
        );
      }
    }
    for (const child of Object.values(value)) visit(child as JsonValue, depth + 1);
  };

  visit(schema, 0);
}

function validationMessage(errors: ErrorObject[] | null | undefined): string {
  if (!errors || errors.length === 0) {
    return 'Structured output does not match the requested schema';
  }
  return errors
    .slice(0, 8)
    .map((error) => {
      const path = error.instancePath || 'root';
      return `${path}: ${error.message ?? error.keyword}`;
    })
    .join('; ');
}

function compile(schema: JsonObject): ValidateFunction {
  const ajv = new Ajv({
    allErrors: true,
    strict: false,
    allowUnionTypes: true,
    validateFormats: false,
  });
  try {
    return ajv.compile(schema);
  } catch (error) {
    throw new Error(
      `Invalid output schema: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export function createStructuredOutputContract(
  input: unknown
): StructuredOutputContract {
  const schema = cloneJsonObject(input, 'Output schema');
  const serializedSchema = JSON.stringify(schema);
  const schemaBytes = Buffer.byteLength(serializedSchema);
  if (schemaBytes > MAX_STRUCTURED_OUTPUT_SCHEMA_BYTES) {
    throw new Error(
      `Output schema exceeds ${MAX_STRUCTURED_OUTPUT_SCHEMA_BYTES} bytes`
    );
  }
  if (schema.type !== 'object') {
    throw new Error('Output schema root type must be "object"');
  }
  inspectSchema(schema);
  const validator = compile(schema);
  const schemaDigest = createHash('sha256').update(serializedSchema).digest('hex');

  return {
    schema,
    schemaDigest,
    declaration: {
      name: STRUCTURED_OUTPUT_TOOL_NAME,
      description:
        'Submit the final response as an object matching the requested JSON Schema. ' +
        'Call this exactly once after all requested work and verification are complete.',
      parameters: schema as JSONSchema7,
      constrainedSampling: {
        type: 'json_schema',
        strict: 'prefer',
      },
    },
    validate(value: unknown): StructuredOutputValidationResult {
      let output: JsonObject;
      try {
        output = cloneJsonObject(value, 'Structured output');
      } catch (error) {
        return {
          success: false,
          message: error instanceof Error ? error.message : String(error),
        };
      }
      const serializedOutput = JSON.stringify(output);
      if (Buffer.byteLength(serializedOutput) > MAX_STRUCTURED_OUTPUT_BYTES) {
        return {
          success: false,
          message: `Structured output exceeds ${MAX_STRUCTURED_OUTPUT_BYTES} bytes`,
        };
      }
      if (!validator(output)) {
        return { success: false, message: validationMessage(validator.errors) };
      }
      return { success: true, output };
    },
  };
}

export function isStructuredOutputSchema(value: unknown): value is JsonObject {
  try {
    createStructuredOutputContract(value);
    return true;
  } catch {
    return false;
  }
}

function outputFromMetadata(
  value: unknown,
  contract: StructuredOutputContract
): JsonObject | undefined {
  if (!isObject(value)) return undefined;
  const candidate = isObject(value.structuredOutput) ? value.structuredOutput : value;
  if (candidate.schemaDigest !== contract.schemaDigest || !('output' in candidate)) {
    return undefined;
  }
  const validation = contract.validate(candidate.output);
  return validation.success ? validation.output : undefined;
}

export function restoreStructuredOutput(
  messages: readonly Message[],
  contract: StructuredOutputContract
): RestoredStructuredOutput | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!message) continue;
    if (message.role === 'user') return undefined;
    if (message.role === 'assistant') {
      const output = outputFromMetadata(message.metadata, contract);
      if (output) return { output, completed: true };
      continue;
    }
    if (message.role !== 'tool' || message.name !== STRUCTURED_OUTPUT_TOOL_NAME) {
      continue;
    }
    const outer = isObject(message.metadata) ? message.metadata : undefined;
    const output = outputFromMetadata(outer?.metadata, contract);
    if (output) return { output, completed: false };
  }
  return undefined;
}
