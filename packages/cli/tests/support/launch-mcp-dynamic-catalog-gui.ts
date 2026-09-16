import path from 'node:path';
import { launchRealApiGuiFixture } from './launchRealApiGuiFixture.js';

await launchRealApiGuiFixture({
  scriptName: 'launch-mcp-dynamic-catalog-gui.ts',
  defaultPort: 4326,
  readme: '# Dynamic MCP catalog GUI fixture\n',
  configure: ({ root }) => {
    const pidFile = path.join(root, 'mcp.pid');
    const traceFile = path.join(root, 'mcp-trace.jsonl');
    return {
      config: {
        mcpServers: {
          dynamic: {
            type: 'stdio',
            command: process.execPath,
            args: [
              path.resolve(import.meta.dirname, 'fake-mcp-dynamic-catalog-server.mjs'),
            ],
            env: {
              MCP_DYNAMIC_PID_FILE: pidFile,
              MCP_DYNAMIC_TRACE_FILE: traceFile,
            },
            timeout: 15_000,
            idleTimeout: 4_000,
          },
        },
      },
      metadata: { pidFile, traceFile },
    };
  },
});
