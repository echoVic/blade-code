import { createHash, randomUUID } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import type { OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js';
import { Mutex } from 'async-mutex';
import writeFileAtomic from 'write-file-atomic';
import { getBladeStorageRoot } from '../../context/storage/pathUtils.js';
import { parseSchema, safeParseSchema, Type } from '../../schema/index.js';
import type { McpOAuthCredential, McpOAuthCredentialStore } from './types.js';

const STORE_VERSION = 1;
const MAX_STORE_BYTES = 1024 * 1024;
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_RETRY_MS = 50;
const CREDENTIAL_ID_PATTERN = /^[a-f0-9]{64}$/;

const ClientInformationSchema = Type.Object(
  {
    client_id: Type.String({ minLength: 1, maxLength: 4096 }),
  },
  { additionalProperties: true }
);

const OAuthTokensSchema = Type.Object(
  {
    access_token: Type.String({ minLength: 1, maxLength: 64 * 1024 }),
    token_type: Type.String({ minLength: 1, maxLength: 64 }),
    expires_in: Type.Optional(Type.Number({ minimum: 0 })),
    refresh_token: Type.Optional(Type.String({ minLength: 1, maxLength: 64 * 1024 })),
    scope: Type.Optional(Type.String({ maxLength: 16 * 1024 })),
    id_token: Type.Optional(Type.String({ minLength: 1, maxLength: 256 * 1024 })),
  },
  { additionalProperties: false }
);

const DiscoveryStateSchema = Type.Unsafe<OAuthDiscoveryState>({
  type: 'object',
  properties: {
    authorizationServerUrl: Type.String({ format: 'uri' }),
    resourceMetadataUrl: Type.Optional(Type.String({ format: 'uri' })),
    resourceMetadata: Type.Optional(Type.Unknown()),
    authorizationServerMetadata: Type.Optional(Type.Unknown()),
  },
  required: ['authorizationServerUrl'],
  additionalProperties: false,
});

const CredentialSchema = Type.Object(
  {
    serverUrl: Type.String({ format: 'uri' }),
    clientId: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
    clientInformation: Type.Optional(ClientInformationSchema),
    tokens: Type.Optional(OAuthTokensSchema),
    tokenExpiresAt: Type.Optional(Type.Number({ minimum: 0 })),
    discoveryState: Type.Optional(DiscoveryStateSchema),
    updatedAt: Type.String({ format: 'date-time' }),
  },
  { additionalProperties: false }
);

const StoreSchema = Type.Object(
  {
    version: Type.Literal(STORE_VERSION),
    credentials: Type.Record(Type.String(), CredentialSchema),
  },
  { additionalProperties: false }
);

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error, 'EPERM');
  }
}

function cloneCredential(credential: McpOAuthCredential): McpOAuthCredential {
  return structuredClone(credential);
}

function assertCredentialIds(store: McpOAuthCredentialStore): void {
  if (
    Object.keys(store.credentials).some(
      (identity) => !CREDENTIAL_ID_PATTERN.test(identity)
    )
  ) {
    throw new Error('MCP OAuth credential store contains an invalid identity');
  }
}

export function canonicalMcpOAuthServerUrl(serverUrl: string): string {
  const url = new URL(serverUrl);
  url.hash = '';
  return url.toString();
}

export function mcpOAuthCredentialId(
  serverUrl: string,
  clientId?: string,
  scopes: readonly string[] = []
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        serverUrl: canonicalMcpOAuthServerUrl(serverUrl),
        clientId: clientId?.trim() || null,
        scopes: [...scopes].sort(),
      })
    )
    .digest('hex');
}

export class OAuthTokenStorage {
  private static readonly mutexes = new Map<string, Mutex>();

  private readonly stateRoot: string;
  private readonly tokenFilePath: string;
  private readonly mutex: Mutex;

  constructor(storageRoot = getBladeStorageRoot()) {
    this.stateRoot = path.join(storageRoot, 'mcp');
    this.tokenFilePath = path.join(this.stateRoot, 'oauth-credentials.json');
    let mutex = OAuthTokenStorage.mutexes.get(this.tokenFilePath);
    if (!mutex) {
      mutex = new Mutex();
      OAuthTokenStorage.mutexes.set(this.tokenFilePath, mutex);
    }
    this.mutex = mutex;
  }

  async getCredential(identity: string): Promise<McpOAuthCredential | null> {
    return this.mutex.runExclusive(async () => {
      const store = await this.readStore();
      const credential = store.credentials[identity];
      return credential ? cloneCredential(credential) : null;
    });
  }

  async updateCredential(
    identity: string,
    update: (
      current: McpOAuthCredential | null
    ) => McpOAuthCredential | null | Promise<McpOAuthCredential | null>
  ): Promise<McpOAuthCredential | null> {
    return this.runMutation(async (store) => {
      const current = store.credentials[identity];
      const next = await update(current ? cloneCredential(current) : null);
      if (next) {
        store.credentials[identity] = parseSchema(CredentialSchema, next);
      } else {
        delete store.credentials[identity];
      }
      return next ? cloneCredential(store.credentials[identity]) : null;
    });
  }

