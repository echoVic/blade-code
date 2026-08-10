import type { LspServerConfig } from './types.js';

const MAX_SERVERS = 32;
const MAX_EXTENSIONS = 64;
const MAX_ARGS = 128;
const MAX_JSON_BYTES = 256 * 1024;
const SERVER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const EXTENSION_PATTERN = /^\.[A-Za-z0-9_+-]{1,32}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function boundedInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
  fallback: number
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return Number(value);
}

function jsonValue(value: unknown, label: string): unknown {
  if (value === undefined) return undefined;
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error(`${label} must be JSON serializable`);
  }
  if (serialized === undefined || Buffer.byteLength(serialized) > MAX_JSON_BYTES) {
    throw new Error(`${label} exceeds the 256 KiB limit`);
  }
  return structuredClone(value);
}

function stringMap(value: unknown, label: string): Record<string, string> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!key || typeof item !== 'string' || item.includes('\0')) {
      throw new Error(`${label} must contain non-empty string values`);
    }
    result[key] = item;
  }
  return result;
}

export function normalizeLspServers(value: unknown): Record<string, LspServerConfig> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new Error('lspServers must be an object');
  const entries = Object.entries(value);
  if (entries.length > MAX_SERVERS) {
    throw new Error(`lspServers exceeds the ${MAX_SERVERS}-server limit`);
  }

  const servers: Record<string, LspServerConfig> = {};
  for (const [name, raw] of entries) {
    if (!SERVER_NAME_PATTERN.test(name)) {
      throw new Error(`Invalid LSP server name: ${name}`);
    }
    if (!isRecord(raw)) throw new Error(`lspServers.${name} must be an object`);
    const known = new Set([
      'command',
      'args',
      'extensionToLanguage',
      'env',
      'initializationOptions',
      'settings',
      'enabled',
      'priority',
      'startupTimeout',
      'shutdownTimeout',
      'requestTimeout',
      'diagnosticWaitTimeout',
      'maxRestarts',
    ]);
    const unknown = Object.keys(raw).filter((key) => !known.has(key));
    if (unknown.length > 0) {
      throw new Error(`Unknown LSP server field: ${name}.${unknown[0]}`);
    }

    if (
      typeof raw.command !== 'string' ||
      !raw.command.trim() ||
      raw.command.includes('\0') ||
      raw.command.includes('\n')
    ) {
      throw new Error(`lspServers.${name}.command must be a non-empty command`);
    }
    if (raw.args !== undefined && !Array.isArray(raw.args)) {
      throw new Error(`lspServers.${name}.args must be an array`);
    }
    const args = (raw.args ?? []).map((arg, index) => {
      if (typeof arg !== 'string' || arg.includes('\0')) {
        throw new Error(`lspServers.${name}.args.${index} must be a string`);
      }
      return arg;
    });
    if (args.length > MAX_ARGS) {
      throw new Error(`lspServers.${name}.args exceeds the ${MAX_ARGS}-item limit`);
    }

    if (!isRecord(raw.extensionToLanguage)) {
      throw new Error(`lspServers.${name}.extensionToLanguage must be an object`);
    }
    const extensionEntries = Object.entries(raw.extensionToLanguage);
    if (extensionEntries.length === 0 || extensionEntries.length > MAX_EXTENSIONS) {
      throw new Error(
        `lspServers.${name}.extensionToLanguage must contain 1-${MAX_EXTENSIONS} entries`
      );
    }
    const extensionToLanguage: Record<string, string> = {};
    for (const [rawExtension, language] of extensionEntries) {
      const extension = rawExtension.startsWith('.')
        ? rawExtension.toLowerCase()
        : `.${rawExtension.toLowerCase()}`;
      if (
        !EXTENSION_PATTERN.test(extension) ||
        typeof language !== 'string' ||
        !language.trim()
      ) {
        throw new Error(
          `Invalid lspServers.${name}.extensionToLanguage entry: ${rawExtension}`
        );
      }
      extensionToLanguage[extension] = language.trim();
    }
    if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') {
      throw new Error(`lspServers.${name}.enabled must be a boolean`);
    }

    const initializationOptions = jsonValue(
      raw.initializationOptions,
      `lspServers.${name}.initializationOptions`
    );
    const settings = jsonValue(raw.settings, `lspServers.${name}.settings`);
    servers[name] = {
      command: raw.command.trim(),
      ...(args.length > 0 ? { args } : {}),
      extensionToLanguage,
      ...(raw.env !== undefined
        ? { env: stringMap(raw.env, `lspServers.${name}.env`) }
        : {}),
      ...(initializationOptions !== undefined ? { initializationOptions } : {}),
      ...(settings !== undefined ? { settings } : {}),
      ...(raw.enabled !== undefined ? { enabled: raw.enabled } : {}),
      priority: boundedInteger(
        raw.priority,
        `lspServers.${name}.priority`,
        -1000,
        1000,
        0
      ),
      startupTimeout: boundedInteger(
        raw.startupTimeout,
        `lspServers.${name}.startupTimeout`,
        100,
        60_000,
        10_000
      ),
      shutdownTimeout: boundedInteger(
        raw.shutdownTimeout,
        `lspServers.${name}.shutdownTimeout`,
        100,
        10_000,
        2_000
      ),
      requestTimeout: boundedInteger(
        raw.requestTimeout,
        `lspServers.${name}.requestTimeout`,
        100,
        60_000,
        10_000
      ),
      diagnosticWaitTimeout: boundedInteger(
        raw.diagnosticWaitTimeout,
        `lspServers.${name}.diagnosticWaitTimeout`,
        0,
        5_000,
        750
      ),
      maxRestarts: boundedInteger(
        raw.maxRestarts,
        `lspServers.${name}.maxRestarts`,
        0,
        10,
        3
      ),
    };
  }
  return servers;
}
