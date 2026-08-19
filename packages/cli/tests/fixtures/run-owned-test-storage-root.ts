import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { configureOwnedTestStorageRoot } from '../support/ownedTestStorageRoot.js';

const reportPath = process.argv[2];
if (!reportPath) {
  throw new Error('Expected a report path');
}

const storageRoot = configureOwnedTestStorageRoot('blade-owned-storage-child');
mkdirSync(storageRoot, { recursive: true });
writeFileSync(path.join(storageRoot, 'sentinel.txt'), 'owned\n', 'utf8');
writeFileSync(reportPath, storageRoot, 'utf8');
