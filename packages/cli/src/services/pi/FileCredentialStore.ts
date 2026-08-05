import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  Credential,
  CredentialInfo,
  CredentialStore,
} from '@earendil-works/pi-ai';
import { Mutex } from 'async-mutex';
import writeFileAtomic from 'write-file-atomic';
import { getBladeStorageRoot } from '../../context/storage/pathUtils.js';

type CredentialFile = Record<string, Credential>;

export class FileCredentialStore implements CredentialStore {
  private readonly mutex = new Mutex();

  constructor(
    private readonly filePath = path.join(getBladeStorageRoot(), 'auth.json')
  ) {}

  async read(providerId: string): Promise<Credential | undefined> {
    return (await this.readAll())[providerId];
  }

  async list(): Promise<readonly CredentialInfo[]> {
    const credentials = await this.readAll();
    return Object.entries(credentials).map(([providerId, credential]) => ({
      providerId,
      type: credential.type,
    }));
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>
  ): Promise<Credential | undefined> {
    return this.mutex.runExclusive(async () => {
      const credentials = await this.readAll();
      const current = credentials[providerId];
      const next = await fn(current);
      if (next === undefined) return current;
      credentials[providerId] = next;
      await this.writeAll(credentials);
      return next;
    });
  }

  async delete(providerId: string): Promise<void> {
    await this.mutex.runExclusive(async () => {
      const credentials = await this.readAll();
      if (!(providerId in credentials)) return;
      delete credentials[providerId];
      await this.writeAll(credentials);
    });
  }

  private async readAll(): Promise<CredentialFile> {
    try {
      const content = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(content);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as CredentialFile)
        : {};
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }
  }

  private async writeAll(credentials: CredentialFile): Promise<void> {
    const directory = path.dirname(this.filePath);
    await fs.mkdir(directory, {
      recursive: true,
      mode: 0o700,
    });
    await fs.chmod(directory, 0o700);
    await writeFileAtomic(this.filePath, `${JSON.stringify(credentials, null, 2)}\n`, {
      mode: 0o600,
    });
    await fs.chmod(this.filePath, 0o600);
  }
}
