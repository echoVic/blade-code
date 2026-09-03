import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { Mutex } from 'async-mutex';
import { satisfies } from 'semver';
import writeFileAtomic from 'write-file-atomic';
import { DEFAULT_CONFIG } from '../config/defaults.js';
import type { PluginSourcePolicy } from '../config/types.js';
import { normalizeLocalWorkspacePath } from '../context/storage/pathUtils.js';
import { logger } from '../logging/Logger.js';
import { assertBladeVersionCompatible } from './PluginCompatibility.js';
import { parsePluginManifest } from './PluginManifest.js';
import {
  assertMarketplaceSourceAllowed,
  assertPluginSourceAllowed,
  PluginSourcePolicyError,
} from './PluginSourcePolicy.js';
import {
  validatePluginMarketplaceManifest,
  validatePluginPackageState,
} from './schemas.js';
import type {
  InstalledPluginRecord,
  PluginInstallSource,
  PluginManifest,
  PluginMarketplaceManifest,
  PluginMarketplaceRecord,
  PluginMarketplaceSource,
  PluginPackageState,
} from './types.js';

const execFileAsync = promisify(execFile);
const STORE_VERSION = 1 as const;
const MAX_STATE_BYTES = 2 * 1024 * 1024;
const MAX_PACKAGE_FILES = 10_000;
const MAX_PACKAGE_BYTES = 100 * 1024 * 1024;
const GIT_TIMEOUT_MS = 120_000;
const STORE_LOCK_TIMEOUT_MS = 15_000;
const STORE_LOCK_STALE_MS = 10 * 60_000;
const PLUGIN_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$|^[a-z0-9]$/;
const FULL_GIT_SHA_PATTERN = /^[a-fA-F0-9]{40}$/;
const MARKETPLACE_MANIFEST_PATHS = [
  path.join('.blade-plugin', 'marketplace.json'),
  path.join('.claude-plugin', 'marketplace.json'),
  'marketplace.json',
];

export interface PluginInstallOptions {
  trusted?: boolean;
  workspaceRoot?: string;
  ref?: string;
  policy?: PluginSourcePolicy;
}

export interface PluginInstallResult {
  success: boolean;
  pluginName?: string;
  pluginPath?: string;
  manifest?: PluginManifest;
  installation?: InstalledPluginRecord;
  changed?: boolean;
  installedDependencies?: string[];
  updatedDependencies?: string[];
  code?: string;
  error?: string;
}

export interface PluginUninstallResult {
  success: boolean;
  pluginName: string;
  installation?: InstalledPluginRecord;
  code?: string;
  error?: string;
}

export interface PluginMarketplaceResult {
  success: boolean;
  marketplace?: PluginMarketplaceRecord;
  manifest?: PluginMarketplaceManifest;
  changed?: boolean;
  code?: string;
  error?: string;
}

export interface PluginCatalog {
  marketplace: PluginMarketplaceRecord;
  manifest: PluginMarketplaceManifest;
}

interface MaterializedSource {
  stagingPath: string;
  revision: string;
  contentDigest: string;
}

interface PreparedPlugin {
  name: string;
  source: PluginInstallSource;
  manifest: PluginManifest;
  materialized: MaterializedSource;
  existing?: InstalledPluginRecord;
}

class PluginPackageError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'PluginPackageError';
  }
}

