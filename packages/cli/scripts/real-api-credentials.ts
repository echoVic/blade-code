import {
  existsSync,
  lstatSync,
  readFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const REAL_API_CREDENTIAL_FILE_ENV =
  'BLADE_REAL_API_CREDENTIALS_FILE';
export const DEFAULT_REAL_API_CREDENTIAL_FILE = path.join(
  os.homedir(),
  '.blade',
  'real-api-credentials.json'
);

const MAX_CREDENTIAL_FILE_BYTES = 64 * 1024;
const PROVIDER_PREFIXES = [
  'DEEPSEEK',
  'CLAUDE',
  'GPT',
  'DOMESTIC',
] as const;

type ProviderPrefix = (typeof PROVIDER_PREFIXES)[number];
type ProviderName = Lowercase<ProviderPrefix>;

interface CredentialEntry {
  apiKey: string;
  baseURL?: string;
  model?: string;
  models?: string[];
}

interface CredentialFile {
  version: 1;
  providers: Partial<Record<ProviderName, CredentialEntry>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readRequiredString(
  value: unknown,
  label: string,
  maximumLength = 16_384
): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  const normalized = value.trim();
  if (normalized.length > maximumLength) {
    throw new Error(`${label} exceeds the maximum supported length`);
  }
  return normalized;
}

function readOptionalString(
  value: unknown,
  label: string,
  maximumLength = 512
): string | undefined {
  if (value === undefined) return undefined;
  return readRequiredString(value, label, maximumLength);
}

function readBaseURL(value: unknown, label: string): string | undefined {
  const normalized = readOptionalString(value, label, 2_048);
  if (!normalized) return undefined;

  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new Error(`${label} must be an absolute HTTP(S) URL`);
  }
  const isLoopbackHttp =
    url.protocol === 'http:' &&
    ['127.0.0.1', '::1', 'localhost'].includes(url.hostname);
  if (url.protocol !== 'https:' && !isLoopbackHttp) {
    throw new Error(`${label} must use HTTPS unless it targets loopback`);
  }
  if (url.username || url.password) {
    throw new Error(`${label} must not contain embedded credentials`);
  }
  if (url.search || url.hash) {
    throw new Error(`${label} must not contain a query or fragment`);
  }
  return normalized;
}

function parseCredentialEntry(
  provider: ProviderName,
  value: unknown
): CredentialEntry {
  if (!isRecord(value)) {
    throw new Error(`Real API credential entry ${provider} must be an object`);
  }

  const allowedKeys = new Set(['apiKey', 'baseURL', 'model', 'models']);
  const unknownKeys = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unknownKeys.length > 0) {
    throw new Error(
      `Real API credential entry ${provider} contains unsupported fields: ` +
        unknownKeys.join(', ')
    );
  }

  const model = readOptionalString(
    value.model,
    `Real API credential ${provider}.model`
  );
  let models: string[] | undefined;
  if (value.models !== undefined) {
    if (provider !== 'deepseek') {
      throw new Error(
        `Real API credential ${provider}.models is only supported for deepseek`
      );
    }
    if (!Array.isArray(value.models) || value.models.length === 0) {
      throw new Error(
        'Real API credential deepseek.models must be a non-empty array'
      );
    }
    models = [
      ...new Set(
        value.models.map((candidate, index) =>
          readRequiredString(
            candidate,
            `Real API credential deepseek.models[${index}]`,
            512
          )
        )
      ),
    ];
    if (models.length > 32) {
      throw new Error(
        'Real API credential deepseek.models exceeds the supported limit'
      );
    }
  }

  return {
    apiKey: readRequiredString(
      value.apiKey,
      `Real API credential ${provider}.apiKey`
    ),
    baseURL: readBaseURL(
      value.baseURL,
      `Real API credential ${provider}.baseURL`
    ),
    model,
    models,
  };
}

