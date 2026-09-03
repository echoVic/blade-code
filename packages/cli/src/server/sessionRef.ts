import { realpathSync } from 'node:fs';
import path from 'node:path';
import {
  assertValidSessionId,
  getBladeStorageRoot,
} from '../context/storage/pathUtils.js';

export interface SessionRef {
  sessionId: string;
  projectPath: string;
}

function resolveThroughExistingAncestor(value: string): string {
  let candidate = path.resolve(value);
  const suffix: string[] = [];
  while (true) {
    try {
      return path.resolve(realpathSync.native(candidate), ...suffix.reverse());
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
      const parent = path.dirname(candidate);
      if (parent === candidate) return path.resolve(value);
      suffix.push(path.basename(candidate));
      candidate = parent;
    }
  }
}

export function normalizeLocalWorkspacePath(
  projectPath: string,
  label: 'projectPath' | 'directory' | 'cwd' = 'projectPath'
): string {
  if (!path.isAbsolute(projectPath)) {
    throw new Error(`${label} must be absolute`);
  }
  const normalized = path.resolve(projectPath);
  const canonical = resolveThroughExistingAncestor(normalized);
  const remoteNamespace = path.join(
    resolveThroughExistingAncestor(getBladeStorageRoot()),
    'acp-remote-workspaces'
  );
  const relativeToRemoteNamespace = path.relative(remoteNamespace, canonical);
  const remoteRootSegment = relativeToRemoteNamespace.split(path.sep)[0];
  const isProtectedRemoteStatePath =
    relativeToRemoteNamespace === '' ||
    (relativeToRemoteNamespace !== '..' &&
      !path.isAbsolute(relativeToRemoteNamespace) &&
      !relativeToRemoteNamespace.startsWith(`..${path.sep}`) &&
      remoteRootSegment !== undefined &&
      /^[a-f0-9]{64}$/i.test(remoteRootSegment));
  if (isProtectedRemoteStatePath) {
    throw new Error(`${label} must reference a local workspace`);
  }
  return normalized;
}

export function normalizeSessionRef(ref: SessionRef): SessionRef {
  assertValidSessionId(ref.sessionId);
  if (!path.isAbsolute(ref.projectPath)) {
    throw new Error('projectPath must be absolute');
  }
  return {
    sessionId: ref.sessionId,
    projectPath: path.resolve(ref.projectPath),
  };
}

export function sessionRefKey(ref: SessionRef): string {
  const normalized = normalizeSessionRef(ref);
  return JSON.stringify([normalized.projectPath, normalized.sessionId]);
}

export function sameSessionRef(left: SessionRef, right: SessionRef): boolean {
  return sessionRefKey(left) === sessionRefKey(right);
}