function emptyState(): PluginPackageState {
  return {
    version: STORE_VERSION,
    installed: {},
    marketplaces: {},
  };
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function errorDetails(error: unknown): { code: string; message: string } {
  if (error instanceof PluginPackageError || error instanceof PluginSourcePolicyError) {
    return { code: error.code, message: error.message };
  }
  return {
    code: 'PLUGIN_PACKAGE_ERROR',
    message: error instanceof Error ? error.message : String(error),
  };
}

function isPathSource(source: string): boolean {
  return (
    path.isAbsolute(source) ||
    source.startsWith('./') ||
    source.startsWith('../') ||
    source === '~' ||
    source.startsWith('~/')
  );
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function assertPluginName(name: string, label = 'plugin'): string {
  if (!PLUGIN_NAME_PATTERN.test(name)) {
    throw new PluginPackageError(
      'INVALID_PLUGIN_NAME',
      `Invalid ${label} name: ${name}`
    );
  }
  return name;
}

function parsePluginIdentifier(
  value: string
): { pluginName: string; marketplace: string } | undefined {
  if (value.startsWith('git@')) return undefined;
  const separator = value.lastIndexOf('@');
  if (separator <= 0 || separator === value.length - 1) return undefined;
  const pluginName = value.slice(0, separator);
  const marketplace = value.slice(separator + 1);
  if (!PLUGIN_NAME_PATTERN.test(pluginName) || !PLUGIN_NAME_PATTERN.test(marketplace)) {
    return undefined;
  }
  return { pluginName, marketplace };
}

export class PluginInstaller {
  private readonly userPluginsDir: string;
  private readonly stateRoot: string;
  private readonly statePath: string;
  private readonly mutex = new Mutex();

  constructor(userPluginsDir?: string, stateRoot?: string) {
    this.userPluginsDir = userPluginsDir ?? path.join(homedir(), '.blade', 'plugins');
    this.stateRoot =
      stateRoot ?? path.join(path.dirname(this.userPluginsDir), 'plugin-state');
    this.statePath = path.join(this.stateRoot, 'state.json');
  }

  async install(
    source: string,
    options: PluginInstallOptions = {}
  ): Promise<PluginInstallResult> {
    return this.runMutation(async () => {
      let prepared: PreparedPlugin[] = [];
      try {
        this.requireSourceTrust(options.trusted);
        const state = await this.readState();
        const resolved = await this.resolvePluginSource(source, state, options);
        const policy = this.effectivePolicy(options.policy);
        assertPluginSourceAllowed(policy, resolved.recordSource, state.marketplaces);
        if (resolved.expectedName && state.installed[resolved.expectedName]) {
          throw new PluginPackageError(
            'PLUGIN_ALREADY_INSTALLED',
            `Plugin "${resolved.expectedName}" is already installed`
          );
        }
        const closure = await this.preparePluginClosure({
          state,
          source: resolved.source,
          recordSource: resolved.recordSource,
          expectedName: resolved.expectedName,
          policy,
          updateRoot: false,
        });
        prepared = closure.prepared;
        const committed = await this.commitPreparedPlugins(state, prepared);
        const installation = committed.records.get(closure.root.name);
        if (!installation) {
          throw new PluginPackageError(
            'PLUGIN_PACKAGE_ERROR',
            'Root plugin was not committed'
          );
        }
        const installedDependencies = prepared
          .map((plugin) => plugin.name)
          .filter((name) => name !== closure.root.name);
        logger.info(
          `Installed managed plugin ${closure.root.name} at revision ${installation.revision}`
        );
        return {
          success: true,
          pluginName: closure.root.name,
          pluginPath: installation.installPath,
          manifest: closure.root.manifest,
          installation,
          installedDependencies,
          changed: committed.changed.has(closure.root.name),
        };
      } catch (error) {
        await this.cleanupPreparedPlugins(prepared);
        const details = errorDetails(error);
        return { success: false, code: details.code, error: details.message };
      }
    });
  }

  async update(
    name: string,
    options: PluginInstallOptions = {}
  ): Promise<PluginInstallResult> {
    return this.runMutation(async () => {
      let prepared: PreparedPlugin[] = [];
      try {
        this.requireSourceTrust(options.trusted);
        assertPluginName(name);
        const state = await this.readState();
        const current = state.installed[name];
        if (!current) {
          throw new PluginPackageError(
            'PLUGIN_NOT_MANAGED',
            `Plugin "${name}" is not managed by Blade's package store`
          );
        }
        const policy = this.effectivePolicy(options.policy);
        assertPluginSourceAllowed(policy, current.source, state.marketplaces);
        const closure = await this.preparePluginClosure({
          state,
          source: current.source,
          recordSource: current.source,
          expectedName: name,
          policy,
          updateRoot: true,
        });
        prepared = closure.prepared;
        const committed = await this.commitPreparedPlugins(state, prepared);
        const installation = committed.records.get(name);
        if (!installation) {
          throw new PluginPackageError(
            'PLUGIN_PACKAGE_ERROR',
            'Updated root plugin was not committed'
          );
        }
        const updatedDependencies = prepared
          .map((plugin) => plugin.name)
          .filter(
            (pluginName) => pluginName !== name && committed.changed.has(pluginName)
          );
        logger.info(
          `Updated managed plugin ${name} to revision ${installation.revision}`
        );
        return {
          success: true,
          pluginName: name,
          pluginPath: installation.installPath,
          manifest: closure.root.manifest,
          installation,
          updatedDependencies,
          changed: committed.changed.has(name),
        };
      } catch (error) {
        await this.cleanupPreparedPlugins(prepared);
        const details = errorDetails(error);
        return {
          success: false,
          pluginName: name,
          code: details.code,
          error: details.message,
        };
      }
    });
  }

  async uninstall(name: string, confirmed = false): Promise<PluginUninstallResult> {
    return this.runMutation(async () => {
      try {
        assertPluginName(name);
        if (!confirmed) {
          throw new PluginPackageError(
            'CONFIRMATION_REQUIRED',
            `Uninstalling "${name}" requires explicit confirmation`
          );
        }
        const state = await this.readState();
        const installation = state.installed[name];
        if (!installation) {
          throw new PluginPackageError(
            'PLUGIN_NOT_MANAGED',
            `Plugin "${name}" is not managed by Blade's package store`
          );
        }
        delete state.installed[name];
        await this.writeState(state);
        logger.info(`Uninstalled managed plugin ${name}`);
        return { success: true, pluginName: name, installation };
      } catch (error) {
        const details = errorDetails(error);
        return {
          success: false,
          pluginName: name,
          code: details.code,
          error: details.message,
        };
      }
    });
  }

  async listInstalled(): Promise<string[]> {
    return Object.keys((await this.readState()).installed).sort();
  }

  async listInstallationRecords(): Promise<InstalledPluginRecord[]> {
    return Object.values((await this.readState()).installed).sort((left, right) =>
      left.name.localeCompare(right.name)
    );
  }

  async getInstallation(name: string): Promise<InstalledPluginRecord | undefined> {
    return (await this.readState()).installed[name];
  }

  async verifyInstallation(record: InstalledPluginRecord): Promise<void> {
    const stat = await fs.lstat(record.installPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new PluginPackageError(
        'PLUGIN_PACKAGE_TAMPERED',
        `Managed plugin "${record.name}" has an invalid package path`
      );
    }
    const realStoreRoot = await fs.realpath(this.stateRoot);
    const realPath = await fs.realpath(record.installPath);
    if (!isWithin(realStoreRoot, realPath)) {
      throw new PluginPackageError(
        'PLUGIN_PACKAGE_TAMPERED',
        `Managed plugin "${record.name}" has an invalid package path`
      );
    }
    const digest = await this.digestTree(realPath);
    if (digest !== record.contentDigest) {
      throw new PluginPackageError(
        'PLUGIN_PACKAGE_TAMPERED',
        `Managed plugin "${record.name}" failed content verification`
      );
    }
    const manifest = await parsePluginManifest(realPath);
    if (
      !manifest ||
      manifest.manifest.name !== record.name ||
      manifest.manifest.version !== record.version
    ) {
      throw new PluginPackageError(
        'PLUGIN_PACKAGE_TAMPERED',
        `Managed plugin "${record.name}" failed manifest verification`
      );
    }
  }

  async addMarketplace(
    source: string,
    options: Pick<PluginInstallOptions, 'workspaceRoot' | 'ref' | 'policy'> = {}
  ): Promise<PluginMarketplaceResult> {
    return this.runMutation(async () => {
      let materialized: MaterializedSource | undefined;
      try {
        const normalizedSource = await this.normalizeMarketplaceSource(source, options);
        assertMarketplaceSourceAllowed(
          this.effectivePolicy(options.policy),
          normalizedSource
        );
        const state = await this.readState();
        materialized = await this.materializeSource(normalizedSource);
        const manifest = await this.readMarketplaceManifest(materialized.stagingPath);
        const name = assertPluginName(manifest.name, 'marketplace');
        if (state.marketplaces[name]) {
          throw new PluginPackageError(
            'MARKETPLACE_ALREADY_EXISTS',
            `Marketplace "${name}" is already configured`
          );
        }
        const revision = materialized.revision;
        const contentDigest = materialized.contentDigest;
        const installPath = await this.publishPackage(
          'marketplaces',
          name,
          materialized
        );
        materialized = undefined;
        const now = new Date().toISOString();
        const marketplace: PluginMarketplaceRecord = {
          name,
          source: normalizedSource,
          installPath,
          revision,
          contentDigest,
          addedAt: now,
          updatedAt: now,
        };
        state.marketplaces[name] = marketplace;
        await this.writeState(state);
        return { success: true, marketplace, manifest, changed: true };
      } catch (error) {
        if (materialized) {
          await fs.rm(materialized.stagingPath, { recursive: true, force: true });
        }
        const details = errorDetails(error);
        return { success: false, code: details.code, error: details.message };
      }
    });
  }

  async refreshMarketplace(
    name: string,
    policy?: PluginSourcePolicy
  ): Promise<PluginMarketplaceResult> {
    return this.runMutation(async () => {
      let materialized: MaterializedSource | undefined;
      try {
        assertPluginName(name, 'marketplace');
        const state = await this.readState();
        const current = state.marketplaces[name];
        if (!current) {
          throw new PluginPackageError(
            'MARKETPLACE_NOT_FOUND',
            `Marketplace "${name}" is not configured`
          );
        }
        assertMarketplaceSourceAllowed(
          this.effectivePolicy(policy),
          current.source,
          `Marketplace "${name}"`
        );
        materialized = await this.materializeSource(current.source);
        const manifest = await this.readMarketplaceManifest(materialized.stagingPath);
        if (manifest.name !== name) {
          throw new PluginPackageError(
            'MARKETPLACE_IDENTITY_MISMATCH',
            `Marketplace "${name}" now declares "${manifest.name}"`
          );
        }
        if (
          current.revision === materialized.revision &&
          current.contentDigest === materialized.contentDigest
        ) {
          await fs.rm(materialized.stagingPath, { recursive: true, force: true });
          materialized = undefined;
          return {
            success: true,
            marketplace: current,
            manifest,
            changed: false,
          };
        }
        const revision = materialized.revision;
        const contentDigest = materialized.contentDigest;
        const installPath = await this.publishPackage(
          'marketplaces',
          name,
          materialized
        );
        materialized = undefined;
        const marketplace: PluginMarketplaceRecord = {
          ...current,
          installPath,
          revision,
          contentDigest,
          updatedAt: new Date().toISOString(),
        };
        state.marketplaces[name] = marketplace;
        await this.writeState(state);
        return { success: true, marketplace, manifest, changed: true };
      } catch (error) {
        if (materialized) {
          await fs.rm(materialized.stagingPath, { recursive: true, force: true });
        }
        const details = errorDetails(error);
        return {
          success: false,
          code: details.code,
          error: details.message,
        };
      }
    });
  }

  async removeMarketplace(
    name: string,
    confirmed = false
  ): Promise<PluginMarketplaceResult> {
    return this.runMutation(async () => {
      try {
        assertPluginName(name, 'marketplace');
        if (!confirmed) {
          throw new PluginPackageError(
            'CONFIRMATION_REQUIRED',
            `Removing marketplace "${name}" requires explicit confirmation`
          );
        }
        const state = await this.readState();
        const marketplace = state.marketplaces[name];
        if (!marketplace) {
          throw new PluginPackageError(
            'MARKETPLACE_NOT_FOUND',
            `Marketplace "${name}" is not configured`
          );
        }
        const dependents = Object.values(state.installed)
          .filter(
            (plugin) =>
              plugin.source.type === 'marketplace' && plugin.source.marketplace === name
          )
          .map((plugin) => plugin.name)
          .sort();
        if (dependents.length > 0) {
          throw new PluginPackageError(
            'MARKETPLACE_IN_USE',
            `Marketplace "${name}" still owns installed plugins: ${dependents.join(', ')}`
          );
        }
        delete state.marketplaces[name];
        await this.writeState(state);
        return { success: true, marketplace, changed: true };
      } catch (error) {
        const details = errorDetails(error);
        return { success: false, code: details.code, error: details.message };
      }
    });
  }

  async listMarketplaces(): Promise<PluginMarketplaceRecord[]> {
    return Object.values((await this.readState()).marketplaces).sort((left, right) =>
      left.name.localeCompare(right.name)
    );
  }

  async listCatalogs(): Promise<PluginCatalog[]> {
    const marketplaces = await this.listMarketplaces();
    return Promise.all(
      marketplaces.map(async (marketplace) => ({
        marketplace,
        manifest: await this.readMarketplaceManifest(marketplace.installPath),
      }))
    );
  }

  private async runMutation<T>(operation: () => Promise<T>): Promise<T> {
    return this.mutex.runExclusive(async () => {
      const release = await this.acquireStoreLock();
      try {
        return await operation();
      } finally {
        await release();
      }
    });
  }

  private async acquireStoreLock(): Promise<() => Promise<void>> {
    await this.ensureStoreDirectory();
    const lockPath = path.join(this.stateRoot, '.operation.lock');
    const token = randomUUID();
    const deadline = Date.now() + STORE_LOCK_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        const handle = await fs.open(
          lockPath,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
          0o600
        );
        await handle.writeFile(
          `${JSON.stringify({
            version: 1,
            pid: process.pid,
            token,
            createdAt: new Date().toISOString(),
          })}\n`,
          'utf8'
        );
        await handle.close();
        return async () => {
          try {
            const owner = JSON.parse(await fs.readFile(lockPath, 'utf8')) as {
              token?: unknown;
            };
            if (owner.token === token) await fs.unlink(lockPath);
          } catch (error) {
            if (!isMissing(error)) {
              logger.warn(`Failed to release plugin package lock: ${error}`);
            }
          }
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        await this.removeStaleStoreLock(lockPath);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    throw new PluginPackageError(
      'PLUGIN_STORE_BUSY',
      'Plugin package store is busy; retry the operation'
    );
  }

  private async removeStaleStoreLock(lockPath: string): Promise<void> {
    try {
      const stat = await fs.lstat(lockPath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new PluginPackageError(
          'PLUGIN_STORE_INVALID',
          'Plugin package lock must be a regular file'
        );
      }
      if (
        (process.getuid && stat.uid !== process.getuid()) ||
        (stat.mode & 0o777) !== 0o600
      ) {
        throw new PluginPackageError(
          'PLUGIN_STORE_INVALID',
          'Plugin package lock ownership or permissions are invalid'
        );
      }
      if (Date.now() - stat.mtimeMs < STORE_LOCK_STALE_MS) return;
      await fs.unlink(lockPath);
    } catch (error) {
      if (!isMissing(error) && error instanceof PluginPackageError) throw error;
    }
  }

  private requireSourceTrust(trusted: boolean | undefined): void {
    if (trusted !== true) {
      throw new PluginPackageError(
        'SOURCE_TRUST_REQUIRED',
        'Plugin installation or update requires explicit source trust'
      );
    }
  }

  private effectivePolicy(policy: PluginSourcePolicy | undefined): PluginSourcePolicy {
    return policy ?? DEFAULT_CONFIG.pluginSourcePolicy;
  }

  private async preparePluginClosure(options: {
    state: PluginPackageState;
    source: PluginInstallSource;
    recordSource: PluginInstallSource;
    expectedName?: string;
    policy: PluginSourcePolicy;
    updateRoot: boolean;
  }): Promise<{ root: PreparedPlugin; prepared: PreparedPlugin[] }> {
    const prepared: PreparedPlugin[] = [];
    const preparedByName = new Map<string, PreparedPlugin>();
    const stack: string[] = [];

    const assertRange = (
      dependency: string,
      version: string,
      range: string,
      requiredBy: string
    ) => {
      if (!satisfies(version, range)) {
        throw new PluginPackageError(
          'DEPENDENCY_VERSION_MISMATCH',
          `Plugin "${requiredBy}" requires ${dependency}@${range}, found ${version}`
        );
      }
    };

    const prepare = async (input: {
      source: PluginInstallSource;
      recordSource: PluginInstallSource;
      expectedName?: string;
      requiredRange?: string;
      requiredBy?: string;
      root: boolean;
    }): Promise<PreparedPlugin | InstalledPluginRecord> => {
      const expectedExisting = input.expectedName
        ? options.state.installed[input.expectedName]
        : undefined;
      if (expectedExisting && !input.root && input.requiredRange) {
        if (satisfies(expectedExisting.version, input.requiredRange)) {
          return expectedExisting;
        }
        if (
          input.recordSource.type !== 'marketplace' ||
          expectedExisting.source.type !== 'marketplace' ||
          expectedExisting.source.marketplace !== input.recordSource.marketplace
        ) {
          assertRange(
            expectedExisting.name,
            expectedExisting.version,
            input.requiredRange,
            input.requiredBy ?? 'dependency'
          );
        }
        input = {
          ...input,
          source: expectedExisting.source,
          recordSource: expectedExisting.source,
        };
      }
      if (expectedExisting && input.root && !options.updateRoot) {
        throw new PluginPackageError(
          'PLUGIN_ALREADY_INSTALLED',
          `Plugin "${expectedExisting.name}" is already installed`
        );
      }

      if (input.expectedName) {
        const ready = preparedByName.get(input.expectedName);
        if (ready) {
          if (input.requiredRange) {
            assertRange(
              ready.name,
              ready.manifest.version,
              input.requiredRange,
              input.requiredBy ?? 'dependency'
            );
          }
          return ready;
        }
        if (stack.includes(input.expectedName)) {
          throw new PluginPackageError(
            'DEPENDENCY_CYCLE',
            `Plugin dependency cycle: ${[...stack, input.expectedName].join(' -> ')}`
          );
        }
      }

      const materialized = await this.materializePluginSource(
        input.source,
        options.state,
        input.expectedName,
        options.policy
      );
      const parsed = await parsePluginManifest(materialized.stagingPath);
      if (!parsed) {
        await fs.rm(materialized.stagingPath, {
          recursive: true,
          force: true,
        });
        throw new PluginPackageError('INVALID_PLUGIN', 'Plugin manifest was not found');
      }
      const name = assertPluginName(parsed.manifest.name);
      if (input.expectedName && input.expectedName !== name) {
        await fs.rm(materialized.stagingPath, {
          recursive: true,
          force: true,
        });
        throw new PluginPackageError(
          'PLUGIN_IDENTITY_MISMATCH',
          `Requested "${input.expectedName}" but source declares "${name}"`
        );
      }
      if (stack.includes(name)) {
        await fs.rm(materialized.stagingPath, {
          recursive: true,
          force: true,
        });
        throw new PluginPackageError(
          'DEPENDENCY_CYCLE',
          `Plugin dependency cycle: ${[...stack, name].join(' -> ')}`
        );
      }
      if (input.root && options.state.installed[name] && !options.updateRoot) {
        await fs.rm(materialized.stagingPath, {
          recursive: true,
          force: true,
        });
        throw new PluginPackageError(
          'PLUGIN_ALREADY_INSTALLED',
          `Plugin "${name}" is already installed`
        );
      }
      try {
        assertBladeVersionCompatible(parsed.manifest);
      } catch (error) {
        await fs.rm(materialized.stagingPath, {
          recursive: true,
          force: true,
        });
        throw new PluginPackageError(
          'VERSION_INCOMPATIBLE',
          error instanceof Error ? error.message : String(error)
        );
      }

      const candidate: PreparedPlugin = {
        name,
        source: input.recordSource,
        manifest: parsed.manifest,
        materialized,
        existing: options.state.installed[name],
      };
      stack.push(name);
      try {
        for (const [dependencyName, range] of Object.entries(
          parsed.manifest.dependencies ?? {}
        ).sort(([left], [right]) => left.localeCompare(right))) {
          const ready = preparedByName.get(dependencyName);
          if (ready) {
            assertRange(dependencyName, ready.manifest.version, range, name);
            continue;
          }
          const installed = options.state.installed[dependencyName];
          if (installed && satisfies(installed.version, range)) continue;
          if (input.recordSource.type !== 'marketplace') {
            throw new PluginPackageError(
              installed ? 'DEPENDENCY_VERSION_MISMATCH' : 'DEPENDENCY_MISSING',
              installed
                ? `Plugin "${name}" requires ${dependencyName}@${range}, found ${installed.version}`
                : `Plugin "${name}" requires missing dependency ${dependencyName}@${range}; direct sources cannot auto-install dependencies`
            );
          }
          const dependency = await prepare({
            source:
              installed?.source.type === 'marketplace' &&
              installed.source.marketplace === input.recordSource.marketplace
                ? installed.source
                : {
                    type: 'marketplace',
                    marketplace: input.recordSource.marketplace,
                  },
            recordSource: {
              type: 'marketplace',
              marketplace: input.recordSource.marketplace,
            },
            expectedName: dependencyName,
            requiredRange: range,
            requiredBy: name,
            root: false,
          });
          assertRange(
            dependencyName,
            'manifest' in dependency ? dependency.manifest.version : dependency.version,
            range,
            name
          );
        }
      } catch (error) {
        await fs.rm(materialized.stagingPath, {
          recursive: true,
          force: true,
        });
        throw error;
      } finally {
        stack.pop();
      }
      preparedByName.set(name, candidate);
      prepared.push(candidate);
      return candidate;
    };

    try {
      const root = await prepare({
        source: options.source,
        recordSource: options.recordSource,
        expectedName: options.expectedName,
        root: true,
      });
      if (!('manifest' in root)) {
        throw new PluginPackageError(
          'PLUGIN_PACKAGE_ERROR',
          'Root plugin unexpectedly resolved to an existing dependency'
        );
      }
      return { root, prepared };
    } catch (error) {
      await this.cleanupPreparedPlugins(prepared);
      throw error;
    }
  }

  private async commitPreparedPlugins(
    state: PluginPackageState,
    prepared: PreparedPlugin[]
  ): Promise<{
    records: Map<string, InstalledPluginRecord>;
    changed: Set<string>;
  }> {
    const records = new Map<string, InstalledPluginRecord>();
    const changed = new Set<string>();
    const now = new Date().toISOString();
    for (const plugin of prepared) {
      const existing = plugin.existing;
      if (
        existing?.revision === plugin.materialized.revision &&
        existing.contentDigest === plugin.materialized.contentDigest
      ) {
        await fs.rm(plugin.materialized.stagingPath, {
          recursive: true,
          force: true,
        });
        records.set(plugin.name, existing);
        continue;
      }
      const installPath = await this.publishPackage(
        'packages',
        plugin.name,
        plugin.materialized
      );
      const installation: InstalledPluginRecord = {
        name: plugin.name,
        source: plugin.source,
        installPath,
        version: plugin.manifest.version,
        revision: plugin.materialized.revision,
        contentDigest: plugin.materialized.contentDigest,
        installedAt: existing?.installedAt ?? now,
        updatedAt: now,
      };
      state.installed[plugin.name] = installation;
      records.set(plugin.name, installation);
      changed.add(plugin.name);
    }
    if (changed.size > 0) await this.writeState(state);
    return { records, changed };
  }

  private async cleanupPreparedPlugins(
    prepared: readonly PreparedPlugin[]
  ): Promise<void> {
    await Promise.all(
      prepared.map((plugin) =>
        fs.rm(plugin.materialized.stagingPath, {
          recursive: true,
          force: true,
        })
      )
    );
  }

  private async resolvePluginSource(
    input: string,
    state: PluginPackageState,
    options: PluginInstallOptions
  ): Promise<{
    source: PluginInstallSource;
    recordSource: PluginInstallSource;
    expectedName?: string;
  }> {
    const source = input.trim();
    if (!source) {
      throw new PluginPackageError('INVALID_SOURCE', 'Plugin source is required');
    }
    const identifier = parsePluginIdentifier(source);
    if (identifier) {
      if (!state.marketplaces[identifier.marketplace]) {
        throw new PluginPackageError(
          'MARKETPLACE_NOT_FOUND',
          `Marketplace "${identifier.marketplace}" is not configured`
        );
      }
      return {
        source: {
          type: 'marketplace',
          marketplace: identifier.marketplace,
        },
        recordSource: {
          type: 'marketplace',
          marketplace: identifier.marketplace,
        },
        expectedName: identifier.pluginName,
      };
    }

    if (!isPathSource(source) && !this.looksLikeGitSource(source)) {
      const matches: Array<{ pluginName: string; marketplace: string }> = [];
      for (const catalog of await this.catalogsFromState(state)) {
        if (catalog.manifest.plugins.some((entry) => entry.name === source)) {
          matches.push({ pluginName: source, marketplace: catalog.marketplace.name });
        }
      }
      if (matches.length === 1) {
        return {
          source: {
            type: 'marketplace',
            marketplace: matches[0].marketplace,
          },
          recordSource: {
            type: 'marketplace',
            marketplace: matches[0].marketplace,
          },
          expectedName: source,
        };
      }
      if (matches.length > 1) {
        throw new PluginPackageError(
          'AMBIGUOUS_PLUGIN_SOURCE',
          `Plugin "${source}" exists in multiple marketplaces; use name@marketplace`
        );
      }
    }

    if (isPathSource(source)) {
      const localPath = await this.resolveLocalSource(source, options.workspaceRoot);
      const localSource: PluginInstallSource = {
        type: 'local',
        path: localPath,
      };
      return { source: localSource, recordSource: localSource };
    }

    const gitSource = this.normalizeGitSource(source, options.ref);
    return { source: gitSource, recordSource: gitSource };
  }

  private async materializePluginSource(
    source: PluginInstallSource,
    state: PluginPackageState,
    expectedName: string | undefined,
    policy: PluginSourcePolicy
  ): Promise<MaterializedSource> {
    if (source.type !== 'marketplace') {
      return this.materializeSource(source);
    }
    const marketplace = state.marketplaces[source.marketplace];
    if (!marketplace) {
      throw new PluginPackageError(
        'MARKETPLACE_NOT_FOUND',
        `Marketplace "${source.marketplace}" is not configured`
      );
    }
    const catalog = await this.readMarketplaceManifest(marketplace.installPath);
    const entries = expectedName
      ? catalog.plugins.filter((entry) => entry.name === expectedName)
      : catalog.plugins;
    if (entries.length !== 1) {
      throw new PluginPackageError(
        'MARKETPLACE_PLUGIN_NOT_FOUND',
        expectedName
          ? `Plugin "${expectedName}" was not found in marketplace "${source.marketplace}"`
          : `Marketplace "${source.marketplace}" requires an explicit plugin name`
      );
    }
    return this.materializeMarketplaceEntry(marketplace, entries[0], policy);
  }

  private async materializeMarketplaceEntry(
    marketplace: PluginMarketplaceRecord,
    entry: PluginMarketplaceManifest['plugins'][number],
    policy: PluginSourcePolicy
  ): Promise<MaterializedSource> {
    if (typeof entry.source !== 'string') {
      const source = this.normalizeGitSource(
        entry.source.url,
        entry.source.sha ?? entry.source.ref
      );
      assertMarketplaceSourceAllowed(policy, source, `Plugin "${entry.name}"`);
      return this.materializeSource(source);
    }
    if (
      entry.source.startsWith('https://') ||
      entry.source.startsWith('ssh://') ||
      entry.source.startsWith('git@')
    ) {
      const source = this.normalizeGitSource(entry.source);
      assertMarketplaceSourceAllowed(policy, source, `Plugin "${entry.name}"`);
      return this.materializeSource(source);
    }
    const marketplaceRoot = await fs.realpath(marketplace.installPath);
    const unresolvedCandidate = path.resolve(marketplaceRoot, entry.source);
    if (
      !isWithin(marketplaceRoot, unresolvedCandidate) ||
      unresolvedCandidate === marketplaceRoot
    ) {
      throw new PluginPackageError(
        'MARKETPLACE_PATH_ESCAPE',
        `Plugin "${entry.name}" source escapes its marketplace`
      );
    }
    const candidate = await fs.realpath(unresolvedCandidate);
    if (!isWithin(marketplaceRoot, candidate)) {
      throw new PluginPackageError(
        'MARKETPLACE_PATH_ESCAPE',
        `Plugin "${entry.name}" source escapes its marketplace`
      );
    }
    return this.materializeSource({ type: 'local', path: candidate });
  }

  private async normalizeMarketplaceSource(
    source: string,
    options: Pick<PluginInstallOptions, 'workspaceRoot' | 'ref'>
  ): Promise<PluginMarketplaceSource> {
    const trimmed = source.trim();
    if (!trimmed) {
      throw new PluginPackageError('INVALID_SOURCE', 'Marketplace source is required');
    }
    if (isPathSource(trimmed)) {
      return {
        type: 'local',
        path: await this.resolveLocalSource(trimmed, options.workspaceRoot),
      };
    }
    return this.normalizeGitSource(trimmed, options.ref);
  }

  private normalizeGitSource(
    source: string,
    ref?: string
  ): PluginMarketplaceSource & {
    type: 'git';
  } {
    let url = source;
    if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(source)) {
      url = `https://github.com/${source}.git`;
    } else if (source.startsWith('git@')) {
      if (
        !/^git@[A-Za-z0-9.-]+:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(source)
      ) {
        throw new PluginPackageError('INVALID_SOURCE', 'Invalid SSH Git source');
      }
    } else {
      let parsed: URL;
      try {
        parsed = new URL(source);
      } catch {
        throw new PluginPackageError('INVALID_SOURCE', 'Invalid Git source');
      }
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'ssh:') {
        throw new PluginPackageError(
          'UNSAFE_GIT_PROTOCOL',
          'Git sources must use HTTPS or SSH'
        );
      }
      if (parsed.password || (parsed.protocol === 'https:' && parsed.username)) {
        throw new PluginPackageError(
          'GIT_CREDENTIALS_IN_URL',
          'Git credentials must not be embedded in plugin source URLs'
        );
      }
      if (parsed.hash || parsed.search) {
        throw new PluginPackageError(
          'INVALID_SOURCE',
          'Use the ref option instead of URL query or fragment parameters'
        );
      }
      url = parsed.toString();
    }
    if (ref && (!ref.trim() || ref.startsWith('-') || ref.includes('\0'))) {
      throw new PluginPackageError('INVALID_GIT_REF', 'Invalid Git ref');
    }
    return {
      type: 'git',
      url,
      ...(ref ? { ref } : {}),
    };
  }

  private looksLikeGitSource(source: string): boolean {
    return (
      source.startsWith('https://') ||
      source.startsWith('ssh://') ||
      source.startsWith('git@') ||
      /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(source)
    );
  }

  private async resolveLocalSource(
    source: string,
    workspaceRoot?: string
  ): Promise<string> {
    const expanded =
      source === '~'
        ? homedir()
        : source.startsWith('~/')
          ? path.join(homedir(), source.slice(2))
          : source;
    const resolved = path.resolve(workspaceRoot ?? process.cwd(), expanded);
    this.assertAllowedLocalSource(resolved);
    let realPath: string;
    try {
      realPath = await fs.realpath(resolved);
    } catch {
      throw new PluginPackageError(
        'LOCAL_SOURCE_NOT_FOUND',
        `Local source does not exist: ${source}`
      );
    }
    const stat = await fs.lstat(realPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new PluginPackageError(
        'INVALID_LOCAL_SOURCE',
        'Local plugin sources must be regular directories'
      );
    }
    this.assertAllowedLocalSource(realPath);
    return realPath;
  }

  private assertAllowedLocalSource(sourcePath: string): void {
    try {
      normalizeLocalWorkspacePath(sourcePath, 'sourcePath');
    } catch {
      throw new PluginPackageError(
        'INVALID_LOCAL_SOURCE',
        'Local plugin source must reference a local workspace'
      );
    }
  }

  private async materializeSource(
    source:
      | PluginMarketplaceSource
      | Exclude<PluginInstallSource, { type: 'marketplace' }>
  ): Promise<MaterializedSource> {
    if (source.type === 'local') {
      this.assertAllowedLocalSource(source.path);
    }
    await this.ensureStoreDirectory();
    const stagingPath = path.join(this.stateRoot, 'staging', randomUUID());
    await fs.mkdir(path.dirname(stagingPath), { recursive: true, mode: 0o700 });
    if (source.type === 'git') {
      await this.cloneGitSource(source, stagingPath);
      const revision = await this.runGit(['rev-parse', 'HEAD'], stagingPath);
      if (
        source.ref &&
        FULL_GIT_SHA_PATTERN.test(source.ref) &&
        revision.toLowerCase() !== source.ref.toLowerCase()
      ) {
        await fs.rm(stagingPath, { recursive: true, force: true });
        throw new PluginPackageError(
          'GIT_PIN_MISMATCH',
          'Plugin checkout does not match the requested Git commit SHA'
        );
      }
      await fs.rm(path.join(stagingPath, '.git'), { recursive: true, force: true });
      const contentDigest = await this.digestTree(stagingPath);
      return { stagingPath, revision, contentDigest };
    }
    await this.copyLocalSource(source.path, stagingPath);
    const contentDigest = await this.digestTree(stagingPath);
    return {
      stagingPath,
      revision: `local-${contentDigest.slice(0, 40)}`,
      contentDigest,
    };
  }

  private async cloneGitSource(
    source: Extract<PluginMarketplaceSource, { type: 'git' }>,
    destination: string
  ): Promise<void> {
    try {
      if (source.ref && FULL_GIT_SHA_PATTERN.test(source.ref)) {
        await fs.mkdir(destination, { recursive: true, mode: 0o700 });
        await this.runGit(['init'], destination);
        await this.runGit(['remote', 'add', 'origin', source.url], destination);
        await this.runGit(['fetch', '--depth', '1', 'origin', source.ref], destination);
        await this.runGit(['checkout', '--detach', 'FETCH_HEAD'], destination);
      } else {
        const args = ['clone', '--depth', '1', '--no-tags'];
        if (source.ref) args.push('--branch', source.ref);
        args.push('--', source.url, destination);
        await this.runGit(args);
      }
    } catch (error) {
      await fs.rm(destination, { recursive: true, force: true });
      throw new PluginPackageError(
        'GIT_CLONE_FAILED',
        `Failed to clone plugin source: ${this.sanitizeError(error)}`
      );
    }
  }

  private async runGit(args: string[], cwd?: string): Promise<string> {
    const result = (await execFileAsync('git', args, {
      cwd,
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
      },
    })) as unknown;
    const stdout =
      typeof result === 'string'
        ? result
        : (result as { stdout?: string | Buffer }).stdout;
    if (stdout === undefined) {
      throw new Error('Git process returned an invalid result');
    }
    return String(stdout).trim();
  }

  private sanitizeError(error: unknown): string {
    const raw = error instanceof Error ? error.message : String(error);
    return raw.replaceAll(this.stateRoot, '<plugin-store>').slice(0, 500);
  }

  private async copyLocalSource(source: string, destination: string): Promise<void> {
    await this.digestTree(source);
    await fs.cp(source, destination, {
      recursive: true,
      force: false,
      errorOnExist: true,
      filter: (candidate) => {
        const relative = path.relative(source, candidate);
        return !relative.split(path.sep).includes('.git');
      },
    });
  }

  private async digestTree(root: string): Promise<string> {
    const files: Array<{ relative: string; absolute: string; executable: boolean }> =
      [];
    let totalBytes = 0;

    const visit = async (directory: string): Promise<void> => {
      const entries = await fs.readdir(directory, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        if (entry.name === '.git') continue;
        const absolute = path.join(directory, entry.name);
        const relative = path.relative(root, absolute);
        const stat = await fs.lstat(absolute);
        if (stat.isSymbolicLink()) {
          throw new PluginPackageError(
            'PACKAGE_SYMLINK_FORBIDDEN',
            `Plugin packages may not contain symbolic links: ${relative}`
          );
        }
        if (stat.isDirectory()) {
          await visit(absolute);
          continue;
        }
        if (!stat.isFile()) {
          throw new PluginPackageError(
            'PACKAGE_ENTRY_FORBIDDEN',
            `Plugin packages may contain only files and directories: ${relative}`
          );
        }
        totalBytes += stat.size;
        files.push({
          relative,
          absolute,
          executable: (stat.mode & 0o111) !== 0,
        });
        if (files.length > MAX_PACKAGE_FILES || totalBytes > MAX_PACKAGE_BYTES) {
          throw new PluginPackageError(
            'PACKAGE_TOO_LARGE',
            `Plugin package exceeds ${MAX_PACKAGE_FILES} files or ${MAX_PACKAGE_BYTES} bytes`
          );
        }
      }
    };

    await visit(root);
    const hash = createHash('sha256');
    for (const file of files) {
      hash.update(file.relative);
      hash.update('\0');
      hash.update(file.executable ? 'x' : '-');
      hash.update('\0');
      hash.update(await fs.readFile(file.absolute));
      hash.update('\0');
    }
    return hash.digest('hex');
  }

  private async publishPackage(
    category: 'packages' | 'marketplaces',
    name: string,
    materialized: MaterializedSource
  ): Promise<string> {
    const destination = path.join(
      this.stateRoot,
      category,
      name,
      materialized.contentDigest
    );
    await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    try {
      const stat = await fs.lstat(destination);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new PluginPackageError(
          'PACKAGE_STORE_CONFLICT',
          'Plugin package destination is not a regular directory'
        );
      }
      await fs.rm(materialized.stagingPath, { recursive: true, force: true });
      return destination;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    await fs.rename(materialized.stagingPath, destination);
    return destination;
  }

  private async readMarketplaceManifest(
    root: string
  ): Promise<PluginMarketplaceManifest> {
    for (const relativePath of MARKETPLACE_MANIFEST_PATHS) {
      const manifestPath = path.join(root, relativePath);
      try {
        const stat = await fs.lstat(manifestPath);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_STATE_BYTES) {
          throw new PluginPackageError(
            'INVALID_MARKETPLACE',
            'Marketplace manifest must be a regular bounded file'
          );
        }
        const parsed = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as unknown;
        const result = validatePluginMarketplaceManifest(parsed);
        if (!result.success) {
          throw new PluginPackageError(
            'INVALID_MARKETPLACE',
            `Invalid marketplace manifest: ${result.error.issues
              .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
              .join('; ')}`
          );
        }
        const names = new Set<string>();
        for (const plugin of result.data.plugins) {
          if (names.has(plugin.name)) {
            throw new PluginPackageError(
              'INVALID_MARKETPLACE',
              `Marketplace contains duplicate plugin: ${plugin.name}`
            );
          }
          names.add(plugin.name);
        }
        return result.data;
      } catch (error) {
        if (isMissing(error)) continue;
        if (error instanceof SyntaxError) {
          throw new PluginPackageError(
            'INVALID_MARKETPLACE',
            'Marketplace manifest contains invalid JSON'
          );
        }
        throw error;
      }
    }
    throw new PluginPackageError(
      'INVALID_MARKETPLACE',
      'Marketplace manifest was not found'
    );
  }

  private async catalogsFromState(state: PluginPackageState): Promise<PluginCatalog[]> {
    const marketplaces = Object.values(state.marketplaces).sort((left, right) =>
      left.name.localeCompare(right.name)
    );
    return Promise.all(
      marketplaces.map(async (marketplace) => ({
        marketplace,
        manifest: await this.readMarketplaceManifest(marketplace.installPath),
      }))
    );
  }

  private async readState(): Promise<PluginPackageState> {
    let handle;
    try {
      handle = await fs.open(this.statePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (isMissing(error)) return emptyState();
      throw new PluginPackageError(
        'PLUGIN_STATE_INVALID',
        'Plugin package state must be a regular file'
      );
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_STATE_BYTES) {
        throw new PluginPackageError(
          'PLUGIN_STATE_INVALID',
          'Plugin package state is invalid'
        );
      }
      if (process.getuid && stat.uid !== process.getuid()) {
        throw new PluginPackageError(
          'PLUGIN_STATE_INVALID',
          'Plugin package state must be owned by the current user'
        );
      }
      if ((stat.mode & 0o777) !== 0o600) {
        throw new PluginPackageError(
          'PLUGIN_STATE_INVALID',
          'Plugin package state permissions must be 0600'
        );
      }
      const parsed = JSON.parse(await handle.readFile('utf8')) as unknown;
      const result = validatePluginPackageState(parsed);
      if (!result.success) {
        throw new PluginPackageError(
          'PLUGIN_STATE_INVALID',
          'Plugin package state schema is invalid'
        );
      }
      const state = result.data as PluginPackageState;
      for (const [name, plugin] of Object.entries(state.installed)) {
        const packageRoot = path.join(this.stateRoot, 'packages', name);
        if (
          name !== plugin.name ||
          !path.isAbsolute(plugin.installPath) ||
          !isWithin(packageRoot, plugin.installPath) ||
          path.basename(plugin.installPath) !== plugin.contentDigest ||
          (plugin.source.type === 'local' && !path.isAbsolute(plugin.source.path))
        ) {
          throw new PluginPackageError(
            'PLUGIN_STATE_INVALID',
            'Plugin package state contains an invalid installation'
          );
        }
        if (plugin.source.type === 'git') {
          const normalized = this.normalizeGitSource(
            plugin.source.url,
            plugin.source.ref
          );
          if (
            normalized.url !== plugin.source.url ||
            normalized.ref !== plugin.source.ref
          ) {
            throw new PluginPackageError(
              'PLUGIN_STATE_INVALID',
              'Plugin package state contains an invalid Git source'
            );
          }
        }
      }
      for (const [name, marketplace] of Object.entries(state.marketplaces)) {
        const marketplaceRoot = path.join(this.stateRoot, 'marketplaces', name);
        if (
          name !== marketplace.name ||
          !path.isAbsolute(marketplace.installPath) ||
          !isWithin(marketplaceRoot, marketplace.installPath) ||
          path.basename(marketplace.installPath) !== marketplace.contentDigest ||
          (marketplace.source.type === 'local' &&
            !path.isAbsolute(marketplace.source.path))
        ) {
          throw new PluginPackageError(
            'PLUGIN_STATE_INVALID',
            'Plugin package state contains an invalid marketplace'
          );
        }
        if (marketplace.source.type === 'git') {
          const normalized = this.normalizeGitSource(
            marketplace.source.url,
            marketplace.source.ref
          );
          if (
            normalized.url !== marketplace.source.url ||
            normalized.ref !== marketplace.source.ref
          ) {
            throw new PluginPackageError(
              'PLUGIN_STATE_INVALID',
              'Plugin package state contains an invalid Marketplace Git source'
            );
          }
        }
      }
      for (const plugin of Object.values(state.installed)) {
        if (
          plugin.source.type === 'marketplace' &&
          !state.marketplaces[plugin.source.marketplace]
        ) {
          throw new PluginPackageError(
            'PLUGIN_STATE_INVALID',
            'Plugin package state references a missing marketplace'
          );
        }
      }
      return state;
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new PluginPackageError(
          'PLUGIN_STATE_INVALID',
          'Plugin package state contains invalid JSON'
        );
      }
      throw error;
    } finally {
      await handle.close();
    }
  }

  private async writeState(state: PluginPackageState): Promise<void> {
    await this.ensureStoreDirectory();
    await writeFileAtomic(this.statePath, `${JSON.stringify(state, null, 2)}\n`, {
      mode: 0o600,
      encoding: 'utf8',
    });
    await fs.chmod(this.statePath, 0o600);
  }

  private async ensureStoreDirectory(): Promise<void> {
    try {
      const stat = await fs.lstat(this.stateRoot);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new PluginPackageError(
          'PLUGIN_STORE_INVALID',
          'Plugin package store must be a regular directory'
        );
      }
      if (process.getuid && stat.uid !== process.getuid()) {
        throw new PluginPackageError(
          'PLUGIN_STORE_INVALID',
          'Plugin package store must be owned by the current user'
        );
      }
      if ((stat.mode & 0o777) !== 0o700) {
        throw new PluginPackageError(
          'PLUGIN_STORE_INVALID',
          'Plugin package store permissions must be 0700'
        );
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
      await fs.mkdir(this.stateRoot, { recursive: true, mode: 0o700 });
      await fs.chmod(this.stateRoot, 0o700);
    }
  }
}

let installerInstance: PluginInstaller | null = null;

export function getPluginInstaller(
  userPluginsDir?: string,
  stateRoot?: string
): PluginInstaller {
  if (!installerInstance) {
    installerInstance = new PluginInstaller(userPluginsDir, stateRoot);
  }
  return installerInstance;
}

export function resetPluginInstaller(): void {
  installerInstance = null;
}
