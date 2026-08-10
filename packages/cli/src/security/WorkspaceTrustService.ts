import { createHash } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Mutex } from 'async-mutex';
import writeFileAtomic from 'write-file-atomic';
import { getBladeStorageRoot } from '../context/storage/pathUtils.js';
import {
  resolveWorkspaceIdentity,
  type WorkspaceIdentity,
} from './WorkspaceIdentity.js';

const DECISION_VERSION = 1;
const MAX_DECISION_BYTES = 64 * 1024;
const MAX_PROJECT_CONFIG_BYTES = 1024 * 1024;
const MAX_REVIEW_ENTRIES = 100;

export type WorkspaceTrustState = 'not_required' | 'trusted' | 'untrusted' | 'error';

export type WorkspaceTrustEffectKind =
  | 'mcp'
  | 'lsp'
  | 'model'
  | 'permission'
  | 'environment'
  | 'plugin'
  | 'command'
  | 'skill'
  | 'agent'
  | 'instruction'
  | 'configuration';

export interface WorkspaceTrustEffect {
  kind: WorkspaceTrustEffectKind;
  name: string;
  target?: string;
}

export interface WorkspaceTrustSource {
  path: string;
  kind:
    | 'config'
    | 'settings'
    | 'plugins'
    | 'commands'
    | 'skills'
    | 'agents'
    | 'package'
    | 'instructions';
  keys: string[];
  effects: WorkspaceTrustEffect[];
  warning?: string;
}

export interface WorkspaceTrustStatus {
  projectPath: string;
  trustRoot: string;
  state: WorkspaceTrustState;
  trusted: boolean;
  sensitiveSources: number;
  sources: WorkspaceTrustSource[];
  decision: 'trusted' | 'untrusted' | 'inherited' | 'undecided';
  decidedAt?: string;
  inheritedFrom?: string;
  error?: string;
}

