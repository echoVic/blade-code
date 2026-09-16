import path from 'node:path';
import { launchRealApiGuiFixture } from './launchRealApiGuiFixture.js';

await launchRealApiGuiFixture({
  scriptName: 'launch-mcp-tasks-gui.ts',
  defaultPort: 4333,
  readme: '# MCP Tasks GUI fixture\n',
  configure: ({ root }) => {
    const stateFile = path.join(root, 'task-state.json');
    const pidFile = path.join(root, 'pids');
    const traceFile = path.join(root, 'mcp-trace.jsonl');
    return {
      config: {
        mcpServers: {
          tasks: {
            type: 'stdio',
            command: process.execPath,
            args: [path.resolve(import.meta.dirname, 'fake-mcp-task-server.mjs')],
            env: {
              MCP_TASK_STATE_FILE: stateFile,
              MCP_TASK_PID_FILE: pidFile,
              MCP_TASK_TRACE_FILE: traceFile,
              MCP_TASK_NAMESPACE: 'PRIMARY',
            },
            tasks: {
              enabled: true,
              defaultTtlMs: 60_000,
              pollIntervalMs: 100,
              maxTasksPerSession: 8,
              maxLifetimeMs: 60_000,
            },
            recovery: {
              maxAttempts: 5,
              initialDelayMs: 20,
              maxDelayMs: 50,
              jitterRatio: 0,
              terminalErrorThreshold: 1,
            },
            timeout: 15_000,
            idleTimeout: 5_000,
          },
        },
      },
      metadata: { stateFile, pidFile, traceFile },
    };
  },
});
