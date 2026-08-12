import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { bashTool } from '../../src/tools/builtin/shell/bash.js';

const [projectPath, sessionId] = process.argv.slice(2);
if (!projectPath || !sessionId) process.exit(2);

const pidFile = path.join(projectPath, 'foreground-command.pid');
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const command =
  `printf '%s' "$$" > ${shellQuote(pidFile)}; ` +
  `trap '' TERM; while :; do sleep 1; done`;

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
    // The command has not crossed its durable admission gate yet.
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
}
if (!commandPid || commandPid <= 1) {
  throw new Error('Foreground command did not start');
}
process.stdout.write(`${JSON.stringify({ commandPid })}\n`);
setInterval(() => undefined, 1_000);
