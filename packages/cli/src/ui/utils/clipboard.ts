import { spawn } from 'node:child_process';

export type ClipboardMethod = 'native' | 'tmux' | 'osc52';

export interface ClipboardCopyResult {
  success: boolean;
  method?: ClipboardMethod;
}

interface ClipboardCommand {
  command: string;
  args: string[];
}

interface ClipboardOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  runCommand?: (
    command: string,
    args: readonly string[],
    text: string
  ) => Promise<boolean>;
  writeTerminal?: (value: string) => void;
}

function nativeClipboardCommands(platform: NodeJS.Platform): ClipboardCommand[] {
  if (platform === 'darwin') {
    return [{ command: 'pbcopy', args: [] }];
  }
  if (platform === 'win32') {
    return [{ command: 'clip', args: [] }];
  }
  if (platform === 'linux') {
    return [
      { command: 'wl-copy', args: [] },
      { command: 'xclip', args: ['-selection', 'clipboard'] },
      { command: 'xsel', args: ['--clipboard', '--input'] },
    ];
  }
  return [];
}

function runClipboardCommand(
  command: string,
  args: readonly string[],
  text: string
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(command, [...args], {
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolve(false);
    }, 2000);

    const finish = (success: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(success);
    };
    child.once('error', () => finish(false));
    child.once('close', (code) => finish(code === 0));
    child.stdin.once('error', () => finish(false));
    child.stdin.end(text);
  });
}

export function createOsc52ClipboardSequence(
  text: string,
  tmuxPassthrough = false
): string {
  const sequence = `\u001B]52;c;${Buffer.from(text, 'utf8').toString('base64')}\u0007`;
  if (!tmuxPassthrough) return sequence;
  return `\u001BPtmux;${sequence.replaceAll('\u001B', '\u001B\u001B')}\u001B\\`;
}

export async function copyTranscriptText(
  text: string,
  options: ClipboardOptions = {}
): Promise<ClipboardCopyResult> {
  if (text.length === 0) return { success: false };

  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const runCommand = options.runCommand ?? runClipboardCommand;
  const writeTerminal =
    options.writeTerminal ?? ((value: string) => process.stdout.write(value));
  const isRemote = Boolean(env.SSH_CONNECTION);
  const commandSucceeded = async (command: ClipboardCommand): Promise<boolean> => {
    try {
      return await runCommand(command.command, command.args, text);
    } catch {
      return false;
    }
  };

  if (!isRemote) {
    for (const command of nativeClipboardCommands(platform)) {
      if (await commandSucceeded(command)) {
        return { success: true, method: 'native' };
      }
    }
  }

  if (env.TMUX) {
    if (
      await commandSucceeded({
        command: 'tmux',
        args: ['load-buffer', '-w', '-'],
      })
    ) {
      try {
        writeTerminal(createOsc52ClipboardSequence(text, true));
      } catch {
        // The tmux paste buffer already contains the text.
      }
      return { success: true, method: 'tmux' };
    }
  }

  try {
    writeTerminal(createOsc52ClipboardSequence(text));
    return { success: true, method: 'osc52' };
  } catch {
    return { success: false };
  }
}
