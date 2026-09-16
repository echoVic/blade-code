import path from 'node:path';
import { launchRealApiGuiFixture } from './launchRealApiGuiFixture.js';

await launchRealApiGuiFixture({
  scriptName: 'launch-mcp-completion-gui.ts',
  defaultPort: 4332,
  readme: '# MCP completion GUI fixture\n',
  configure: ({ root }) => {
    const pidFile = path.join(root, 'pids');
    const traceFile = path.join(root, 'mcp-trace.jsonl');
    return {
      config: {
        mcpServers: {
          completion: {
            type: 'stdio',
            command: process.execPath,
            args: [path.resolve(import.meta.dirname, 'fake-mcp-completion-server.mjs')],
            env: {
              MCP_COMPLETION_NAMESPACE: 'PRIMARY',
              MCP_COMPLETION_PID_FILE: pidFile,
              MCP_COMPLETION_TRACE_FILE: traceFile,
            },
            timeout: 15_000,
            idleTimeout: 5_000,
          },
        },
      },
      metadata: { pidFile, traceFile },
    };
  },
});