interface WorkspaceTrustDecision {
  version: 1;
  path: string;
  trusted: boolean;
  decidedAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function bounded(value: string, maximum = 2048): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

function safeUrlTarget(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    const url = new URL(value);
    return bounded(`${url.origin}${url.pathname}`);
  } catch {
    return bounded(value);
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function summarizeMcpServers(value: unknown): WorkspaceTrustEffect[] {
  if (!isRecord(value)) return [];
  return Object.entries(value)
    .slice(0, MAX_REVIEW_ENTRIES)
    .map(([name, raw]) => {
      const config = isRecord(raw) ? raw : {};
      const type = typeof config.type === 'string' ? config.type : 'unknown';
      const command = typeof config.command === 'string' ? config.command : undefined;
      const args = stringArray(config.args);
      const target =
        type === 'stdio'
          ? bounded([command, ...args].filter(Boolean).join(' '))
          : safeUrlTarget(config.url);
      return {
        kind: 'mcp' as const,
        name: `${name} (${type})`,
        ...(target ? { target } : {}),
      };
    });
}

function summarizeLspServers(value: unknown): WorkspaceTrustEffect[] {
  if (!isRecord(value)) return [];
  return Object.entries(value)
    .slice(0, MAX_REVIEW_ENTRIES)
    .map(([name, raw]) => {
      const config = isRecord(raw) ? raw : {};
      const command =
        typeof config.command === 'string' ? bounded(config.command) : undefined;
      const extensions = isRecord(config.extensionToLanguage)
        ? Object.keys(config.extensionToLanguage).slice(0, 12).join(', ')
        : 'unknown extensions';
      return {
        kind: 'lsp' as const,
        name: `${name} (${extensions})`,
        ...(command ? { target: command } : {}),
      };
    });
}

function summarizeModels(value: unknown): WorkspaceTrustEffect[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_REVIEW_ENTRIES).flatMap((raw) => {
    if (!isRecord(raw)) return [];
    const id = typeof raw.id === 'string' ? raw.id : 'unnamed';
    const provider = typeof raw.provider === 'string' ? raw.provider : 'unknown';
    const model = typeof raw.model === 'string' ? raw.model : 'unknown';
    const overrides = isRecord(raw.overrides) ? raw.overrides : {};
    const target = safeUrlTarget(overrides.baseUrl);
    return [
      {
        kind: 'model' as const,
        name: `${id}: ${provider}/${model}`,
        ...(target ? { target } : {}),
      },
    ];
  });
}

function summarizeProviders(value: unknown): WorkspaceTrustEffect[] {
  if (!isRecord(value)) return [];
  return Object.entries(value)
    .slice(0, MAX_REVIEW_ENTRIES)
    .map(([id, raw]) => {
      const config = isRecord(raw) ? raw : {};
      const wireApi = typeof config.wireApi === 'string' ? config.wireApi : 'unknown';
      const target = safeUrlTarget(config.baseUrl);
      return {
        kind: 'model' as const,
        name: `${id} (${wireApi})`,
        ...(target ? { target } : {}),
      };
    });
}

function summarizePermissions(value: unknown): WorkspaceTrustEffect[] {
  if (!isRecord(value)) return [];
  const effects: WorkspaceTrustEffect[] = [];
  for (const decision of ['allow', 'ask', 'deny'] as const) {
    for (const rule of stringArray(value[decision]).slice(0, MAX_REVIEW_ENTRIES)) {
      effects.push({
        kind: 'permission',
        name: `${decision}: ${bounded(rule, 512)}`,
      });
    }
  }
  return effects;
}

function summarizeConfigEffects(
  config: Record<string, unknown>
): WorkspaceTrustEffect[] {
  const effects = [
    ...summarizeMcpServers(config.mcpServers),
    ...summarizeLspServers(config.lspServers),
    ...summarizeModels(config.models),
    ...summarizeProviders(config.modelProviders),
    ...summarizePermissions(config.permissions),
  ];
  if (isRecord(config.env)) {
    for (const key of Object.keys(config.env).slice(0, MAX_REVIEW_ENTRIES)) {
      effects.push({ kind: 'environment', name: key });
    }
  }
  if (typeof config.permissionMode === 'string') {
    effects.push({
      kind: 'permission',
      name: `permissionMode: ${config.permissionMode}`,
    });
  }
  return effects;
}

function isSensitiveConfigKey(key: string): boolean {
  return key !== 'hooks' && key !== 'disableAllHooks';
}

function decisionHash(workspacePath: string): string {
  return createHash('sha256').update(workspacePath).digest('hex');
}

function isAncestor(ancestor: string, candidate: string): boolean {
  const relative = path.relative(ancestor, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  );
}

export class WorkspaceTrustService {
  private static instance: WorkspaceTrustService | null = null;
  private readonly mutex = new Mutex();
  private readonly statusCache = new Map<string, WorkspaceTrustStatus>();

  constructor(
    private readonly storeDir = path.join(getBladeStorageRoot(), 'workspace-trust')
  ) {}

  static getInstance(): WorkspaceTrustService {
    if (!WorkspaceTrustService.instance) {
      WorkspaceTrustService.instance = new WorkspaceTrustService();
    }
    return WorkspaceTrustService.instance;
  }

  static resetInstance(): void {
    WorkspaceTrustService.instance = null;
  }

