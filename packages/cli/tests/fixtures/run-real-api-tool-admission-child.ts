import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [stateDir, callId] = process.argv.slice(2);
if (!stateDir || !callId) process.exit(2);

const startedDir = path.join(stateDir, 'started');
const activeDir = path.join(stateDir, 'active');
const completedDir = path.join(stateDir, 'completed');
const releaseDir = path.join(stateDir, 'release');
for (const directory of [startedDir, activeDir, completedDir, releaseDir]) {
  mkdirSync(directory, { recursive: true });
}

const activeFile = path.join(activeDir, callId);
writeFileSync(path.join(startedDir, callId), String(process.pid));
writeFileSync(activeFile, String(process.pid));

const cleanup = () => {
  rmSync(activeFile, { force: true });
};
process.once('SIGINT', cleanup);
process.once('SIGTERM', cleanup);
process.once('exit', cleanup);

while (!existsSync(path.join(releaseDir, callId))) {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

cleanup();
writeFileSync(path.join(completedDir, callId), String(process.pid));
process.stdout.write(`TOOL_ADMISSION_RESULT_${callId}\n`);
