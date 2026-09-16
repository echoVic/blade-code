import path from 'node:path';
import { launchRealApiGuiFixture } from './launchRealApiGuiFixture.js';

await launchRealApiGuiFixture({
  scriptName: 'launch-mcp-tool-result-gui.ts',
  defaultPort: 4329,
  readme: '# MCP tool result safety GUI fixture\n',
  configure: ({ root }) => {
    const pidFile = path.join(root, 'mcp.pid');
    const traceFile = path.join(root, 'mcp-trace.jsonl');
    return {
      config: {
        mcpServers: {
          results: {
            type: 'stdio',
            command: process.execPath,
            args: [
              path.resolve(import.meta.dirname, 'fake-mcp-tool-result-server.mjs'),
            ],
            env: {
              MCP_TOOL_RESULT_PID_FILE: pidFile,
              MCP_TOOL_RESULT_TRACE_FILE: traceFile,
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
