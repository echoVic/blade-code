import { createHash } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { Mutex } from 'async-mutex';
import writeFileAtomic from 'write-file-atomic';
import { getBladeStorageRoot } from '../context/storage/pathUtils.js';
import { resolveWorkspaceIdentity } from '../security/WorkspaceIdentity.js';
import { type Hook, type HookConfig, HookEvent, HookType } from './types/HookTypes.js';

const TRUST_FILE_VERSION = 1;
const MAX_TRUST_FILE_BYTES = 1024 * 1024;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

export type HookTrustState =
  | 'disabled'
  | 'not_required'
  | 'untrusted'
  | 'trusted'
  | 'modified'
  | 'error';

export interface HookTrustDefinition {
  event: HookEvent;
  matcher?: string;
  name?: string;
  type: Exclude<HookType, HookType.Function>;
  target: string;
  pluginName?: string;
  pluginSource?: 'cli' | 'project' | 'user';
}

export interface HookTrustStatus {
  projectPath: string;
  trustRoot: string;
  state: HookTrustState;
  enabled: boolean;
  configuredHooks: number;
  currentDigest: string | null;
  trustedDigest?: string;
  trustedAt?: string;
  error?: string;
  definitions: HookTrustDefinition[];
}

export class HookTrustDigestMismatchError extends Error {
  constructor() {
    super('Hook configuration changed after review; reload before trusting');
    this.name = 'HookTrustDigestMismatchError';
  }
}

interface HookTrustEntry {
  digest: string;
  trustedAt: string;
}

interface HookTrustFile {
  version: 1;
  projects: Record<string, HookTrustEntry>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function canonicalize(value: unknown): unknown {
  if (value === undefined || typeof value === 'function') return undefined;
  if (Array.isArray(value)) {
    return value.map(canonicalize).filter((entry) => entry !== undefined);
  }
  if (!isRecord(value)) return value;
  if (value.type === HookType.Function) return undefined;

  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const normalized = canonicalize(value[key]);
    if (normalized !== undefined) result[key] = normalized;
  }
  return result;
}

function externalHookConfig(config: HookConfig): Record<string, unknown> {
  const events: Record<string, unknown> = {};
  for (const event of Object.values(HookEvent)) {
    const matchers = config[event] ?? [];
    const normalized = matchers
      .map((matcher) =>
        canonicalize({
          ...matcher,
          hooks: matcher.hooks.map((hook) =>
            hook.source
              ? {
                  ...hook,
                  source: {
                    kind: hook.source.kind,
                    pluginName: hook.source.pluginName,
                    pluginSource: hook.source.pluginSource,
                  },
                }
              : hook
          ),
        })
      )
      .filter((matcher) => matcher !== undefined);
    if (normalized.length > 0) events[event] = normalized;
  }
  return {
    defaultTimeout: config.defaultTimeout,
    timeoutBehavior: config.timeoutBehavior,
    failureBehavior: config.failureBehavior,
    maxConcurrentHooks: config.maxConcurrentHooks,
    httpPolicy: canonicalize(config.httpPolicy ?? {}),
    events,
  };
}

function hookTarget(hook: Hook): string {
  if (hook.type === HookType.Command) return hook.command.slice(0, 2048);
  if (hook.type === HookType.Prompt) return hook.prompt.slice(0, 512);
  if (hook.type === HookType.Http) {
    try {
      const url = new URL(hook.url);
      return `${url.origin}${url.pathname}`.slice(0, 2048);
    } catch {
      return hook.url.slice(0, 2048);
    }
  }
  return 'in-process function';
}

export function listExternalHookDefinitions(config: HookConfig): HookTrustDefinition[] {
  const definitions: HookTrustDefinition[] = [];
  for (const event of Object.values(HookEvent)) {
    for (const matcher of config[event] ?? []) {
      const matcherValue = matcher.matcher
        ? JSON.stringify(canonicalize(matcher.matcher))
        : undefined;
      for (const hook of matcher.hooks) {
        if (hook.type === HookType.Function) continue;
        definitions.push({
          event,
          matcher: matcherValue,
          name: matcher.name,
          type: hook.type,
          target: hookTarget(hook),
          ...(hook.source
            ? {
                pluginName: hook.source.pluginName,
                pluginSource: hook.source.pluginSource,
              }
            : {}),
        });
      }
    }
  }
  return definitions;
}

export function getExternalHookDigest(config: HookConfig): string | null {
  if (listExternalHookDefinitions(config).length === 0) return null;
  const serialized = JSON.stringify(canonicalize(externalHookConfig(config)));
  return `sha256:${createHash('sha256').update(serialized).digest('hex')}`;
}

export class HookTrustService {
  private static instance: HookTrustService | null = null;
  private readonly mutex = new Mutex();
  private readonly filePath: string;

  constructor(filePath = path.join(getBladeStorageRoot(), 'hook-trust.json')) {
    this.filePath = filePath;
  }

