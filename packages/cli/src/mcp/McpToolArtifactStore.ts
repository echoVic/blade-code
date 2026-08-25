import { SessionArtifactStore } from '../tools/artifacts/SessionArtifactStore.js';
import type {
  McpToolArtifact,
  McpToolArtifactKind,
  McpToolArtifactWriteRequest,
  McpToolArtifactWriter,
} from './McpToolResult.js';

export const MAX_MCP_ARTIFACTS_PER_SESSION = 256;
export const MAX_MCP_ARTIFACT_SESSION_BYTES = 64 * 1024 * 1024;

interface McpToolArtifactStoreOptions {
  storageRoot?: string;
  exposePaths?: boolean;
}

function extensionForMimeType(mimeType: string | undefined): string {
  const normalized = mimeType?.split(';', 1)[0]?.trim().toLowerCase();
  const known: Record<string, string> = {
    'application/json': '.json',
    'application/pdf': '.pdf',
    'application/zip': '.zip',
    'audio/mpeg': '.mp3',
    'audio/ogg': '.ogg',
    'audio/wav': '.wav',
    'image/gif': '.gif',
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'text/csv': '.csv',
    'text/html': '.html',
    'text/markdown': '.md',
    'text/plain': '.txt',
  };
  return (normalized && known[normalized]) || '.bin';
}

export class McpToolArtifactStore implements McpToolArtifactWriter {
  private readonly store: SessionArtifactStore<McpToolArtifactKind>;

  constructor(sessionIdentity: string, options: McpToolArtifactStoreOptions = {}) {
    this.store = new SessionArtifactStore({
      namespace: 'mcp-artifacts',
      sessionIdentity,
      maxArtifacts: MAX_MCP_ARTIFACTS_PER_SESSION,
      maxSessionBytes: MAX_MCP_ARTIFACT_SESSION_BYTES,
      extensionForMimeType,
      storageRoot: options.storageRoot,
      exposePaths: options.exposePaths,
    });
  }

  async write(request: McpToolArtifactWriteRequest): Promise<McpToolArtifact> {
    return this.store.write(request);
  }
}
