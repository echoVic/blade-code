import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function resolveVitestCli() {
  const packagePath = fileURLToPath(import.meta.resolve('vitest/package.json'));
  const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
  const bin =
    typeof packageJson.bin === 'string'
      ? packageJson.bin
      : packageJson.bin?.vitest;
  if (typeof bin !== 'string' || !bin) {
    throw new Error('Unable to resolve the Vitest CLI binary');
  }
  return path.resolve(path.dirname(packagePath), bin);
}
