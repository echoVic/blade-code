import { SessionService } from '../../src/services/SessionService.js';
import { launchRealApiGuiFixture } from './launchRealApiGuiFixture.js';

await launchRealApiGuiFixture({
  scriptName: 'launch-permission-mode-gui.ts',
  defaultPort: 4339,
  readme: '# Permission mode GUI\n',
  configure: () => ({
    config: {
      permissionMode: 'default',
      hooks: { enabled: false },
      disableAllHooks: true,
      mcpServers: {},
    },
  }),
  afterCommit: async ({ canonicalWorkspace, runtimeConfig }) => {
    const sessionId = `permission-gui-${Date.now()}`;
    await SessionService.createSessionMetadata(sessionId, canonicalWorkspace, {
      title: 'Persistent YOLO Session',
      taskStatus: 'completed',
      selectedModelId: runtimeConfig.currentModelId,
      permissionMode: 'yolo',
    });
    return { sessionId };
  },
});
