import path from 'node:path';
import type { SessionStateStorage } from '../context/storage/SessionStateStorage.js';
import { SessionArtifactStore } from '../tools/artifacts/SessionArtifactStore.js';
import {
  MAX_BROWSER_SCREENSHOT_BYTES,
  MAX_BROWSER_SCREENSHOT_SESSION_BYTES,
  MAX_BROWSER_SCREENSHOTS_PER_SESSION,
} from './constants.js';
import type { BrowserScreenshotArtifact } from './types.js';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface BrowserArtifactStoreOptions {
  storageRoot?: string;
  stateStorage?: SessionStateStorage;
  exposePaths?: boolean;
  maxArtifacts?: number;
  maxSessionBytes?: number;
  maxArtifactBytes?: number;
}

export function createBrowserSessionIdentity(
  projectPath: string,
  sessionId: string
): string {
  return `${path.resolve(projectPath)}\0${sessionId}`;
}

export async function removeBrowserSessionArtifacts(
  projectPath: string,
  sessionId: string,
  storageRoot?: string,
  stateStorage?: SessionStateStorage
): Promise<void> {
  await new BrowserArtifactStore(createBrowserSessionIdentity(projectPath, sessionId), {
    storageRoot,
    stateStorage,
  }).removeAll();
}

export class BrowserArtifactStore {
  private readonly store: SessionArtifactStore<'image'>;

  constructor(sessionIdentity: string, options: BrowserArtifactStoreOptions = {}) {
    this.store = new SessionArtifactStore({
      namespace: 'browser-artifacts',
      sessionIdentity,
      maxArtifacts: options.maxArtifacts ?? MAX_BROWSER_SCREENSHOTS_PER_SESSION,
      maxSessionBytes: options.maxSessionBytes ?? MAX_BROWSER_SCREENSHOT_SESSION_BYTES,
      maxArtifactBytes: options.maxArtifactBytes ?? MAX_BROWSER_SCREENSHOT_BYTES,
      extensionForMimeType: () => '.png',
      validateRequest: (request) => {
        if (
          request.mimeType !== 'image/png' ||
          request.bytes.length < PNG_SIGNATURE.length ||
          !request.bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
        ) {
          throw new Error('Browser screenshot must be a valid PNG');
        }
      },
      storageRoot: options.storageRoot,
      stateStorage: options.stateStorage,
      exposePaths: options.exposePaths,
    });
  }

  async writeScreenshot(bytes: Buffer): Promise<BrowserScreenshotArtifact> {
    return this.store.write({
      kind: 'image',
      bytes,
      mimeType: 'image/png',
    }) as Promise<BrowserScreenshotArtifact>;
  }

  async removeAll(): Promise<void> {
    await this.store.removeAll();
  }
}
