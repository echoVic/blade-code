import path from 'node:path';
import { launchRealApiGuiFixture } from './launchRealApiGuiFixture.js';

await launchRealApiGuiFixture({
  scriptName: 'launch-mcp-elicitation-gui.ts',
  defaultPort: 4322,
  readme: '# MCP elicitation fixture\n',
  configure: ({ root }) => {
    const pidFile = path.join(root, 'mcp.pid');
    return {
      config: {
        mcpServers: {
          elicitation: {
            type: 'stdio',
            command: process.execPath,
            args: [
              path.resolve(import.meta.dirname, 'fake-mcp-elicitation-server.mjs'),
            ],
            env: { MCP_ELICITATION_PID_FILE: pidFile },
          },
        },
      },
      metadata: { pidFile },
    };
  },
});
