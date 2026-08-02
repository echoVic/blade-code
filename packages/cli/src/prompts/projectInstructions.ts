import { promises as fs } from 'fs';
import path from 'path';
import { getOriginalCwd } from '../bootstrap/state.js';
import { findProjectRoot } from '../utils/environment.js';

export const PROJECT_INSTRUCTIONS_MAX_BYTES = 32 * 1024;

const INSTRUCTION_FILENAMES = ['CLAUDE.md', 'AGENTS.md', 'BLADE.md'] as const;

export interface ProjectInstructionFile {
  path: string;
  content: string;
  truncated: boolean;
}

export interface LoadedProjectInstructions {
  content: string;
  files: ProjectInstructionFile[];
  contentBytes: number;
}

function getSearchDirectories(projectPath: string): {
  root: string;
  directories: string[];
} {
  const workspace = path.resolve(projectPath);
  const invocationDirectory = path.resolve(getOriginalCwd());
  const relativeInvocation = path.relative(workspace, invocationDirectory);
  const invocationIsInWorkspace =
    relativeInvocation === '' ||
    (!relativeInvocation.startsWith('..') && !path.isAbsolute(relativeInvocation));
  const workingDirectory = invocationIsInWorkspace ? invocationDirectory : workspace;
  const root = path.resolve(findProjectRoot(workingDirectory));
  const directories: string[] = [];
  let current = workingDirectory;

  while (true) {
    directories.push(current);
    if (current === root) {
      break;
    }

    const parent = path.dirname(current);
    if (parent === current || !current.startsWith(`${root}${path.sep}`)) {
      return { root: workingDirectory, directories: [workingDirectory] };
    }
    current = parent;
  }

  directories.reverse();
  return { root, directories };
}

function truncateUtf8(content: string, maxBytes: number): string {
  const encoded = Buffer.from(content, 'utf8');
  if (encoded.length <= maxBytes) {
    return content;
  }

  return encoded
    .subarray(0, maxBytes)
    .toString('utf8')
    .replace(/\uFFFD+$/u, '');
}

function displayPath(root: string, filePath: string): string {
  const relativePath = path.relative(root, filePath) || path.basename(filePath);
  return relativePath
    .split(path.sep)
    .join('/')
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

async function readInstructionFile(
  filePath: string
): Promise<ProjectInstructionFile | null> {
  try {
    const content = (await fs.readFile(filePath, 'utf8')).trim();
    return content ? { path: filePath, content, truncated: false } : null;
  } catch {
    return null;
  }
}

/**
 * Loads repository instructions from low to high precedence. More specific
 * directories and Blade-native files are rendered later in the prompt.
 */
export async function loadProjectInstructions(
  projectPath: string,
  maxBytes = PROJECT_INSTRUCTIONS_MAX_BYTES
): Promise<LoadedProjectInstructions | null> {
  if (maxBytes <= 0) {
    return null;
  }

  const { root, directories } = getSearchDirectories(projectPath);
  const candidates = directories.flatMap((directory) =>
    INSTRUCTION_FILENAMES.map((filename) => path.join(directory, filename))
  );
  const files = (await Promise.all(candidates.map(readInstructionFile))).filter(
    (file): file is ProjectInstructionFile => file !== null
  );

  if (files.length === 0) {
    return null;
  }

  let remainingBytes = maxBytes;
  const retained: ProjectInstructionFile[] = [];

  for (let index = files.length - 1; index >= 0 && remainingBytes > 0; index -= 1) {
    const file = files[index];
    if (!file) {
      continue;
    }

    const originalBytes = Buffer.byteLength(file.content, 'utf8');
    const content = truncateUtf8(file.content, remainingBytes);
    const contentBytes = Buffer.byteLength(content, 'utf8');
    if (contentBytes === 0) {
      continue;
    }

    retained.push({
      ...file,
      content,
      truncated: contentBytes < originalBytes,
    });
    remainingBytes -= contentBytes;
  }

  retained.reverse();
  const renderedFiles = retained.map((file) => {
    const truncated = file.truncated ? ' truncated="true"' : '';
    return `<instruction-file path="${displayPath(root, file.path)}"${truncated}>\n${file.content}\n</instruction-file>`;
  });

  return {
    content: `<project-instructions>\n${renderedFiles.join('\n\n')}\n</project-instructions>`,
    files: retained,
    contentBytes: maxBytes - remainingBytes,
  };
}
