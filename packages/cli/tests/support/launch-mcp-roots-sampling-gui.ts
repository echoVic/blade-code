import path from 'node:path';
import { launchRealApiGuiFixture } from './launchRealApiGuiFixture.js';

await launchRealApiGuiFixture({
  scriptName: 'launch-mcp-roots-sampling-gui.ts',
  defaultPort: 4323,
  workspaceName: 'project with space',
  readme: '# MCP roots and sampling fixture\n',
  configure: ({ root }) => {
    const pidFile = path.join(root, 'mcp.pid');
    return {
      config: {
        mcpServers: {
          sampler: {
            type: 'stdio',
            command: process.execPath,
            args: [
              path.resolve(import.meta.dirname, 'fake-mcp-roots-sampling-server.mjs'),
            ],
            env: { MCP_ROOTS_SAMPLING_PID_FILE: pidFile },
            sampling: {
              enabled: true,
              maxTokens: 64,
              maxRequestsPerToolCall: 1,
              maxInputBytes: 16_384,
            },
          },
        },
      },
      metadata: { pidFile },
    };
  },
});
