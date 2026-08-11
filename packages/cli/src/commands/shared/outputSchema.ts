import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  createStructuredOutputContract,
  MAX_STRUCTURED_OUTPUT_SCHEMA_BYTES,
} from '../../services/StructuredOutputService.js';
import type { JsonObject } from '../../store/types.js';

export interface OutputSchemaCliOptions {
  jsonSchema?: string;
  outputSchema?: string;
}

function parseJsonSchema(raw: string, source: string): JsonObject {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON output schema from ${source}`, { cause: error });
  }
  return createStructuredOutputContract(value).schema;
}

export async function resolveCliOutputSchema(
  options: OutputSchemaCliOptions
): Promise<JsonObject | undefined> {
  if (options.jsonSchema !== undefined && options.outputSchema !== undefined) {
    throw new Error('--json-schema cannot be combined with --output-schema');
  }
  if (options.jsonSchema !== undefined) {
    return parseJsonSchema(options.jsonSchema, '--json-schema');
  }
  if (options.outputSchema === undefined) return undefined;

  const filePath = path.resolve(options.outputSchema);
  const file = await stat(filePath);
  if (!file.isFile()) {
    throw new Error(`Output schema path is not a regular file: ${filePath}`);
  }
  if (file.size > MAX_STRUCTURED_OUTPUT_SCHEMA_BYTES) {
    throw new Error(
      `Output schema exceeds ${MAX_STRUCTURED_OUTPUT_SCHEMA_BYTES} bytes: ${filePath}`
    );
  }
  return parseJsonSchema(await readFile(filePath, 'utf8'), filePath);
}
