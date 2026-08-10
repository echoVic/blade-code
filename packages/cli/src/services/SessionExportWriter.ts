import { mkdir, open, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { SessionMarkdownExport } from './SessionMarkdownExporter.js';

function resolveRequestedPath(
  cwd: string,
  requestedPath: string | undefined,
  defaultFilename: string
): string {
  const candidate = requestedPath?.trim() || defaultFilename;
  if (candidate.includes('\0')) {
    throw new Error('Session export path contains a null byte');
  }
  if (candidate === '~') return path.join(os.homedir(), defaultFilename);
  if (candidate.startsWith(`~${path.sep}`) || candidate.startsWith('~/')) {
    return path.resolve(os.homedir(), candidate.slice(2));
  }
  return path.resolve(cwd, candidate);
}

export async function writeSessionMarkdownExport(
  cwd: string,
  exported: SessionMarkdownExport,
  requestedPath?: string
): Promise<string> {
  if (!path.isAbsolute(cwd)) {
    throw new Error('Session export cwd must be absolute');
  }
  const outputPath = resolveRequestedPath(cwd, requestedPath, exported.filename);
  await mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 });

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let created = false;
  try {
    handle = await open(outputPath, 'wx', 0o600);
    created = true;
    await handle.writeFile(exported.markdown, 'utf8');
    await handle.sync();
    return outputPath;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    handle = undefined;
    if (created) {
      await unlink(outputPath).catch(() => undefined);
    }
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`Session export already exists: ${outputPath}`);
    }
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
