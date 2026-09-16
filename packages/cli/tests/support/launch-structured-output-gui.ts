import { launchRealApiGuiFixture } from './launchRealApiGuiFixture.js';

await launchRealApiGuiFixture({
  scriptName: 'launch-structured-output-gui.ts',
  defaultPort: 4342,
  readme: '# Structured output GUI qualification\n',
  environment: { BLADE_TELEMETRY_DISABLED: '1' },
  configure: ({ model }) => ({
    config: {
      permissionMode: 'autoEdit',
      hooks: { enabled: false },
      disableAllHooks: true,
      mcpServers: {},
    },
    metadata: { model: model.model },
  }),
});
