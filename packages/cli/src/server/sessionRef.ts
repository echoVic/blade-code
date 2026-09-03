import path from 'node:path';
import {
  assertValidSessionId,
  normalizeLocalWorkspacePath,
} from '../context/storage/pathUtils.js';

export interface SessionRef {
  sessionId: string;
  projectPath: string;
}

export { normalizeLocalWorkspacePath };

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
