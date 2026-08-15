import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const [stateDir, nonce] = process.argv.slice(2);
if (!stateDir || !nonce || !/^[A-Za-z0-9_-]{1,80}$/.test(nonce)) {
  throw new Error('Invalid foreground handoff child arguments');
}

const startedDir = path.join(stateDir, 'started');
const activeDir = path.join(stateDir, 'active');
const completedDir = path.join(stateDir, 'completed');
const releaseFile = path.join(stateDir, 'release', nonce);
const startedFile = path.join(startedDir, nonce);
const activeFile = path.join(activeDir, nonce);
const completedFile = path.join(completedDir, nonce);
const launchFile = path.join(stateDir, 'launches');

await Promise.all([
  mkdir(startedDir, { recursive: true }),
  mkdir(activeDir, { recursive: true }),
  mkdir(completedDir, { recursive: true }),
  mkdir(path.dirname(releaseFile), { recursive: true }),
]);
await writeFile(launchFile, `${process.pid}\n`, { flag: 'a' });
await Promise.all([
  writeFile(startedFile, String(process.pid)),
  writeFile(activeFile, String(process.pid)),
]);
process.stdout.write(`HANDOFF_BEFORE_${nonce}\n`);

let terminal = false;
const cleanup = async (): Promise<void> => {
  if (terminal) return;
  terminal = true;
  clearInterval(poll);
  await rm(activeFile, { force: true });
};
const finish = async (): Promise<void> => {
  if (terminal) return;
  terminal = true;
  clearInterval(poll);
  await Promise.all([
    rm(activeFile, { force: true }),
    writeFile(completedFile, String(process.pid)),
  ]);
  process.stdout.write(`HANDOFF_AFTER_${nonce}\n`, () => process.exit(0));
};

const poll = setInterval(() => {
  void access(releaseFile)
    .then(() => finish())
    .catch(() => undefined);
}, 25);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void cleanup().finally(() => process.exit(128));
  });
}
