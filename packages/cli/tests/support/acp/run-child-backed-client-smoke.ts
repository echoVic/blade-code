import { ChildBackedRecordingAcpClient } from './ChildBackedRecordingAcpClient.js';

const workspace = process.argv[2];
if (!workspace) throw new Error('Smoke runner requires a workspace');

let observed = '';
const client = new ChildBackedRecordingAcpClient((chunk) => {
  observed += chunk;
});
let terminalId = '';
try {
  const created = await client.createTerminal({
    sessionId: 'child-backed-smoke',
    command: "printf 'alpha\\n'; printf 'beta\\n' >&2; sleep 0.2",
    cwd: workspace,
  });
  terminalId = created.terminalId;
  const pids = client.terminalPids();
  const exit = await client.waitForTerminalExit({
    sessionId: 'child-backed-smoke',
    terminalId,
  });
  const output = await client.terminalOutput({
    sessionId: 'child-backed-smoke',
    terminalId,
  });
  await client.releaseTerminal({
    sessionId: 'child-backed-smoke',
    terminalId,
  });
  await client.releaseTerminal({
    sessionId: 'child-backed-smoke',
    terminalId,
  });
  process.stdout.write(
    JSON.stringify({
      exitCode: exit.exitCode,
      output: output.output,
      observed,
      processes: client.releasedProcesses,
      observedPids: pids,
      releaseCount: client.releaseCounts.get(terminalId),
      activeTerminalCount: client.activeTerminalCount(),
    })
  );
} finally {
  await client.close();
}
