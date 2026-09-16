import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { launchRealApiGuiFixture } from './launchRealApiGuiFixture.js';

const marker = `EXPORT_GUI_VISIBLE_${Date.now()}`;

await launchRealApiGuiFixture({
  scriptName: 'launch-session-export-gui.ts',
  defaultPort: 4335,
  readme: '# Session Export GUI fixture\n',
  configure: () => ({
    config: {
      hooks: { enabled: false },
      disableAllHooks: true,
      mcpServers: {},
    },
    metadata: { marker },
  }),
  setup: async ({ workspace }) => {
    await writeFile(
      path.join(workspace, 'evidence.txt'),
      `${marker}\nsk-EXPORT_GUI_SECRET_1234567890\n/Users/gui-owner/private/file.txt\n`
    );
  },
});
