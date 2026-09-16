import path from 'node:path';
import { launchRealApiGuiFixture } from './launchRealApiGuiFixture.js';

await launchRealApiGuiFixture({
  scriptName: 'launch-mcp-content-gui.ts',
  defaultPort: 4327,
  readme: '# MCP resources and prompts GUI fixture\n',
  configure: ({ root }) => {
    const pidFile = path.join(root, 'mcp.pid');
    const traceFile = path.join(root, 'mcp-trace.jsonl');
    return {
      config: {
        mcpServers: {
          content: {
            type: 'stdio',
            command: process.execPath,
            args: [path.resolve(import.meta.dirname, 'fake-mcp-content-server.mjs')],
            env: {
              MCP_CONTENT_PID_FILE: pidFile,
              MCP_CONTENT_TRACE_FILE: traceFile,
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
