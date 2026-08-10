import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import matter from 'gray-matter';
import picomatch from 'picomatch';
import { createLogger, LogCategory } from '../../logging/Logger.js';

export const MAX_PROJECT_RULE_FILES = 128;
export const MAX_PROJECT_RULE_FILE_BYTES = 32 * 1024;
export const MAX_PROJECT_RULE_CATALOG_BYTES = 256 * 1024;
export const MAX_STATIC_PROJECT_RULE_BYTES = 48 * 1024;
export const MAX_CONTEXTUAL_PROJECT_RULE_BYTES = 32 * 1024;
export const MAX_PROJECT_RULE_DEPTH = 24;
const MAX_RULE_PATTERNS = 16;
const MAX_RULE_PATTERN_LENGTH = 256;

const logger = createLogger(LogCategory.AGENT);

export type ProjectRuleSource = 'project' | 'local';
export type ProjectRuleKind = 'instruction' | 'rule';

export interface ProjectRuleSummary {
  id: string;
  relativePath: string;
  source: ProjectRuleSource;
  kind: ProjectRuleKind;
  conditional: boolean;
  contentSha256: string;
}

export interface ProjectRuleReference {
  id: string;
  relativePath: string;
  source: ProjectRuleSource;
  contentSha256: string;
}

export interface ProjectRuleDefinition extends ProjectRuleSummary {
  scopeDirectory: string;
  patterns?: string[];
  content: string;
  priority: number;
}

export interface ProjectRuleResolution {
  content: string;
  files: ProjectRuleDefinition[];
  references: ProjectRuleReference[];
  triggerPaths: string[];
  contentBytes: number;
  provenanceSha256: string;
}

const DISCOVERY_PATTERNS = [
  '**/CLAUDE.md',
  '**/.claude/CLAUDE.md',
  '**/CLAUDE.local.md',
  '**/AGENTS.md',
  '**/AGENTS.override.md',
  '**/BLADE.md',
  '**/.claude/rules/**/*.md',
  '**/.blade/rules/**/*.md',
] as const;

const DISCOVERY_IGNORES = [
  '**/.git/**',
  '**/node_modules/**',
  '**/.venv/**',
  '**/dist/**',
  '**/build/**',
  '**/coverage/**',
  '**/target/**',
] as const;

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function containsHiddenControl(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (
      codePoint <= 0x08 ||
      codePoint === 0x0b ||
      codePoint === 0x0c ||
      (codePoint >= 0x0e && codePoint <= 0x1f) ||
      codePoint === 0x7f ||
      (codePoint >= 0x200b && codePoint <= 0x200f) ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2060 && codePoint <= 0x206f) ||
      codePoint === 0xfeff
    ) {
      return true;
    }
  }
  return false;
}

function normalizeRelativePath(value: string): string {
  return value.split(path.sep).join('/');
}

function canonicalizePotentialPath(value: string): string {
  let current = path.resolve(value);
  const suffix: string[] = [];
  while (true) {
    try {
      return path.join(realpathSync(current), ...suffix.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        return path.resolve(value);
      }
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(value);
      suffix.push(path.basename(current));
      current = parent;
    }
  }
}

function findRuleRepositoryRoot(startDirectory: string): string {
  let current = path.resolve(startDirectory);
  let fallback: string | undefined;
  while (true) {
    if (existsSync(path.join(current, '.git'))) return current;
    if (
      !fallback &&
      (existsSync(path.join(current, '.blade')) ||
        existsSync(path.join(current, '.claude')) ||
        existsSync(path.join(current, 'package.json')))
    ) {
      fallback = current;
    }
    const parent = path.dirname(current);
    if (parent === current) return fallback ?? path.resolve(startDirectory);
    current = parent;
  }
}

function isContainedRelative(value: string): boolean {
  return Boolean(value) && value !== '..' && !value.startsWith('../');
}

