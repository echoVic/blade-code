import * as fs from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import {
  MAX_PROJECT_RULE_FILE_BYTES,
  MAX_PROJECT_RULE_FILES,
  MAX_STATIC_PROJECT_RULE_BYTES,
  resolveWorkspaceProjectRules,
} from '../../agent/resources/WorkspaceProjectRules.js';
import { PermissionChecker, PermissionResult } from '../../config/PermissionChecker.js';
import type { BladeConfig, PermissionConfig } from '../../config/types.js';
import { AutoMemoryManager } from '../../memory/AutoMemoryManager.js';
import { DEFAULT_AUTO_MEMORY_CONFIG } from '../../memory/types.js';
import { WorkspaceTrustService } from '../../security/WorkspaceTrustService.js';
import { getRipgrep } from '../../tools/builtin/search/ripgrep.js';
import { checkDoctorMcpServers } from './mcp.js';

export interface DoctorDiagnostic {
  level: 'ok' | 'warn';
  name: string;
  message: string;
}

export function diagnoseModels(
  config: Pick<BladeConfig, 'models' | 'currentModelId'>
): DoctorDiagnostic {
  if (config.models.length === 0) {
    return {
      level: 'warn',
      name: 'Models',
      message: 'No model configured; start blade and use /model.',
    };
  }
  const selected = config.models.find((model) => model.id === config.currentModelId);
  return selected
    ? {
        level: 'ok',
        name: 'Models',
        message: `${config.models.length} configured; current: ${selected.id}`,
      }
    : {
        level: 'warn',
        name: 'Models',
        message: 'Current model does not match a configured model; use /model.',
      };
}