  async getStatus(projectDir: string): Promise<WorkspaceTrustStatus> {
    const identity = await resolveWorkspaceIdentity(projectDir);
    let sources: WorkspaceTrustSource[];
    try {
      sources = await this.discoverSensitiveSources(identity.projectPath);
    } catch (error) {
      const status: WorkspaceTrustStatus = {
        ...identity,
        state: 'error',
        trusted: false,
        sensitiveSources: 0,
        sources: [],
        decision: 'undecided',
        error: error instanceof Error ? error.message : 'Workspace trust review failed',
      };
      this.cacheStatus(projectDir, status);
      return status;
    }

    if (sources.length === 0) {
      const status: WorkspaceTrustStatus = {
        ...identity,
        state: 'not_required',
        trusted: true,
        sensitiveSources: 0,
        sources,
        decision: 'undecided',
      };
      this.cacheStatus(projectDir, status);
      return status;
    }

    let decisions: WorkspaceTrustDecision[];
    try {
      decisions = await this.readDecisions();
    } catch (error) {
      const status: WorkspaceTrustStatus = {
        ...identity,
        state: 'error',
        trusted: false,
        sensitiveSources: sources.length,
        sources,
        decision: 'undecided',
        error:
          error instanceof Error
            ? error.message
            : 'Workspace trust store is unavailable',
      };
      this.cacheStatus(projectDir, status);
      return status;
    }

    const matching = decisions.filter((decision) =>
      isAncestor(decision.path, identity.trustRoot)
    );
    const maximumDepth = Math.max(
      -1,
      ...matching.map((decision) => decision.path.split(path.sep).length)
    );
    const mostSpecific = matching.filter(
      (decision) => decision.path.split(path.sep).length === maximumDepth
    );
    const trusted =
      mostSpecific.length > 0 && mostSpecific.every((decision) => decision.trusted);
    const winning = mostSpecific[0];
    const exact = winning?.path === identity.trustRoot;
    const status: WorkspaceTrustStatus = {
      ...identity,
      state: trusted ? 'trusted' : 'untrusted',
      trusted,
      sensitiveSources: sources.length,
      sources,
      decision: winning
        ? exact
          ? winning.trusted
            ? 'trusted'
            : 'untrusted'
          : 'inherited'
        : 'undecided',
      ...(winning?.decidedAt ? { decidedAt: winning.decidedAt } : {}),
      ...(!exact && winning?.path ? { inheritedFrom: winning.path } : {}),
    };
    this.cacheStatus(projectDir, status);
    return status;
  }

  private cacheStatus(projectDir: string, status: WorkspaceTrustStatus): void {
    this.statusCache.set(path.resolve(projectDir), status);
    this.statusCache.set(status.projectPath, status);
  }

  getCachedStatus(projectDir: string): WorkspaceTrustStatus | undefined {
    return this.statusCache.get(path.resolve(projectDir));
  }

  isTrustedCached(projectDir: string): boolean {
    const status = this.getCachedStatus(projectDir);
    return status?.state === 'trusted';
  }

  async trust(projectDir: string): Promise<WorkspaceTrustStatus> {
    return this.recordDecision(projectDir, true);
  }

  async revoke(projectDir: string): Promise<WorkspaceTrustStatus> {
    return this.recordDecision(projectDir, false);
  }

  private async recordDecision(
    projectDir: string,
    trusted: boolean
  ): Promise<WorkspaceTrustStatus> {
    return this.mutex.runExclusive(async () => {
      const identity = await resolveWorkspaceIdentity(projectDir);
      await this.assertSafeTrustRoot(identity);
      const decision: WorkspaceTrustDecision = {
        version: DECISION_VERSION,
        path: identity.trustRoot,
        trusted,
        decidedAt: new Date().toISOString(),
      };
      await this.writeDecision(decision);
      this.statusCache.clear();
      return this.getStatus(projectDir);
    });
  }

  private async assertSafeTrustRoot(identity: WorkspaceIdentity): Promise<void> {
    const root = path.parse(identity.trustRoot).root;
    const home = await fs
      .realpath(os.homedir())
      .catch(() => path.resolve(os.homedir()));
    if (
      !path.isAbsolute(identity.trustRoot) ||
      identity.trustRoot === root ||
      identity.trustRoot === home
    ) {
      throw new Error('Refusing to trust the filesystem root or user home directory');
    }
  }

  private async discoverSensitiveSources(
    projectPath: string
  ): Promise<WorkspaceTrustSource[]> {
    const sources: WorkspaceTrustSource[] = [];
    const packageScripts = await this.reviewPackageScripts(projectPath);
    if (packageScripts) sources.push(packageScripts);
    for (const [relativePath, kind] of [
      ['.blade/config.json', 'config'],
      ['.blade/settings.json', 'settings'],
      ['.blade/settings.local.json', 'settings'],
    ] as const) {
      const source = await this.reviewConfigFile(projectPath, relativePath, kind);
      if (source) sources.push(source);
    }
    for (const relativePath of ['.blade/plugins', '.claude/plugins']) {
      const source = await this.reviewResourceDirectory(
        projectPath,
        relativePath,
        'plugins',
        'plugin'
      );
      if (source) sources.push(source);
    }
    for (const relativePath of ['.blade/commands', '.claude/commands']) {
      const source = await this.reviewResourceDirectory(
        projectPath,
        relativePath,
        'commands',
        'command'
      );
      if (source) sources.push(source);
    }
    for (const [relativePath, kind, effectKind] of [
      ['.blade/skills', 'skills', 'skill'],
      ['.claude/skills', 'skills', 'skill'],
      ['.blade/agents', 'agents', 'agent'],
      ['.claude/agents', 'agents', 'agent'],
    ] as const) {
      const source = await this.reviewResourceDirectory(
        projectPath,
        relativePath,
        kind,
        effectKind
      );
      if (source) sources.push(source);
    }
    for (const relativePath of ['CLAUDE.md', 'AGENTS.md', 'BLADE.md']) {
      const source = await this.reviewInstructionFile(projectPath, relativePath);
      if (source) sources.push(source);
    }
    return sources;
  }

