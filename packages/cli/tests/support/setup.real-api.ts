/**
 * Real API tests intentionally avoid the global unit-test mocks.
 *
 * These tests must exercise the production filesystem, subprocess, and network
 * implementations so a passing result represents an actual Blade trajectory.
 */
import os from 'node:os';
import path from 'node:path';
import { TextDecoder, TextEncoder } from 'node:util';

globalThis.TextEncoder = TextEncoder;
globalThis.TextDecoder = TextDecoder as typeof globalThis.TextDecoder;

process.env.NODE_ENV = 'test';
process.env.TEST_MODE = 'false';
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'error';
process.env.BLADE_STORAGE_ROOT ??= path.join(
  os.tmpdir(),
  `blade-real-api-${process.pid}`
);
