import { describe, expect, it } from 'vitest';
import type { PluginSourcePolicy } from '../../../src/config/types.js';
import {
  assertMarketplaceSourceAllowed,
  assertPluginSourceAllowed,
  extractPluginGitHost,
} from '../../../src/plugins/PluginSourcePolicy.js';
import type { PluginMarketplaceRecord } from '../../../src/plugins/types.js';

function policy(overrides: Partial<PluginSourcePolicy> = {}): PluginSourcePolicy {
  return {
    restrictToAllowedSources: true,
    requireGitCommitSha: false,
    allowedGitHosts: ['github.com', '*.example.test'],
    allowedMarketplaces: ['team-market'],
    allowedLocalRoots: ['/approved/plugins'],
    ...overrides,
  };
}

const marketplace: PluginMarketplaceRecord = {
  name: 'team-market',
  source: { type: 'local', path: '/approved/plugins/marketplace' },
  installPath: '/store/marketplaces/team-market/digest',
  revision: 'local-digest',
  contentDigest: 'a'.repeat(64),
  addedAt: '2026-08-08T00:00:00.000Z',
  updatedAt: '2026-08-08T00:00:00.000Z',
};

describe('plugin source policy', () => {
  it('matches exact and wildcard Git hosts without accepting suffix confusion', () => {
    expect(extractPluginGitHost('git@github.com:owner/repo.git')).toBe('github.com');
    expect(() =>
      assertMarketplaceSourceAllowed(policy(), {
        type: 'git',
        url: 'https://plugins.example.test/repo.git',
      })
    ).not.toThrow();
    expect(() =>
      assertMarketplaceSourceAllowed(policy(), {
        type: 'git',
        url: 'https://evilgithub.com/repo.git',
      })
    ).toThrow('not allowed');
  });

  it('restricts local paths and configured Marketplace identities', () => {
    expect(() =>
      assertPluginSourceAllowed(
        policy(),
        { type: 'local', path: '/approved/plugins/local' },
        {}
      )
    ).not.toThrow();
    expect(() =>
      assertPluginSourceAllowed(
        policy(),
        { type: 'local', path: '/approved/plugin-escape' },
        {}
      )
    ).toThrow('not allowed');
    expect(() =>
      assertPluginSourceAllowed(
        policy(),
        { type: 'marketplace', marketplace: 'team-market' },
        { 'team-market': marketplace }
      )
    ).not.toThrow();
    expect(() =>
      assertPluginSourceAllowed(
        policy(),
        { type: 'marketplace', marketplace: 'other-market' },
        {}
      )
    ).toThrow('not allowed');
  });

  it('requires full Git commit pins before any remote source is fetched', () => {
    const pinned = policy({ requireGitCommitSha: true });
    expect(() =>
      assertMarketplaceSourceAllowed(pinned, {
        type: 'git',
        url: 'https://github.com/owner/repo.git',
        ref: 'main',
      })
    ).toThrow('full 40-character');
    expect(() =>
      assertMarketplaceSourceAllowed(pinned, {
        type: 'git',
        url: 'https://github.com/owner/repo.git',
        ref: 'a'.repeat(40),
      })
    ).not.toThrow();
  });

  it('allows legacy sources when strict mode is disabled while retaining SHA policy', () => {
    expect(() =>
      assertMarketplaceSourceAllowed(
        policy({
          restrictToAllowedSources: false,
          allowedGitHosts: [],
          allowedLocalRoots: [],
        }),
        {
          type: 'git',
          url: 'https://anywhere.test/repo.git',
        }
      )
    ).not.toThrow();
    expect(() =>
      assertMarketplaceSourceAllowed(
        policy({
          restrictToAllowedSources: false,
          requireGitCommitSha: true,
        }),
        {
          type: 'git',
          url: 'https://anywhere.test/repo.git',
        }
      )
    ).toThrow('full 40-character');
  });
});
