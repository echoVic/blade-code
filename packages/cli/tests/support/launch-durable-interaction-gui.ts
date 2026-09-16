import path from 'node:path';
import { PersistentStore } from '../../src/context/storage/PersistentStore.js';
import { SessionInteractionService } from '../../src/services/SessionInteractionService.js';
import { SessionService } from '../../src/services/SessionService.js';
import { launchRealApiGuiFixture } from './launchRealApiGuiFixture.js';

const question = {
  header: 'Channel',
  question: 'Which release channel should Blade write?',
  multiSelect: false,
  options: [
    { label: 'Stable', description: 'Use the stable release channel' },
    { label: 'Canary', description: 'Use the early canary release channel' },
  ],
};

await launchRealApiGuiFixture({
  scriptName: 'launch-durable-interaction-gui.ts',
  defaultPort: 4340,
  readme: '# Durable interaction GUI\n',
  configure: () => ({
    config: {
      permissionMode: 'default',
      hooks: { enabled: false },
      disableAllHooks: true,
      mcpServers: {},
    },
  }),
  afterCommit: async ({ canonicalWorkspace, runtimeConfig }) => {
    const sessionId = `interaction-gui-${Date.now()}`;
    const target = path.join(canonicalWorkspace, 'gui-selected-channel.txt');
    await SessionService.createSessionMetadata(sessionId, canonicalWorkspace, {
      title: 'Pending Channel Decision',
      taskStatus: 'completed',
      selectedModelId: runtimeConfig.currentModelId,
      permissionMode: 'yolo',
    });
    const store = new PersistentStore(canonicalWorkspace);
    await store.saveMessage(
      sessionId,
      'user',
      [
        'A Channel question will be recovered in the production Web UI.',
        `After the recovered answer, call Write exactly once with file_path=${JSON.stringify(
          target
        )}.`,
        'Set content to the selected label followed by exactly one newline.',
        'That Write is the only allowed tool call. Never call AskUserQuestion again.',
        'Do not emit assistant text or end the turn before Write succeeds.',
        'After Write succeeds, reply exactly GUI_INTERACTION_RECOVERED.',
      ].join(' ')
    );
    const toolCallId = await store.saveToolUse(sessionId, 'AskUserQuestion', {
      questions: [question],
    });
    const request = await SessionInteractionService.request(
      {
        sessionId,
        projectPath: canonicalWorkspace,
        toolCallId,
        toolName: 'AskUserQuestion',
      },
      {
        type: 'askUserQuestion',
        message: 'Choose a release channel',
        questions: [question],
      }
    );
    return { sessionId, requestId: request.requestId, target };
  },
});