  async deleteCredential(identity: string): Promise<void> {
    await this.updateCredential(identity, () => null);
  }

  async listCredentialIds(): Promise<string[]> {
    return this.mutex.runExclusive(async () =>
      Object.keys((await this.readStore()).credentials).sort()
    );
  }

  private async runMutation<T>(
    operation: (store: McpOAuthCredentialStore) => Promise<T>
  ): Promise<T> {
    return this.mutex.runExclusive(async () => {
      const release = await this.acquireStoreLock();
      try {
        const store = await this.readStore();
        const result = await operation(store);
        await this.writeStore(store);
        return result;
      } finally {
        await release();
      }
    });
  }

  private async ensureStateRoot(): Promise<void> {
    await fs.mkdir(this.stateRoot, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(this.stateRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('MCP OAuth credential root must be a regular directory');
    }
    if (process.getuid && stat.uid !== process.getuid()) {
      throw new Error('MCP OAuth credential root must be owned by the current user');
    }
    if ((stat.mode & 0o077) !== 0) {
      throw new Error(
        'MCP OAuth credential root permissions must not allow group access'
      );
    }
  }

  private async readStore(): Promise<McpOAuthCredentialStore> {
    try {
      const stat = await fs.lstat(this.tokenFilePath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error('MCP OAuth credential store must be a regular file');
      }
      if (process.getuid && stat.uid !== process.getuid()) {
        throw new Error('MCP OAuth credential store must be owned by the current user');
      }
      if ((stat.mode & 0o777) !== 0o600) {
        throw new Error('MCP OAuth credential store permissions must be 0600');
      }
      if (stat.size > MAX_STORE_BYTES) {
        throw new Error('MCP OAuth credential store exceeds the 1 MiB limit');
      }
      const parsed: unknown = JSON.parse(await fs.readFile(this.tokenFilePath, 'utf8'));
      const result = safeParseSchema(StoreSchema, parsed);
      if (!result.success) {
        throw new Error('MCP OAuth credential store has an invalid schema');
      }
      assertCredentialIds(result.data);
      return result.data;
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) {
        return { version: STORE_VERSION, credentials: {} };
      }
      throw error;
    }
  }

  private async writeStore(store: McpOAuthCredentialStore): Promise<void> {
    await this.ensureStateRoot();
    const validated = parseSchema(StoreSchema, store);
    assertCredentialIds(validated);
    await writeFileAtomic(
      this.tokenFilePath,
      `${JSON.stringify(validated, null, 2)}\n`,
      { mode: 0o600, encoding: 'utf8' }
    );
    await fs.chmod(this.tokenFilePath, 0o600);
  }

  private async acquireStoreLock(): Promise<() => Promise<void>> {
    await this.ensureStateRoot();
    const lockPath = path.join(this.stateRoot, '.oauth-credentials.lock');
    const token = randomUUID();
    const deadline = Date.now() + LOCK_TIMEOUT_MS;

    while (Date.now() < deadline) {
      try {
        const handle = await fs.open(
          lockPath,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
          0o600
        );
        await handle.writeFile(
          `${JSON.stringify({
            version: 1,
            pid: process.pid,
            token,
            createdAt: new Date().toISOString(),
          })}\n`,
          'utf8'
        );
        await handle.close();
        return async () => {
          try {
            const owner = JSON.parse(await fs.readFile(lockPath, 'utf8')) as {
              token?: unknown;
            };
            if (owner.token === token) await fs.unlink(lockPath);
          } catch (error) {
            if (!isNodeError(error, 'ENOENT')) throw error;
          }
        };
      } catch (error) {
        if (!isNodeError(error, 'EEXIST')) throw error;
        await this.removeDeadLock(lockPath);
        await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
      }
    }
    throw new Error('MCP OAuth credential store is busy; retry the operation');
  }

  private async removeDeadLock(lockPath: string): Promise<void> {
    const stat = await fs.lstat(lockPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error('MCP OAuth credential lock must be a regular file');
    }
    if (
      (process.getuid && stat.uid !== process.getuid()) ||
      (stat.mode & 0o777) !== 0o600
    ) {
      throw new Error('MCP OAuth credential lock ownership or permissions are invalid');
    }
    const owner = JSON.parse(await fs.readFile(lockPath, 'utf8')) as {
      pid?: unknown;
    };
    if (
      typeof owner.pid !== 'number' ||
      !Number.isInteger(owner.pid) ||
      owner.pid <= 0
    ) {
      throw new Error('MCP OAuth credential lock owner is invalid');
    }
    if (!processIsAlive(owner.pid)) await fs.unlink(lockPath);
  }
}
