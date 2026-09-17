import type { SubagentConfig } from '../agent/subagents/types.js';
import type { LspServerConfig, McpServerConfig } from '../config/types.js';
import type { HookConfig } from '../hooks/types/HookTypes.js';
import type { SkillMetadata } from '../skills/types.js';
import type { CustomCommandConfig } from '../slash-commands/custom/types.js';
export interface PluginAuthor {
  name: string;
  email?: string;
  url?: string;
}

/**
 * Plugin manifest (plugin.json)
 *
 * This is the main configuration file for a plugin, located at
 * .blade-plugin/plugin.json or .claude-plugin/plugin.json
 */
export interface PluginManifest {
  /** Unique plugin identifier (used for namespacing), kebab-case, 2-64 chars */
  name: string;
  description: string;
  version: string;
  author?: PluginAuthor;
  license?: string;
  repository?: string;
  homepage?: string;
  keywords?: string[];
  dependencies?: Record<string, string>;
  bladeVersion?: string;
}

export type PluginInstallSource =
  | {
      type: 'git';
      url: string;
      ref?: string;
    }
  | {
      type: 'local';
      path: string;
    }
  | {
      type: 'marketplace';
      marketplace: string;
    };
export interface InstalledPluginRecord {
  name: string;
  source: PluginInstallSource;
  installPath: string;
  version: string;
  revision: string;
  contentDigest: string;
  installedAt: string;
  updatedAt: string;
}

export type PluginMarketplaceSource =
  | {
      type: 'git';
      url: string;
      ref?: string;
    }
  | {
      type: 'local';
      path: string;
    };
export interface PluginMarketplaceRecord {
  name: string;
  source: PluginMarketplaceSource;
  installPath: string;
  revision: string;
  contentDigest: string;
  addedAt: string;
  updatedAt: string;
}

export interface PluginMarketplaceEntry {
  name: string;
  description?: string;
  version?: string;
  author?: string | PluginAuthor;
  source:
    | string
    | {
        source: 'url';
        url: string;
        ref?: string;
        sha?: string;
      };
  category?: string;
  homepage?: string;
  tags?: string[];
}

export interface PluginMarketplaceManifest {
  name: string;
  description?: string;
  owner?: PluginAuthor;
  metadata?: {
    description?: string;
    version?: string;
  };
  plugins: PluginMarketplaceEntry[];
}

export interface PluginPackageState {
  version: 1;
  installed: Record<string, InstalledPluginRecord>;
  marketplaces: Record<string, PluginMarketplaceRecord>;
}

export type PluginSource =
  | 'cli' // --plugin-dir argument (highest priority)
  | 'project' // .blade/plugins/ or .claude/plugins/
  | 'user'; // ~/.blade/plugins/ or ~/.claude/plugins/

export type ManifestSource = 'blade' | 'claude';
export type PluginStatus = 'active' | 'inactive' | 'error';
export type PluginCompatibilityIssueCode =
  | 'blade-version'
  | 'dependency-missing'
  | 'dependency-version'
  | 'dependency-inactive'
  | 'source-policy';
export interface PluginCompatibilityIssue {
  code: PluginCompatibilityIssueCode;
  message: string;
  dependency?: string;
  expected?: string;
  actual?: string;
}

export interface PluginCommand {
  originalName: string;
  namespacedName: string;
  pluginName: string;
  config: CustomCommandConfig;
  content: string;
  path: string;
}

export interface PluginSkill {
  originalName: string;
  namespacedName: string;
  pluginName: string;
  metadata: SkillMetadata;
  path: string;
}

export interface PluginAgent {
  originalName: string;
  namespacedName: string;
  pluginName: string;
  config: SubagentConfig;
  path: string;
}

export interface LoadedPlugin {
  /** Plugin manifest from plugin.json */
  manifest: PluginManifest;
  basePath: string;
  source: PluginSource;
  manifestSource: ManifestSource;
  commands: PluginCommand[];
  agents: PluginAgent[];
  skills: PluginSkill[];
  hooks?: HookConfig;
  mcpServers?: Record<string, McpServerConfig>;
  lspServers?: Record<string, LspServerConfig>;
  status: PluginStatus;
  error?: string;

  /** Compatibility or source-policy reasons that prevent activation */
  compatibilityIssues?: PluginCompatibilityIssue[];

  /** Immutable package-manager installation metadata */
  installation?: InstalledPluginRecord;
  loadedAt: Date;
}

export interface PluginDiscoveryResult {
  plugins: LoadedPlugin[];
  errors: PluginDiscoveryError[];
}

export interface PluginDiscoveryError {
  path: string;
  error: string;
  code?: PluginErrorCode;
}

type PluginErrorCode =
  | 'INVALID_MANIFEST' // plugin.json is invalid
  | 'MANIFEST_NOT_FOUND' // No plugin.json found
  | 'INVALID_COMMAND' // Command file is invalid
  | 'INVALID_SKILL' // Skill is invalid
  | 'INVALID_AGENT' // Agent config is invalid
  | 'INVALID_HOOKS' // Hooks config is invalid
  | 'INVALID_MCP' // MCP config is invalid
  | 'INVALID_LSP' // LSP config is invalid
  | 'SOURCE_POLICY_BLOCKED' // Plugin source is denied by effective policy
  | 'VERSION_INCOMPATIBLE' // Plugin requires newer Blade version
  | 'DEPENDENCY_MISSING' // Required dependency not found
  | 'IO_ERROR'; // File system error

export interface PluginLoadOptions {
  skipCommands?: boolean;
  skipAgents?: boolean;
  skipSkills?: boolean;
  skipHooks?: boolean;
  skipMcp?: boolean;
  skipLsp?: boolean;
}

export interface PluginSearchDir {
  path: string;
  source: PluginSource;
  type: 'blade' | 'claude';
}
