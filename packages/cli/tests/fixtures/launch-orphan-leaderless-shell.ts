import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { bashTool } from '../../src/tools/builtin/shell/bash.js';

const [projectPath, sessionId] = process.argv.slice(2);
if (!projectPath || !sessionId) process.exit(2);

const pidFile = path.join(projectPath, 'leaderless-command.pid');
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const script =
  `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));` +
  `process.on('SIGTERM', () => {});setInterval(() => {}, 1000);`;
const command =
  `${shellQuote(process.execPath)} -e ${shellQuote(script)} ` + `</dev/null &`;

void bashTool.execute(
  {
    command,
    timeout: 300_000,
    env: {},
    run_in_background: false,
  },
  new AbortController().signal,
  { sessionId, workspaceRoot: projectPath }
);

const deadline = Date.now() + 10_000;
let commandPid: number | undefined;
while (Date.now() < deadline) {
  try {
    commandPid = Number.parseInt(await readFile(pidFile, 'utf8'), 10);
    if (Number.isSafeInteger(commandPid) && commandPid > 1) break;
  } catch {
    // The background descendant has not started yet.
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
}
if (!commandPid || commandPid <= 1) {
  throw new Error('Leaderless command descendant did not start');
}
process.stdout.write(`${JSON.stringify({ commandPid })}\n`);
setInterval(() => undefined, 1_000);
