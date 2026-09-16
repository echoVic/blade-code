import path from 'node:path';
import { launchRealApiGuiFixture } from './launchRealApiGuiFixture.js';

await launchRealApiGuiFixture({
  scriptName: 'launch-mcp-progress-gui.ts',
  defaultPort: 4324,
  readme: '# MCP progress fixture\n',
  configure: ({ root }) => {
    const pidFile = path.join(root, 'mcp.pid');
    return {
      config: {
        mcpServers: {
          lifecycle: {
            type: 'stdio',
            command: process.execPath,
            args: [path.resolve(import.meta.dirname, 'fake-mcp-lifecycle-server.mjs')],
            env: {
              MCP_LIFECYCLE_PID_FILE: pidFile,
              MCP_LIFECYCLE_PROGRESS_DELAY_MS: '3000',
            },
            timeout: 15_000,
            idleTimeout: 4_000,
          },
        },
      },
      metadata: { pidFile },
    };
  },
});
