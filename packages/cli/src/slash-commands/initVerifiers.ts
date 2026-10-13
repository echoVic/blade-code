import { INIT_VERIFIERS_PROMPT } from '../api/projectVerificationPrompt.js';
import type { SlashCommand } from './types.js';

export { INIT_VERIFIERS_PROMPT };

const initVerifiersCommand: SlashCommand = {
  name: 'init-verifiers',
  description: '从实际项目配置生成可复用的验证 Skills',
  usage: '/init-verifiers',
  async handler(args, context) {
    if (args.length > 0) {
      return { success: false, error: 'Usage: /init-verifiers' };
    }
    if (context.workspaceKind === 'acp-remote') {
      return { success: false, error: '远程工作区暂不支持生成项目验证 Skills' };
    }
    return {
      success: true,
      data: {
        action: 'invoke_custom_command',
        commandName: 'init-verifiers',
        processedContent: INIT_VERIFIERS_PROMPT,
      },
    };
  },
};

export default initVerifiersCommand;