function isAncestorDirectory(ancestor: string, target: string): boolean {
  return ancestor === '' || target === ancestor || target.startsWith(`${ancestor}/`);
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function normalizePatterns(value: unknown): string[] | undefined {
  const values =
    typeof value === 'string'
      ? value.split(/[,\n]/u)
      : Array.isArray(value)
        ? value
        : [];
  const patterns = [
    ...new Set(
      values
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim().replaceAll('\\', '/'))
        .filter(Boolean)
    ),
  ];
  if (patterns.length === 0 || patterns.every((pattern) => pattern === '**')) {
    return undefined;
  }
  if (patterns.length > MAX_RULE_PATTERNS) {
    throw new Error(`paths exceeds ${MAX_RULE_PATTERNS} patterns`);
  }
  for (const pattern of patterns) {
    if (
      pattern.length > MAX_RULE_PATTERN_LENGTH ||
      path.posix.isAbsolute(pattern) ||
      pattern.split('/').includes('..') ||
      containsHiddenControl(pattern)
    ) {
      throw new Error(`Unsafe project rule path pattern: ${pattern.slice(0, 80)}`);
    }
    picomatch(pattern, { dot: true });
  }
  return patterns;
}

function classify(relativePath: string): {
  source: ProjectRuleSource;
  kind: ProjectRuleKind;
  scopeDirectory: string;
  priority: number;
} {
  if (relativePath.endsWith('/CLAUDE.local.md') || relativePath === 'CLAUDE.local.md') {
    return {
      source: 'local',
      kind: 'instruction',
      scopeDirectory: path.posix.dirname(relativePath).replace(/^\.$/u, ''),
      priority: 90,
    };
  }
  for (const marker of ['.claude/rules/', '.blade/rules/'] as const) {
    const index = relativePath.indexOf(marker);
    if (index >= 0) {
      return {
        source: 'project',
        kind: 'rule',
        scopeDirectory: relativePath.slice(0, index).replace(/\/$/u, ''),
        priority: marker.startsWith('.blade') ? 80 : 70,
      };
    }
  }
  if (
    relativePath.endsWith('/.claude/CLAUDE.md') ||
    relativePath === '.claude/CLAUDE.md'
  ) {
    const scope = relativePath.slice(0, -'.claude/CLAUDE.md'.length);
    return {
      source: 'project',
      kind: 'instruction',
      scopeDirectory: scope.replace(/\/$/u, ''),
      priority: 30,
    };
  }
  const basename = path.posix.basename(relativePath);
  const priority =
    basename === 'CLAUDE.md'
      ? 20
      : basename === 'AGENTS.md'
        ? 40
        : basename === 'AGENTS.override.md'
          ? 50
          : 60;
  return {
    source: 'project',
    kind: 'instruction',
    scopeDirectory: path.posix.dirname(relativePath).replace(/^\.$/u, ''),
    priority,
  };
}

function definitionOrder(
  left: ProjectRuleDefinition,
  right: ProjectRuleDefinition
): number {
  const leftDepth = left.scopeDirectory ? left.scopeDirectory.split('/').length : 0;
  const rightDepth = right.scopeDirectory ? right.scopeDirectory.split('/').length : 0;
  return (
    leftDepth - rightDepth ||
    left.priority - right.priority ||
    left.relativePath.localeCompare(right.relativePath)
  );
}

function reference(definition: ProjectRuleDefinition): ProjectRuleReference {
  return {
    id: definition.id,
    relativePath: definition.relativePath,
    source: definition.source,
    contentSha256: definition.contentSha256,
  };
}

function renderResolution(
  definitions: readonly ProjectRuleDefinition[],
  triggerPaths: readonly string[],
  tag: 'project-instructions' | 'contextual-project-instructions'
): ProjectRuleResolution {
  const rendered = definitions.map((definition) => {
    const conditional = definition.conditional ? ' conditional="true"' : '';
    return `<instruction-file path="${escapeAttribute(
      definition.relativePath
    )}" source="${definition.source}" sha256="${
      definition.contentSha256
    }"${conditional}>\n${definition.content}\n</instruction-file>`;
  });
  const trigger =
    tag === 'contextual-project-instructions' && triggerPaths.length > 0
      ? ` trigger-paths="${escapeAttribute(triggerPaths.join(','))}"`
      : '';
  const content =
    rendered.length > 0
      ? `<${tag}${trigger}>\n${rendered.join('\n\n')}\n</${tag}>`
      : '';
  return {
    content,
    files: [...definitions],
    references: definitions.map(reference),
    triggerPaths: [...triggerPaths],
    contentBytes: Buffer.byteLength(content, 'utf8'),
    provenanceSha256: sha256(
      definitions.map((item) => `${item.id}:${item.contentSha256}`).join('\n')
    ),
  };
}

