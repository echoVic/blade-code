import {
  type AcpRemoteStateScope,
  deriveAcpRemoteHostStateRoot,
  parseAcpRemoteWorkspaceDescriptor,
  withValidatedAcpRemoteStateScope,
} from '../../acp/AcpRemoteWorkspace.js';
import type { AcpRemoteWorkspaceDescriptorV1 } from '../types.js';
import {
  getAcpRemoteSessionFilePath,
  getAcpRemoteSessionGoalFilePath,
  getAcpRemoteSessionInboxFilePath,
  getProjectStoragePath,
  getSessionFilePath,
  getSessionGoalFilePath,
  getSessionInboxFilePath,
} from './pathUtils.js';

export type SessionStateStorage =
  | Readonly<{ kind: 'local'; root: string }>
  | Readonly<{
      kind: 'acp-remote';
      root: string;
      descriptor: AcpRemoteWorkspaceDescriptorV1;
    }>;

export interface SessionStatePaths {
  readonly storageRoot: string;
  readonly transcriptPath: string;
  readonly inboxPath: string;
  readonly goalPath: string;
  readonly remoteScope?: AcpRemoteStateScope;
}

export function createSessionStateStorage(root: string): SessionStateStorage {
  return Object.freeze({ kind: 'local', root });
}

export function createRemoteSessionStateStorage(
  root: string,
  descriptor: AcpRemoteWorkspaceDescriptorV1
): SessionStateStorage {
  const validated = parseAcpRemoteWorkspaceDescriptor(descriptor);
  if (deriveAcpRemoteHostStateRoot(validated.collisionIdentity) !== root) {
    throw new Error('ACP remote workspace durable state is invalid');
  }
  return Object.freeze({ kind: 'acp-remote', root, descriptor: validated });
}

export function sessionStateStorageKey(
  storage: SessionStateStorage,
  sessionId: string
): string {
  return storage.kind === 'acp-remote'
    ? `${storage.kind}\0${storage.root}\0${storage.descriptor.exactIdentity}\0${sessionId}`
    : `${storage.kind}\0${storage.root}\0${sessionId}`;
}

export async function withSessionStateRoot<T>(
  storage: SessionStateStorage,
  operation: (root: string, remoteScope?: AcpRemoteStateScope) => Promise<T>
): Promise<T> {
  if (storage.kind === 'local') {
    return operation(getProjectStoragePath(storage.root));
  }
  return withValidatedAcpRemoteStateScope(storage.root, (scope) =>
    operation(String(scope), scope)
  );
}

export async function withSessionStatePaths<T>(
  storage: SessionStateStorage,
  sessionId: string,
  operation: (paths: SessionStatePaths) => Promise<T>
): Promise<T> {
  return withSessionStateRoot(storage, (storageRoot, remoteScope) =>
    operation(
      remoteScope
        ? {
            storageRoot,
            transcriptPath: getAcpRemoteSessionFilePath(remoteScope, sessionId),
            inboxPath: getAcpRemoteSessionInboxFilePath(remoteScope, sessionId),
            goalPath: getAcpRemoteSessionGoalFilePath(remoteScope, sessionId),
            remoteScope,
          }
        : {
            storageRoot,
            transcriptPath: getSessionFilePath(storage.root, sessionId),
            inboxPath: getSessionInboxFilePath(storage.root, sessionId),
            goalPath: getSessionGoalFilePath(storage.root, sessionId),
          }
    )
  );
}
