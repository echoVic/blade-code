import path from 'node:path';
import {
  assertValidSessionId,
  getBladeStorageRoot,
  isAcpRemoteHostStateRoot,
} from '../context/storage/pathUtils.js';

export interface SessionRef {
  sessionId: string;
  projectPath: string;
}

export function normalizeLocalWorkspacePath(
  projectPath: string,
  label: 'projectPath' | 'directory' | 'cwd' = 'projectPath'
): string {
  if (!path.isAbsolute(projectPath)) {
    throw new Error(`${label} must be absolute`);
  }
  const normalized = path.resolve(projectPath);
  const remoteNamespace = path.join(
    path.resolve(getBladeStorageRoot()),
    'acp-remote-workspaces'
  );
  const relativeToRemoteNamespace = path.relative(remoteNamespace, normalized);
  const remoteRootSegment = relativeToRemoteNamespace.split(path.sep)[0];
  const isProtectedRemoteStatePath =
    relativeToRemoteNamespace === '' ||
    (relativeToRemoteNamespace !== '..' &&
      !path.isAbsolute(relativeToRemoteNamespace) &&
      !relativeToRemoteNamespace.startsWith(`..${path.sep}`) &&
      remoteRootSegment !== undefined &&
      isAcpRemoteHostStateRoot(path.join(remoteNamespace, remoteRootSegment)));
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
