import { writeFileSync } from 'node:fs';
import { runOwnedCommand } from '../../scripts/test-runner.js';

const pidFile = process.argv[2];
if (!pidFile) {
  throw new Error('Expected a target PID file');
}

const targetScript = [
  "const { writeFileSync } = require('node:fs');",
  `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
  "process.on('SIGTERM', () => {});",
  'setInterval(() => {}, 1000);',
].join('\n');

await runOwnedCommand({
  command: process.execPath,
  args: ['-e', targetScript],
  cwd: process.cwd(),
  timeoutMs: 60_000,
  stdio: 'ignore',
});
