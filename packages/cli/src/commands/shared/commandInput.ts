import { resolveWorkspaceAgentResources } from '../../agent/resources/WorkspaceAgentResources.js';
import { executeSlashCommand, isSlashCommand } from '../../slash-commands/index.js';
import { getCwd } from '../../utils/cwd.js';

interface MessageLikeOptions {
  message?: string;
  _?: (string | number)[];
}

interface ReadCliInputOptions extends MessageLikeOptions {
  stdin?: NodeJS.ReadStream;
  defaultMessage?: string;
}

export async function initializeCliPlugins(): Promise<void> {
  await resolveWorkspaceAgentResources(getCwd());
}

export async function readCliInput(options: ReadCliInputOptions): Promise<string> {
  const message = options.message || options._?.[0];
  if (typeof message === 'string' && message.trim()) {
    return message;
  }

  const stdin = options.stdin ?? process.stdin;
  if (!stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of stdin) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf-8').trim();
  }

  if (options.defaultMessage !== undefined) {
    return options.defaultMessage;
  }

  throw new Error('No input provided');
}

export async function normalizeCliInput(input: string): Promise<{
  mode: 'agent' | 'output';
  content: string;
  exitCode?: number;
}> {
  if (!isSlashCommand(input)) {
    return { mode: 'agent', content: input };
  }

  const result = await executeSlashCommand(input, {
    cwd: getCwd(),
    surface: 'headless',
    workspaceRoot: getCwd(),
  });

  if (!result.success) {
    return {
      mode: 'output',
      content: `Error: ${result.error || '未知错误'}`,
      exitCode: 1,
    };
  }

  const data = result.data as Record<string, unknown> | undefined;
  if (data?.action === 'invoke_skill') {
    const skillName = data.skillName as string;
    const skillArgs = data.skillArgs as string | undefined;
    return {
      mode: 'agent',
      content: skillArgs
        ? `Please use the "${skillName}" skill to help me with: ${skillArgs}`
        : `Please use the "${skillName}" skill.`,
    };
  }

  if (
    data?.action === 'invoke_custom_command' ||
    data?.action === 'invoke_plugin_command'
  ) {
    const processedContent = data.processedContent as string;
    const commandName = data.commandName as string;
    return {
      mode: 'agent',
      content: `# Custom Command: /${commandName}\n\n${processedContent}`,
    };
  }

  return {
    mode: 'output',
    content: result.content || result.message || '',
    exitCode: 0,
  };
}
