import { launchRealApiGuiFixture } from './launchRealApiGuiFixture.js';

await launchRealApiGuiFixture({
  scriptName: 'launch-session-archive-gui.ts',
  defaultPort: 4334,
  readme: '# Session Archive GUI fixture\n',
  configure: () => ({
    config: {
      hooks: { enabled: false },
      disableAllHooks: true,
      mcpServers: {},
    },
  }),
});