function parseCredentialFile(content: string): CredentialFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error('Real API credential file must contain valid JSON');
  }
  if (!isRecord(parsed) || parsed.version !== 1) {
    throw new Error('Real API credential file version must be 1');
  }
  const topLevelKeys = Object.keys(parsed);
  if (
    topLevelKeys.some(
      (key) => key !== 'version' && key !== 'providers'
    )
  ) {
    throw new Error('Real API credential file contains unsupported fields');
  }
  if (!isRecord(parsed.providers)) {
    throw new Error('Real API credential file providers must be an object');
  }

  const allowedProviders = new Set<string>(
    PROVIDER_PREFIXES.map((prefix) => prefix.toLowerCase())
  );
  const unknownProviders = Object.keys(parsed.providers).filter(
    (provider) => !allowedProviders.has(provider)
  );
  if (unknownProviders.length > 0) {
    throw new Error(
      `Real API credential file contains unsupported providers: ` +
        unknownProviders.join(', ')
    );
  }

  const providers: CredentialFile['providers'] = {};
  for (const provider of allowedProviders) {
    const value = parsed.providers[provider];
    if (value === undefined) continue;
    const typedProvider = provider as ProviderName;
    providers[typedProvider] = parseCredentialEntry(typedProvider, value);
  }
  if (Object.keys(providers).length === 0) {
    throw new Error('Real API credential file must configure at least one provider');
  }

  return { version: 1, providers };
}

function hasInlineCredential(
  env: Readonly<Record<string, string | undefined>>
): boolean {
  return PROVIDER_PREFIXES.some((prefix) =>
    Boolean(env[`${prefix}_API_KEY`]?.trim())
  );
}

function resolveCredentialFile(
  env: Readonly<Record<string, string | undefined>>
): { explicit: boolean; filePath: string } | undefined {
  const configuredPath = env[REAL_API_CREDENTIAL_FILE_ENV]?.trim();
  if (configuredPath) {
    return {
      explicit: true,
      filePath: path.resolve(configuredPath),
    };
  }
  if (hasInlineCredential(env) || !existsSync(DEFAULT_REAL_API_CREDENTIAL_FILE)) {
    return undefined;
  }
  return {
    explicit: false,
    filePath: DEFAULT_REAL_API_CREDENTIAL_FILE,
  };
}

function assertCredentialFileSecurity(filePath: string): void {
  let stats;
  try {
    stats = lstatSync(filePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new Error(`Real API credential file does not exist: ${filePath}`);
    }
    throw error;
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error('Real API credential path must reference a regular file');
  }
  if (stats.size > MAX_CREDENTIAL_FILE_BYTES) {
    throw new Error('Real API credential file exceeds the supported size limit');
  }
  if (process.platform !== 'win32' && (stats.mode & 0o077) !== 0) {
    throw new Error('Real API credential file permissions must be 0600');
  }
  if (
    process.platform !== 'win32' &&
    typeof process.getuid === 'function' &&
    stats.uid !== process.getuid()
  ) {
    throw new Error('Real API credential file must be owned by the current user');
  }
}

export function loadRealApiCredentialEnvironment(
  env: Readonly<Record<string, string | undefined>> = process.env
): Record<string, string> {
  const resolved = resolveCredentialFile(env);
  if (!resolved) return {};
  if (!existsSync(resolved.filePath)) {
    if (!resolved.explicit) return {};
    throw new Error(
      `Real API credential file does not exist: ${resolved.filePath}`
    );
  }

  assertCredentialFileSecurity(resolved.filePath);
  const parsed = parseCredentialFile(
    readFileSync(resolved.filePath, 'utf8')
  );
  const projected: Record<string, string> = {};

  for (const prefix of PROVIDER_PREFIXES) {
    const provider = prefix.toLowerCase() as ProviderName;
    const credential = parsed.providers[provider];
    if (!credential) continue;
    projected[`${prefix}_API_KEY`] = credential.apiKey;
    if (credential.baseURL) {
      projected[`${prefix}_BASE_URL`] = credential.baseURL;
    }
    if (credential.model) {
      projected[`${prefix}_MODEL`] = credential.model;
    }
    if (credential.models) {
      projected[`${prefix}_MODELS`] = credential.models.join(',');
      projected[`${prefix}_MODEL`] ??= credential.models[0] ?? '';
    }
  }

  return projected;
}

export function materializeRealApiEnvironment(
  env: Readonly<Record<string, string | undefined>> = process.env
): Record<string, string | undefined> {
  const projected = loadRealApiCredentialEnvironment(env);
  const merged: Record<string, string | undefined> = { ...env };
  for (const [name, value] of Object.entries(projected)) {
    if (!Object.hasOwn(env, name)) merged[name] = value;
  }
  return merged;
}