function retainWithinBudget(
  definitions: readonly ProjectRuleDefinition[],
  maxBytes: number
): ProjectRuleDefinition[] {
  let remaining = maxBytes;
  const retained: ProjectRuleDefinition[] = [];
  for (let index = definitions.length - 1; index >= 0; index -= 1) {
    const definition = definitions[index];
    if (!definition) continue;
    const bytes = Buffer.byteLength(definition.content, 'utf8');
    if (bytes > remaining) continue;
    retained.push(definition);
    remaining -= bytes;
  }
  return retained.reverse();
}

export class ProjectRuleCatalog {
  readonly catalogSha256: string;
  private readonly definitions: readonly ProjectRuleDefinition[];
  private readonly byId: ReadonlyMap<string, ProjectRuleDefinition>;

  constructor(
    readonly projectRoot: string,
    definitions: readonly ProjectRuleDefinition[] = []
  ) {
    this.projectRoot = canonicalizePotentialPath(projectRoot);
    this.definitions = Object.freeze(
      [...definitions].sort(definitionOrder).map((item) => Object.freeze({ ...item }))
    );
    this.byId = new Map(this.definitions.map((item) => [item.id, item]));
    this.catalogSha256 = sha256(
      this.definitions.map((item) => `${item.id}:${item.contentSha256}`).join('\n')
    );
  }

  static empty(projectRoot: string): ProjectRuleCatalog {
    return new ProjectRuleCatalog(projectRoot);
  }

  list(): ProjectRuleSummary[] {
    return this.definitions.map((item) => ({
      id: item.id,
      relativePath: item.relativePath,
      source: item.source,
      kind: item.kind,
      conditional: item.conditional,
      contentSha256: item.contentSha256,
    }));
  }

  snapshot(): ProjectRuleCatalog {
    return new ProjectRuleCatalog(
      this.projectRoot,
      this.definitions.map((item) => ({
        ...item,
        patterns: item.patterns ? [...item.patterns] : undefined,
      }))
    );
  }

  staticRules(
    sourceWorkspaceRoot: string,
    maxBytes = MAX_STATIC_PROJECT_RULE_BYTES
  ): ProjectRuleResolution {
    if (this.definitions.length === 0) {
      return renderResolution([], [], 'project-instructions');
    }
    const sourceRelative = this.relativeSourcePath(sourceWorkspaceRoot);
    const definitions = this.definitions.filter(
      (item) =>
        !item.conditional && isAncestorDirectory(item.scopeDirectory, sourceRelative)
    );
    return renderResolution(
      retainWithinBudget(definitions, maxBytes),
      [],
      'project-instructions'
    );
  }

  contextualRules(
    sourceWorkspaceRoot: string,
    targetPaths: readonly string[],
    loadedIds: ReadonlySet<string>,
    maxBytes = MAX_CONTEXTUAL_PROJECT_RULE_BYTES
  ): ProjectRuleResolution {
    if (this.definitions.length === 0) {
      return renderResolution([], [], 'contextual-project-instructions');
    }
    const sourceRelative = this.relativeSourcePath(sourceWorkspaceRoot);
    const triggerPaths = [
      ...new Set(
        targetPaths
          .map((target) =>
            normalizeRelativePath(
              path.relative(this.projectRoot, canonicalizePotentialPath(target))
            )
          )
          .filter(isContainedRelative)
      ),
    ].sort();
    const selected = new Map<string, ProjectRuleDefinition>();
    for (const targetRelative of triggerPaths) {
      for (const definition of this.definitions) {
        if (loadedIds.has(definition.id)) continue;
        if (!isAncestorDirectory(definition.scopeDirectory, targetRelative)) {
          continue;
        }
        if (definition.conditional) {
          const scopedTarget = path.posix.relative(
            definition.scopeDirectory || '.',
            targetRelative
          );
          if (
            !definition.patterns?.some((pattern) =>
              picomatch(pattern, { dot: true })(scopedTarget)
            )
          ) {
            continue;
          }
        } else if (isAncestorDirectory(definition.scopeDirectory, sourceRelative)) {
          continue;
        }
        selected.set(definition.id, definition);
      }
    }
    const retained = retainWithinBudget(
      [...selected.values()].sort(definitionOrder),
      maxBytes
    );
    return renderResolution(retained, triggerPaths, 'contextual-project-instructions');
  }

