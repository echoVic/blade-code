import path from 'node:path';
import { launchRealApiGuiFixture } from './launchRealApiGuiFixture.js';

await launchRealApiGuiFixture({
  scriptName: 'launch-mcp-logging-gui.ts',
  defaultPort: 4330,
  readme: '# MCP logging GUI fixture\n',
  configure: ({ root }) => {
    const pidFile = path.join(root, 'mcp.pid');
    const traceFile = path.join(root, 'mcp-trace.jsonl');
    return {
      config: {
        mcpServers: {
          logging: {
            type: 'stdio',
            command: process.execPath,
            args: [path.resolve(import.meta.dirname, 'fake-mcp-logging-server.mjs')],
            env: {
              MCP_LOGGING_PID_FILE: pidFile,
              MCP_LOGGING_TRACE_FILE: traceFile,
            },
            logging: { level: 'warning' },
            timeout: 15_000,
            idleTimeout: 4_000,
          },
        },
      },
      metadata: { pidFile, traceFile },
    };
  },
});
