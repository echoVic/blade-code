import { BackgroundShellManager } from '../../src/tools/builtin/shell/BackgroundShellManager.js';

const [projectPath, sessionId] = process.argv.slice(2);
if (!projectPath || !sessionId) process.exit(2);

const shell = await BackgroundShellManager.getInstance().startBackgroundProcess({
  command: 'trap "" TERM; sleep 300',
  sessionId,
  projectPath,
  cwd: projectPath,
});
process.stdout.write(`${JSON.stringify({ shellId: shell.id, pid: shell.pid })}\n`);
setInterval(() => undefined, 1_000);