  static getInstance(): HookTrustService {
    if (!HookTrustService.instance) {
      HookTrustService.instance = new HookTrustService();
    }
    return HookTrustService.instance;
  }

  static resetInstance(): void {
    HookTrustService.instance = null;
  }

  async getStatus(projectDir: string, config: HookConfig): Promise<HookTrustStatus> {
    const { projectPath, trustRoot } = await resolveWorkspaceIdentity(projectDir);
    const definitions = listExternalHookDefinitions(config);
    const currentDigest = getExternalHookDigest(config);
    const base = {
      projectPath,
      trustRoot,
      enabled: config.enabled === true,
      configuredHooks: definitions.length,
      currentDigest,
      definitions,
    };

    if (!config.enabled) return { ...base, state: 'disabled' };
    if (!currentDigest) return { ...base, state: 'not_required' };

    let store: HookTrustFile;
    try {
      store = await this.readStore();
    } catch (error) {
      return {
        ...base,
        state: 'error',
        error:
          error instanceof Error ? error.message : 'Hook trust store is unavailable',
      };
    }
    const entry = store.projects[trustRoot];
    if (!entry) return { ...base, state: 'untrusted' };
    return {
      ...base,
      state: entry.digest === currentDigest ? 'trusted' : 'modified',
      trustedDigest: entry.digest,
      trustedAt: entry.trustedAt,
    };
  }

  async trust(
    projectDir: string,
    config: HookConfig,
    expectedDigest?: string
  ): Promise<HookTrustStatus> {
    return this.mutex.runExclusive(async () => {
      const status = await this.getStatus(projectDir, config);
      if (!status.currentDigest) {
        throw new Error('No configured external hooks require trust');
      }
      if (expectedDigest !== undefined && expectedDigest !== status.currentDigest) {
        throw new HookTrustDigestMismatchError();
      }

      const store = await this.readStore();
      store.projects[status.trustRoot] = {
        digest: status.currentDigest,
        trustedAt: new Date().toISOString(),
      };
      await this.writeStore(store);
      return this.getStatus(projectDir, config);
    });
  }

  async revoke(projectDir: string, config: HookConfig): Promise<HookTrustStatus> {
    return this.mutex.runExclusive(async () => {
      const status = await this.getStatus(projectDir, config);
      const store = await this.readStore();
      if (status.trustRoot in store.projects) {
        delete store.projects[status.trustRoot];
        await this.writeStore(store);
      }
      return this.getStatus(projectDir, config);
    });
  }

  private async readStore(): Promise<HookTrustFile> {
    let handle;
    try {
      handle = await fs.open(this.filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: TRUST_FILE_VERSION, projects: {} };
      }
      throw new Error('Hook trust store must be a regular file');
    }

    let content: string;
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) {
        throw new Error('Hook trust store must be a regular file');
      }
      if (stat.size > MAX_TRUST_FILE_BYTES) {
        throw new Error('Hook trust store exceeds the maximum supported size');
      }
      if (process.getuid && stat.uid !== process.getuid()) {
        throw new Error('Hook trust store must be owned by the current user');
      }
      if ((stat.mode & 0o777) !== 0o600) {
        throw new Error('Hook trust store permissions must be 0600');
      }
      content = await handle.readFile('utf8');
    } finally {
      await handle.close();
    }

    const parsed = JSON.parse(content) as unknown;
    if (!isRecord(parsed) || parsed.version !== TRUST_FILE_VERSION) {
      throw new Error('Hook trust store version must be 1');
    }
    if (
      Object.keys(parsed).some((key) => key !== 'version' && key !== 'projects') ||
      !isRecord(parsed.projects)
    ) {
      throw new Error('Hook trust store contains unsupported fields');
    }

    const projects: Record<string, HookTrustEntry> = {};
    for (const [projectPath, value] of Object.entries(parsed.projects)) {
      if (
        !path.isAbsolute(projectPath) ||
        !isRecord(value) ||
        typeof value.digest !== 'string' ||
        !DIGEST_PATTERN.test(value.digest) ||
        typeof value.trustedAt !== 'string' ||
        !Number.isFinite(Date.parse(value.trustedAt)) ||
        Object.keys(value).some((key) => key !== 'digest' && key !== 'trustedAt')
      ) {
        throw new Error('Hook trust store contains an invalid project entry');
      }
      projects[projectPath] = {
        digest: value.digest,
        trustedAt: value.trustedAt,
      };
    }
    return { version: TRUST_FILE_VERSION, projects };
  }

  private async writeStore(store: HookTrustFile): Promise<void> {
    const directory = path.dirname(this.filePath);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.chmod(directory, 0o700);
    await writeFileAtomic(this.filePath, `${JSON.stringify(store, null, 2)}\n`, {
      mode: 0o600,
    });
    await fs.chmod(this.filePath, 0o600);
  }
}
