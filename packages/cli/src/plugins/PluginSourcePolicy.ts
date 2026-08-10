import { realpathSync } from 'node:fs';
import path from 'node:path';
import type { PluginSourcePolicy } from '../config/types.js';
import type {
  PluginInstallSource,
  PluginMarketplaceRecord,
  PluginMarketplaceSource,
} from './types.js';

const FULL_GIT_SHA_PATTERN = /^[a-fA-F0-9]{40}$/;

export class PluginSourcePolicyError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'PluginSourcePolicyError';
  }
}

function isWithin(root: string, candidate: string): boolean {
  const canonical = (value: string) => {
    try {
      return realpathSync.native(value);
    } catch {
      return path.resolve(value);
    }
  };
  const relative = path.relative(canonical(root), canonical(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function extractPluginGitHost(url: string): string | undefined {
  const scp = url.match(/^[^@]+@([^:]+):/);
  if (scp?.[1]) return scp[1].toLowerCase();
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function hostMatches(host: string, pattern: string): boolean {
  if (!pattern.startsWith('*.')) return host === pattern;
  const suffix = pattern.slice(1);
  return host.endsWith(suffix) && host.length > suffix.length;
}

function assertGitSourceAllowed(
  policy: PluginSourcePolicy,
  source: Extract<PluginMarketplaceSource, { type: 'git' }>,
  label: string
): void {
  if (
    policy.requireGitCommitSha &&
    (!source.ref || !FULL_GIT_SHA_PATTERN.test(source.ref))
  ) {
    throw new PluginSourcePolicyError(
      'PLUGIN_GIT_SHA_REQUIRED',
      `${label} must pin a full 40-character Git commit SHA`
    );
  }
  if (!policy.restrictToAllowedSources) return;
  const host = extractPluginGitHost(source.url);
  if (!host || !policy.allowedGitHosts.some((pattern) => hostMatches(host, pattern))) {
    throw new PluginSourcePolicyError(
      'PLUGIN_SOURCE_BLOCKED',
      `${label} Git host is not allowed by plugin source policy`
    );
  }
}

function assertLocalSourceAllowed(
  policy: PluginSourcePolicy,
  sourcePath: string,
  label: string
): void {
  if (!policy.restrictToAllowedSources) return;
  if (!policy.allowedLocalRoots.some((root) => isWithin(root, sourcePath))) {
    throw new PluginSourcePolicyError(
      'PLUGIN_SOURCE_BLOCKED',
      `${label} local path is not allowed by plugin source policy`
    );
  }
}

export function assertMarketplaceSourceAllowed(
  policy: PluginSourcePolicy,
  source: PluginMarketplaceSource,
  label = 'Marketplace'
): void {
  if (source.type === 'git') {
    assertGitSourceAllowed(policy, source, label);
  } else {
    assertLocalSourceAllowed(policy, source.path, label);
  }
}

export function assertPluginSourceAllowed(
  policy: PluginSourcePolicy,
  source: PluginInstallSource,
  marketplaces: Readonly<Record<string, PluginMarketplaceRecord>>,
  label = 'Plugin'
): void {
  if (source.type === 'git') {
    assertGitSourceAllowed(policy, source, label);
    return;
  }
  if (source.type === 'local') {
    assertLocalSourceAllowed(policy, source.path, label);
    return;
  }
  if (
    policy.restrictToAllowedSources &&
    !policy.allowedMarketplaces.includes(source.marketplace)
  ) {
    throw new PluginSourcePolicyError(
      'PLUGIN_SOURCE_BLOCKED',
      `Marketplace "${source.marketplace}" is not allowed by plugin source policy`
    );
  }
  const marketplace = marketplaces[source.marketplace];
  if (!marketplace) {
    throw new PluginSourcePolicyError(
      'MARKETPLACE_NOT_FOUND',
      `Marketplace "${source.marketplace}" is not configured`
    );
  }
  assertMarketplaceSourceAllowed(
    policy,
    marketplace.source,
    `Marketplace "${source.marketplace}"`
  );
}

export function isFullPluginGitSha(value: string | undefined): boolean {
  return value !== undefined && FULL_GIT_SHA_PATTERN.test(value);
}
