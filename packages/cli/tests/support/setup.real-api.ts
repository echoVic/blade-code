/**
 * Real API tests intentionally avoid the global unit-test mocks.
 *
 * These tests must exercise the production filesystem, subprocess, and network
 * implementations so a passing result represents an actual Blade trajectory.
 */
import { TextDecoder, TextEncoder } from 'node:util';
import { afterAll } from 'vitest';
import { getPiModelCatalog } from '../../src/services/pi/PiModelCatalog.js';
import { ensureStoreInitialized, getState } from '../../src/store/vanilla.js';
import {
  buildRealApiRuntimeConfig,
  getEnabledModelConfigs,
  isRealApiTestEnabled,
} from '../integration/real-api/testConfig.js';
import { configureOwnedTestStorageRoot } from './ownedTestStorageRoot.js';

globalThis.TextEncoder = TextEncoder;
globalThis.TextDecoder = TextDecoder as typeof globalThis.TextDecoder;

process.env.NODE_ENV = 'test';
process.env.TEST_MODE = 'false';
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'error';
configureOwnedTestStorageRoot('blade-real-api', (cleanup) => {
  afterAll(cleanup);
});

if (isRealApiTestEnabled()) {
  const [runtimeModel] = getEnabledModelConfigs();
  if (runtimeModel) {
    await ensureStoreInitialized();
    await getPiModelCatalog().setApiKey(runtimeModel.provider, runtimeModel.apiKey);
    getState().config.actions.setConfig(buildRealApiRuntimeConfig(runtimeModel));
  }
}
