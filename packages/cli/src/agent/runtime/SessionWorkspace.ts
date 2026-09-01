import type { AcpRemoteWorkspaceDescriptorV1 } from '../../context/types.js';

export type SessionWorkspace =
  | {
      readonly kind: 'local';
      readonly executionRoot: string;
      readonly resourceRoot: string;
    }
  | {
      readonly kind: 'acp-remote';
      readonly executionRoot: string;
      readonly resourceRoot: string;
      readonly readTextFile: boolean;
      readonly writeTextFile: boolean;
      readonly terminal: boolean;
      readonly descriptor: AcpRemoteWorkspaceDescriptorV1;
    };

export function createLocalSessionWorkspace(root: string): SessionWorkspace {
  return Object.freeze({
    kind: 'local',
    executionRoot: root,
    resourceRoot: root,
  });
}

export function freezeSessionWorkspace(workspace: SessionWorkspace): SessionWorkspace {
  return workspace.kind === 'acp-remote'
    ? Object.freeze({
        ...workspace,
        descriptor: Object.freeze({ ...workspace.descriptor }),
      })
    : Object.freeze({ ...workspace });
}
