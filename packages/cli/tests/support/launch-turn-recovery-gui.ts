import { PermissionMode } from '../../src/config/types.js';
import { SessionService } from '../../src/services/SessionService.js';
import { ensureStoreInitialized, getState } from '../../src/store/vanilla.js';
import { seedRootTurnAutoResumeFixture } from '../integration/real-api/rootTurnAutoResumeFixture.js';
import { launchRealApiGuiFixture } from './launchRealApiGuiFixture.js';

await launchRealApiGuiFixture({
  scriptName: 'launch-turn-recovery-gui.ts',
  defaultPort: 4341,
  readme: '# Turn recovery GUI\n',
  configure: () => ({
    config: {
      permissionMode: 'yolo',
      hooks: { enabled: false },
      disableAllHooks: true,
      mcpServers: {},
    },
  }),
  setup: async ({ runtimeConfig }) => {
    await ensureStoreInitialized();
    getState().config.actions.setConfig({
      ...runtimeConfig,
      permissionMode: PermissionMode.YOLO,
      hooks: { enabled: false },
      disableAllHooks: true,
      mcpServers: {},
    });
  },
  afterCommit: async ({ canonicalWorkspace }) => {
    const sessionId = `turn-recovery-gui-${Date.now()}`;
    await SessionService.createSessionMetadata(sessionId, canonicalWorkspace, {
      title: 'Recovery Review Required',
      taskStatus: 'completed',
      permissionMode: PermissionMode.YOLO,
    });
    const fixture = await seedRootTurnAutoResumeFixture({
      workspace: canonicalWorkspace,
      sessionId,
      marker: 'GUI_RECOVERY_MARKER',
    });
    return {
      sessionId,
      markerPath: fixture.markerPath,
      expectedResponse: fixture.expectedResponse,
    };
  },
});
