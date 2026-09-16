import path from 'node:path';
import { launchRealApiGuiFixture } from './launchRealApiGuiFixture.js';

await launchRealApiGuiFixture({
  scriptName: 'launch-mcp-instructions-gui.ts',
  defaultPort: 4331,
  readme: '# MCP server instructions GUI fixture\n',
  configure: ({ root }) => {
    const generationFile = path.join(root, 'generation');
    const pidFile = path.join(root, 'pids');
    const traceFile = path.join(root, 'mcp-trace.jsonl');
    return {
      config: {
        mcpServers: {
          instructions: {
            type: 'stdio',
            command: process.execPath,
            args: [
              path.resolve(import.meta.dirname, 'fake-mcp-instructions-server.mjs'),
            ],
            env: {
              MCP_INSTRUCTIONS_GENERATION_FILE: generationFile,
              MCP_INSTRUCTIONS_PID_FILE: pidFile,
              MCP_INSTRUCTIONS_TRACE_FILE: traceFile,
            },
            timeout: 15_000,
            idleTimeout: 4_000,
          },
        },
      },
      metadata: { generationFile, pidFile, traceFile },
    };
  },
});