  private async reviewPackageScripts(
    projectPath: string
  ): Promise<WorkspaceTrustSource | undefined> {
    const filePath = path.join(projectPath, 'package.json');
    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    if (!stat.isFile()) return undefined;
    if (stat.size > MAX_PROJECT_CONFIG_BYTES) {
      throw new Error('package.json exceeds the 1 MiB workspace review limit');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
    } catch {
      return {
        path: 'package.json',
        kind: 'package',
        keys: [],
        effects: [],
        warning: 'Invalid package.json; project scripts will remain blocked',
      };
    }
    if (!isRecord(parsed) || !isRecord(parsed.scripts)) return undefined;
    const scriptsRecord = parsed.scripts;

    const scripts = Object.keys(scriptsRecord)
      .filter((name) => typeof scriptsRecord[name] === 'string')
      .sort()
      .slice(0, MAX_REVIEW_ENTRIES);
    if (scripts.length === 0) return undefined;
    return {
      path: 'package.json',
      kind: 'package',
      keys: scripts,
      effects: scripts.map((name) => ({
        kind: 'command',
        name: `package script: ${name}`,
      })),
    };
  }

  private async reviewInstructionFile(
    projectPath: string,
    relativePath: string
  ): Promise<WorkspaceTrustSource | undefined> {
    try {
      const stat = await fs.stat(path.join(projectPath, relativePath));
      if (!stat.isFile()) return undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    return {
      path: relativePath,
      kind: 'instructions',
      keys: [relativePath],
      effects: [{ kind: 'instruction', name: relativePath }],
    };
  }

  private async reviewConfigFile(
    projectPath: string,
    relativePath: string,
    kind: 'config' | 'settings'
  ): Promise<WorkspaceTrustSource | undefined> {
    const filePath = path.join(projectPath, relativePath);
    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    if (!stat.isFile()) return undefined;
    if (stat.size > MAX_PROJECT_CONFIG_BYTES) {
      throw new Error(`${relativePath} exceeds the 1 MiB workspace review limit`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
    } catch {
      return {
        path: relativePath,
        kind,
        keys: [],
        effects: [],
        warning: 'Invalid JSON; the file will remain blocked',
      };
    }
    if (!isRecord(parsed)) {
      return {
        path: relativePath,
        kind,
        keys: [],
        effects: [],
        warning: 'Configuration root is not an object',
      };
    }
    const keys = Object.keys(parsed).filter(isSensitiveConfigKey).sort();
    if (keys.length === 0) return undefined;
    const effects = summarizeConfigEffects(parsed);
    const covered = new Set([
      'mcpServers',
      'lspServers',
      'models',
      'modelProviders',
      'permissions',
      'env',
      'permissionMode',
    ]);
    for (const key of keys) {
      if (!covered.has(key)) {
        effects.push({ kind: 'configuration', name: key });
      }
    }
    return { path: relativePath, kind, keys, effects };
  }

  private async reviewResourceDirectory(
    projectPath: string,
    relativePath: string,
    kind: 'plugins' | 'commands' | 'skills' | 'agents',
    effectKind: 'plugin' | 'command' | 'skill' | 'agent'
  ): Promise<WorkspaceTrustSource | undefined> {
    const directory = path.join(projectPath, relativePath);
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    const resources = entries
      .filter((entry) =>
        kind === 'plugins' || kind === 'skills'
          ? entry.isDirectory() || entry.isSymbolicLink()
          : entry.isFile() || entry.isDirectory() || entry.isSymbolicLink()
      )
      .slice(0, MAX_REVIEW_ENTRIES);
    if (resources.length === 0) return undefined;
    return {
      path: relativePath,
      kind,
      keys: resources.map((entry) => entry.name),
      effects: resources.map((entry) => ({
        kind: effectKind,
        name: entry.name,
      })),
    };
  }

  private async readDecisions(): Promise<WorkspaceTrustDecision[]> {
    let directoryStat;
    try {
      directoryStat = await fs.lstat(this.storeDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      throw new Error('Workspace trust store must be a regular directory');
    }
    if (process.getuid && directoryStat.uid !== process.getuid()) {
      throw new Error('Workspace trust store must be owned by the current user');
    }
    if ((directoryStat.mode & 0o777) !== 0o700) {
      throw new Error('Workspace trust store permissions must be 0700');
    }

    const entries = await fs.readdir(this.storeDir, {
      withFileTypes: true,
    });
    const decisions: WorkspaceTrustDecision[] = [];
    for (const entry of entries) {
      if (!entry.name.endsWith('.json')) continue;
      if (!entry.isFile()) {
        throw new Error('Workspace trust store entries must be regular files');
      }
      decisions.push(await this.readDecision(path.join(this.storeDir, entry.name)));
    }
    return decisions;
  }

  private async readDecision(filePath: string): Promise<WorkspaceTrustDecision> {
    let handle;
    try {
      handle = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch {
      throw new Error('Workspace trust decision must be a regular file');
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_DECISION_BYTES) {
        throw new Error('Workspace trust decision is invalid');
      }
      if (process.getuid && stat.uid !== process.getuid()) {
        throw new Error('Workspace trust decisions must be owned by the current user');
      }
      if ((stat.mode & 0o777) !== 0o600) {
        throw new Error('Workspace trust decision permissions must be 0600');
      }
      const parsed = JSON.parse(await handle.readFile('utf8')) as unknown;
      if (
        !isRecord(parsed) ||
        parsed.version !== DECISION_VERSION ||
        typeof parsed.path !== 'string' ||
        !path.isAbsolute(parsed.path) ||
        typeof parsed.trusted !== 'boolean' ||
        typeof parsed.decidedAt !== 'string' ||
        !Number.isFinite(Date.parse(parsed.decidedAt)) ||
        Object.keys(parsed).some(
          (key) =>
            key !== 'version' &&
            key !== 'path' &&
            key !== 'trusted' &&
            key !== 'decidedAt'
        )
      ) {
        throw new Error('Workspace trust decision schema is invalid');
      }
      return {
        version: DECISION_VERSION,
        path: parsed.path,
        trusted: parsed.trusted,
        decidedAt: parsed.decidedAt,
      };
    } finally {
      await handle.close();
    }
  }

  private async writeDecision(decision: WorkspaceTrustDecision): Promise<void> {
    await this.ensureStoreDirectoryForWrite();
    const filePath = path.join(this.storeDir, `${decisionHash(decision.path)}.json`);
    try {
      const stat = await fs.lstat(filePath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error('Workspace trust decision must be a regular file');
      }
      if (process.getuid && stat.uid !== process.getuid()) {
        throw new Error('Workspace trust decisions must be owned by the current user');
      }
      if ((stat.mode & 0o777) !== 0o600) {
        throw new Error('Workspace trust decision permissions must be 0600');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await writeFileAtomic(filePath, `${JSON.stringify(decision, null, 2)}\n`, {
      mode: 0o600,
    });
    await fs.chmod(filePath, 0o600);
  }

  private async ensureStoreDirectoryForWrite(): Promise<void> {
    try {
      const stat = await fs.lstat(this.storeDir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error('Workspace trust store must be a regular directory');
      }
      if (process.getuid && stat.uid !== process.getuid()) {
        throw new Error('Workspace trust store must be owned by the current user');
      }
      if ((stat.mode & 0o777) !== 0o700) {
        throw new Error('Workspace trust store permissions must be 0700');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await fs.mkdir(this.storeDir, { recursive: true, mode: 0o700 });
      await fs.chmod(this.storeDir, 0o700);
    }
  }
}
