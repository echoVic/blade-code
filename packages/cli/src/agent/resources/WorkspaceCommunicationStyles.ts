import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import matter from 'gray-matter';
import { createLogger, LogCategory } from '../../logging/Logger.js';
import type { LoadedPlugin } from '../../plugins/types.js';
import {
  CommunicationStyleCatalog,
  type CommunicationStyleDefinition,
  type CommunicationStyleSource,
} from '../../services/communicationStyle.js';

export const MAX_CUSTOM_COMMUNICATION_STYLES = 32;
export const MAX_COMMUNICATION_STYLE_FILE_BYTES = 24 * 1024;
export const MAX_COMMUNICATION_STYLE_PROMPT_BYTES = 16 * 1024;
export const MAX_COMMUNICATION_STYLE_TOTAL_BYTES = 128 * 1024;
const MAX_STYLE_DEPTH = 4;
const MAX_STYLE_NAME_LENGTH = 80;
const MAX_STYLE_DESCRIPTION_LENGTH = 256;
const STYLE_SEGMENT = /^[a-z0-9][a-z0-9._-]{0,63}$/;

const logger = createLogger(LogCategory.AGENT);

interface StyleRoot {
  directory: string;
  source: Exclude<CommunicationStyleSource, 'built-in'>;
  idPrefix: string;
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

function normalizeDescription(
  value: unknown,
  prompt: string,
  fallback: string
): string {
  const explicit = typeof value === 'string' ? value.trim() : '';
  const firstLine =
    prompt
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean)
      ?.replace(/^#+\s*/, '') ?? '';
  const description = explicit || firstLine || fallback;
  if (description.length > MAX_STYLE_DESCRIPTION_LENGTH) {
    throw new Error(`Description exceeds ${MAX_STYLE_DESCRIPTION_LENGTH} characters`);
  }
  if (containsHiddenControl(description)) {
    throw new Error('Description contains hidden control characters');
  }
  return description;
}

function normalizeName(value: unknown, fallback: string): string {
  const name = typeof value === 'string' && value.trim() ? value.trim() : fallback;
  if (name.length > MAX_STYLE_NAME_LENGTH) {
    throw new Error(`Name exceeds ${MAX_STYLE_NAME_LENGTH} characters`);
  }
  if (containsHiddenControl(name)) {
    throw new Error('Name contains hidden control characters');
  }
  return name;
}

function styleKey(relativePath: string): string {
  const withoutExtension = relativePath.replace(/\.md$/i, '');
  const segments = withoutExtension.split(path.sep);
  if (
    segments.length === 0 ||
    segments.length > MAX_STYLE_DEPTH ||
    segments.some((segment) => !STYLE_SEGMENT.test(segment))
  ) {
    throw new Error(`Style path must use 1-${MAX_STYLE_DEPTH} lowercase safe segments`);
  }
  return segments.join(':');
}

async function scanMarkdownFiles(root: string): Promise<string[]> {
  let rootStat;
  try {
    rootStat = await fs.lstat(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  if (rootStat.isSymbolicLink()) {
    throw new Error(`Output style root cannot be a symlink: ${root}`);
  }
  if (!rootStat.isDirectory()) return [];

  const canonicalRoot = await fs.realpath(root);
  const files: string[] = [];
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > MAX_STYLE_DEPTH) {
      throw new Error(`Output style directory exceeds depth ${MAX_STYLE_DEPTH}`);
    }
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Output style path cannot be a symlink: ${candidate}`);
      }
      if (entry.isDirectory()) {
        await visit(candidate, depth + 1);
        continue;
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue;
      const canonicalFile = await fs.realpath(candidate);
      const relative = path.relative(canonicalRoot, canonicalFile);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(`Output style path escapes its source root: ${candidate}`);
      }
      files.push(canonicalFile);
      if (files.length > MAX_CUSTOM_COMMUNICATION_STYLES) {
        throw new Error(
          `Output style catalog exceeds ${MAX_CUSTOM_COMMUNICATION_STYLES} files`
        );
      }
    }
  };
  await visit(canonicalRoot, 1);
  return files;
}

async function loadDefinition(
  root: StyleRoot,
  canonicalRoot: string,
  filePath: string
): Promise<CommunicationStyleDefinition> {
  const stat = await fs.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('Output style must be a regular file');
  }
  if (stat.size > MAX_COMMUNICATION_STYLE_FILE_BYTES) {
    throw new Error(`Output style exceeds ${MAX_COMMUNICATION_STYLE_FILE_BYTES} bytes`);
  }
  const raw = await fs.readFile(filePath, 'utf8');
  const parsed = matter(raw);
  const prompt = parsed.content.trim();
  const promptBytes = Buffer.byteLength(prompt);
  if (promptBytes === 0) throw new Error('Output style prompt must not be empty');
  if (promptBytes > MAX_COMMUNICATION_STYLE_PROMPT_BYTES) {
    throw new Error(
      `Output style prompt exceeds ${MAX_COMMUNICATION_STYLE_PROMPT_BYTES} bytes`
    );
  }
  if (containsHiddenControl(prompt)) {
    throw new Error('Output style prompt contains hidden control characters');
  }
  const relativePath = path.relative(canonicalRoot, filePath);
  const key = styleKey(relativePath);
  const id = `${root.idPrefix}:${key}` as CommunicationStyleDefinition['id'];
  return {
    id,
    name: normalizeName(parsed.data.name, key),
    description: normalizeDescription(
      parsed.data.description,
      prompt,
      `Custom ${key} communication style`
    ),
    source: root.source,
    contentSha256: createHash('sha256').update(prompt, 'utf8').digest('hex'),
    prompt,
  };
}

async function loadRoot(
  root: StyleRoot,
  definitions: Map<string, CommunicationStyleDefinition>
): Promise<void> {
  const files = await scanMarkdownFiles(root.directory);
  if (files.length === 0) return;
  const canonicalRoot = await fs.realpath(root.directory);
  for (const filePath of files) {
    try {
      const definition = await loadDefinition(root, canonicalRoot, filePath);
      definitions.set(definition.id, definition);
    } catch (error) {
      logger.warn(
        `[CommunicationStyles] Ignoring ${root.source} style: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }
}

function styleRoots(
  workspaceRoot: string,
  projectTrusted: boolean,
  plugins: readonly LoadedPlugin[],
  homeDirectory: string
): StyleRoot[] {
  const roots: StyleRoot[] = [
    {
      directory: path.join(homeDirectory, '.claude', 'output-styles'),
      source: 'user',
      idPrefix: 'user',
    },
    {
      directory: path.join(homeDirectory, '.blade', 'output-styles'),
      source: 'user',
      idPrefix: 'user',
    },
  ];
  if (projectTrusted) {
    roots.push(
      {
        directory: path.join(workspaceRoot, '.claude', 'output-styles'),
        source: 'project',
        idPrefix: 'project',
      },
      {
        directory: path.join(workspaceRoot, '.blade', 'output-styles'),
        source: 'project',
        idPrefix: 'project',
      }
    );
  }
  for (const plugin of plugins) {
    if (plugin.status !== 'active' || !STYLE_SEGMENT.test(plugin.manifest.name)) {
      continue;
    }
    roots.push({
      directory: path.join(plugin.basePath, 'output-styles'),
      source: 'plugin',
      idPrefix: `plugin:${plugin.manifest.name}`,
    });
  }
  return roots;
}

export async function resolveWorkspaceCommunicationStyles(
  workspaceRoot: string,
  options: {
    projectTrusted: boolean;
    plugins?: readonly LoadedPlugin[];
    homeDirectory?: string;
  }
): Promise<CommunicationStyleCatalog> {
  const definitions = new Map<string, CommunicationStyleDefinition>();
  for (const root of styleRoots(
    path.resolve(workspaceRoot),
    options.projectTrusted,
    options.plugins ?? [],
    options.homeDirectory ?? os.homedir()
  )) {
    await loadRoot(root, definitions);
  }
  let totalBytes = 0;
  for (const definition of definitions.values()) {
    totalBytes += Buffer.byteLength(definition.prompt ?? '');
  }
  if (definitions.size > MAX_CUSTOM_COMMUNICATION_STYLES) {
    throw new Error(
      `Output style catalog exceeds ${MAX_CUSTOM_COMMUNICATION_STYLES} styles`
    );
  }
  if (totalBytes > MAX_COMMUNICATION_STYLE_TOTAL_BYTES) {
    throw new Error(
      `Output style catalog exceeds ${MAX_COMMUNICATION_STYLE_TOTAL_BYTES} bytes`
    );
  }
  return new CommunicationStyleCatalog([...definitions.values()]);
}
