import path from 'node:path';
import { launchRealApiGuiFixture } from './launchRealApiGuiFixture.js';

await launchRealApiGuiFixture({
  scriptName: 'launch-mcp-recovery-gui.ts',
  defaultPort: 4328,
  readme: '# MCP connection recovery GUI fixture\n',
  configure: ({ root }) => {
    const generationFile = path.join(root, 'generation');
    const pidFile = path.join(root, 'pids');
    const traceFile = path.join(root, 'mcp-trace.jsonl');
    return {
      config: {
        mcpServers: {
          recovery: {
            type: 'stdio',
            command: process.execPath,
            args: [path.resolve(import.meta.dirname, 'fake-mcp-recovery-server.mjs')],
            env: {
              MCP_RECOVERY_GENERATION_FILE: generationFile,
              MCP_RECOVERY_PID_FILE: pidFile,
              MCP_RECOVERY_TRACE_FILE: traceFile,
            },
            timeout: 15_000,
            idleTimeout: 4_000,
            recovery: {
              maxAttempts: 3,
              initialDelayMs: 20,
              maxDelayMs: 50,
              jitterRatio: 0,
              terminalErrorThreshold: 1,
            },
          },
        },
      },
      metadata: { generationFile, pidFile, traceFile },
    };
  },
});
