import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const rootDir = process.cwd();

function runTsc() {
  console.log('Building CLI with TypeScript (npx tsc)...');
  execSync('npx tsc -p tsconfig.json', {
    stdio: 'inherit',
  });
}

function createEntry() {
  const distDir = path.join(rootDir, 'dist');
  mkdirSync(distDir, { recursive: true });

  const entry = `#!/usr/bin/env node
import('./src/blade.js')
  .then((m) => (typeof m.main === 'function' ? m.main() : undefined))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
`;

  const entryPath = path.join(distDir, 'blade.js');
  writeFileSync(entryPath, entry, { mode: 0o755 });
  console.log('✓ CLI entry created at dist/blade.js');
}

runTsc();
createEntry();