  hydrate(references: readonly ProjectRuleReference[]): ProjectRuleResolution {
    const definitions = references.map((item) => {
      const definition = this.byId.get(item.id);
      if (
        !definition ||
        definition.contentSha256 !== item.contentSha256 ||
        definition.relativePath !== item.relativePath ||
        definition.source !== item.source
      ) {
        throw new Error(`Project rule provenance mismatch: ${item.relativePath}`);
      }
      return definition;
    });
    return renderResolution(
      [...new Map(definitions.map((item) => [item.id, item])).values()].sort(
        definitionOrder
      ),
      [],
      'contextual-project-instructions'
    );
  }

  private relativeSourcePath(sourceWorkspaceRoot: string): string {
    const relative = normalizeRelativePath(
      path.relative(this.projectRoot, canonicalizePotentialPath(sourceWorkspaceRoot))
    );
    if (relative && !isContainedRelative(relative)) {
      throw new Error('Project instruction source is outside the catalog root');
    }
    return relative;
  }
}

async function loadDefinition(
  canonicalRoot: string,
  filePath: string
): Promise<ProjectRuleDefinition> {
  const stat = await fs.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('Project rule must be a regular file');
  }
  if (stat.size > MAX_PROJECT_RULE_FILE_BYTES) {
    throw new Error(`Project rule exceeds ${MAX_PROJECT_RULE_FILE_BYTES} bytes`);
  }
  const canonicalFile = await fs.realpath(filePath);
  const relative = normalizeRelativePath(path.relative(canonicalRoot, canonicalFile));
  if (!isContainedRelative(relative)) {
    throw new Error('Project rule escapes its repository root');
  }
  const raw = await fs.readFile(canonicalFile, 'utf8');
  if (containsHiddenControl(raw)) {
    throw new Error('Project rule contains hidden control characters');
  }
  const parsed = matter(raw);
  const content = parsed.content.trim();
  if (!content) throw new Error('Project rule content must not be empty');
  const patterns = normalizePatterns(parsed.data.paths);
  const classification = classify(relative);
  const contentSha256 = sha256(
    JSON.stringify({
      relativePath: relative,
      patterns: patterns ?? [],
      content,
    })
  );
  return {
    id: `${classification.source}:${sha256(relative).slice(0, 20)}`,
    relativePath: relative,
    source: classification.source,
    kind: classification.kind,
    scopeDirectory: classification.scopeDirectory,
    priority: classification.priority,
    conditional: Boolean(patterns),
    ...(patterns ? { patterns } : {}),
    content,
    contentSha256,
  };
}

export async function resolveWorkspaceProjectRules(
  sourceWorkspaceRoot: string,
  options: { projectTrusted: boolean }
): Promise<ProjectRuleCatalog> {
  const repositoryRoot = findRuleRepositoryRoot(sourceWorkspaceRoot);
  if (!options.projectTrusted) return ProjectRuleCatalog.empty(repositoryRoot);
  const canonicalRoot = await fs.realpath(repositoryRoot);
  const candidates = fg.stream([...DISCOVERY_PATTERNS], {
    cwd: canonicalRoot,
    absolute: true,
    dot: true,
    deep: MAX_PROJECT_RULE_DEPTH,
    onlyFiles: true,
    followSymbolicLinks: false,
    unique: true,
    ignore: [...DISCOVERY_IGNORES],
  });
  const discovered: string[] = [];
  for await (const candidate of candidates) {
    discovered.push(candidate.toString());
    if (discovered.length > MAX_PROJECT_RULE_FILES) {
      throw new Error(`Project rule catalog exceeds ${MAX_PROJECT_RULE_FILES} files`);
    }
  }
  discovered.sort();
  const overrideDirectories = new Set(
    discovered
      .filter((filePath) => path.basename(filePath) === 'AGENTS.override.md')
      .map((filePath) => path.dirname(filePath))
  );
  const definitions: ProjectRuleDefinition[] = [];
  let totalBytes = 0;
  for (const filePath of discovered) {
    if (
      path.basename(filePath) === 'AGENTS.md' &&
      overrideDirectories.has(path.dirname(filePath))
    ) {
      continue;
    }
    try {
      const definition = await loadDefinition(canonicalRoot, filePath);
      totalBytes += Buffer.byteLength(definition.content, 'utf8');
      if (totalBytes > MAX_PROJECT_RULE_CATALOG_BYTES) {
        throw new Error(
          `Project rule catalog exceeds ${MAX_PROJECT_RULE_CATALOG_BYTES} bytes`
        );
      }
      definitions.push(definition);
    } catch (error) {
      logger.warn(
        `[ProjectRules] Ignoring rule: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }
  return new ProjectRuleCatalog(canonicalRoot, definitions);
}