export function diagnosePermissionRules(config: PermissionConfig): DoctorDiagnostic[] {
  const results: DoctorDiagnostic[] = [];
  const earlier: Array<{ decision: string; rule: string }> = [];
  for (const decision of ['deny', 'allow', 'ask'] as const) {
    for (const rule of config[decision]) {
      if (!/^(?:\*|\*\*|[A-Za-z0-9_*?-]+(?:\([\s\S]*\))?)$/.test(rule)) {
        results.push({
          level: 'warn',
          name: 'Permissions',
          message: `Invalid ${decision} rule: ${rule}`,
        });
      }
      if (
        /^(?:Read|Edit|Write)\(file_path:/.test(rule) ||
        /^Bash\((?:command:|[^():]+:\*)/.test(rule) ||
        /^WebFetch\(url:/.test(rule)
      ) {
        results.push({
          level: 'warn',
          name: 'Permissions',
          message: `Rule uses a different signature from the builtin tool: ${rule}. See permission rule documentation.`,
        });
      }
      if (/^Read\(\.\//.test(rule)) {
        results.push({
          level: 'warn',
          name: 'Permissions',
          message: `Read uses absolute paths; this relative rule cannot match: ${rule}`,
        });
      }
      const toolName = /^([A-Za-z0-9_-]+)(?:\(|$)/.exec(rule)?.[1];
      if (toolName) {
        const shadow = earlier.find((entry) => {
          if (entry.decision === decision || entry.rule.includes('(')) return false;
          const result = new PermissionChecker({
            allow: [],
            ask: [],
            deny: [entry.rule],
          }).check({ toolName, params: {} });
          return result.result === PermissionResult.DENY;
        });
        if (shadow) {
          results.push({
            level: 'warn',
            name: 'Permissions',
            message: `${decision} rule ${rule} is shadowed by ${shadow.decision} rule ${shadow.rule}.`,
          });
        }
      }
      earlier.push({ decision, rule });
    }
  }
  return results.length > 0
    ? results
    : [
        {
          level: 'ok',
          name: 'Permissions',
          message: 'No known ineffective or shadowed rules.',
        },
      ];
}

async function inspectProjectInstructions(
  cwd: string,
  projectTrusted: boolean
): Promise<DoctorDiagnostic[]> {
  const rootCatalog = await resolveWorkspaceProjectRules(cwd, {
    projectTrusted: false,
  });
  const results: DoctorDiagnostic[] = [];
  const files = await fg(
    [
      '**/AGENTS.md',
      '**/AGENTS.override.md',
      '**/BLADE.md',
      '**/CLAUDE.md',
      '**/CLAUDE.local.md',
      '**/.claude/rules/**/*.md',
      '**/.blade/rules/**/*.md',
    ],
    {
      cwd: rootCatalog.projectRoot,
      dot: true,
      onlyFiles: true,
      followSymbolicLinks: false,
      deep: 24,
      ignore: [
        '**/.git/**',
        '**/node_modules/**',
        '**/.venv/**',
        '**/dist/**',
        '**/build/**',
        '**/coverage/**',
        '**/target/**',
      ],
    }
  );
  if (files.length > MAX_PROJECT_RULE_FILES) {
    results.push({
      level: 'warn',
      name: 'Project instructions',
      message: `${files.length} files exceeds the ${MAX_PROJECT_RULE_FILES}-file catalog limit.`,
    });
  }
  for (const relative of files) {
    const stat = await fs.lstat(path.join(rootCatalog.projectRoot, relative));
    if (stat.size > MAX_PROJECT_RULE_FILE_BYTES) {
      results.push({
        level: 'warn',
        name: 'Project instructions',
        message: `${relative}: ${stat.size} bytes exceeds ${MAX_PROJECT_RULE_FILE_BYTES}; ignored at runtime.`,
      });
    }
  }
  if (projectTrusted && files.length <= MAX_PROJECT_RULE_FILES) {
    const catalog = await resolveWorkspaceProjectRules(cwd, { projectTrusted });
    const unrestricted = catalog.staticRules(cwd, Number.MAX_SAFE_INTEGER);
    const bounded = catalog.staticRules(cwd);
    if (unrestricted.files.length !== bounded.files.length) {
      results.push({
        level: 'warn',
        name: 'Project instructions',
        message: `${unrestricted.files.length - bounded.files.length} static files omitted by the ${MAX_STATIC_PROJECT_RULE_BYTES}-byte budget.`,
      });
    }
  }
  return results.length > 0
    ? results
    : [
        {
          level: 'ok',
          name: 'Project instructions',
          message: `${files.length} files; no file-size or static-budget warnings.`,
        },
      ];
}

async function inspectAutoMemory(cwd: string): Promise<DoctorDiagnostic> {
  const memoryDir = new AutoMemoryManager(cwd).getMemoryDir();
  let content: string;
  try {
    content = await fs.readFile(path.join(memoryDir, 'MEMORY.md'), 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return { level: 'ok', name: 'Auto Memory', message: 'No index yet.' };
    }
    throw error;
  }
  const lines = content.split('\n').length;
  const limit = DEFAULT_AUTO_MEMORY_CONFIG.maxIndexLines;
  return lines > limit
    ? {
        level: 'warn',
        name: 'Auto Memory',
        message: `MEMORY.md has ${lines} lines; only the first ${limit} load at startup. Move details into topic files.`,
      }
    : {
        level: 'ok',
        name: 'Auto Memory',
        message: `MEMORY.md: ${lines}/${limit} lines.`,
      };
}

export async function collectDoctorDiagnostics(
  config: BladeConfig,
  cwd: string
): Promise<DoctorDiagnostic[]> {
  const diagnostics = [
    diagnoseModels(config),
    ...diagnosePermissionRules(config.permissions),
  ];
  const checks: Array<[string, () => Promise<DoctorDiagnostic | DoctorDiagnostic[]>]> =
    [
      [
        'Workspace Trust',
        async () => {
          const trust = await WorkspaceTrustService.getInstance().getStatus(cwd);
          return {
            level:
              trust.state === 'untrusted' || trust.state === 'error' ? 'warn' : 'ok',
            name: 'Workspace Trust',
            message:
              trust.state === 'untrusted'
                ? `${trust.sensitiveSources} project sources are not trusted; review with /trust and approve if appropriate.`
                : trust.state,
          };
        },
      ],
      [
        'Project instructions',
        async () => {
          const trust = await WorkspaceTrustService.getInstance().getStatus(cwd);
          return inspectProjectInstructions(cwd, trust.state === 'trusted');
        },
      ],
      ['Auto Memory', () => inspectAutoMemory(cwd)],
      ['MCP', () => checkDoctorMcpServers(config.mcpServers, cwd)],
    ];
  for (const [name, check] of checks) {
    try {
      const result = await check();
      diagnostics.push(...(Array.isArray(result) ? result : [result]));
    } catch {
      diagnostics.push({
        level: 'warn',
        name,
        message: 'Could not complete this diagnostic.',
      });
    }
  }
  const rg = getRipgrep();
  diagnostics.push(
    rg
      ? {
          level: 'ok',
          name: 'ripgrep',
          message: rg.bundled
            ? 'Bundled executable available.'
            : 'External executable available.',
        }
      : {
          level: 'warn',
          name: 'ripgrep',
          message: 'Unavailable; search uses the slower fallback.',
        }
  );
  return diagnostics;
}
