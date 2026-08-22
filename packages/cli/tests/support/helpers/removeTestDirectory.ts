import { rm } from 'node:fs/promises';

export async function removeTestDirectory(directory: string): Promise<void> {
  await rm(directory, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
}
