import { describe, expect, it, vi } from 'vitest';
import {
  copyTranscriptText,
  createOsc52ClipboardSequence,
} from '../../../../../src/ui/utils/clipboard.js';

describe('transcript clipboard', () => {
  it('uses the native clipboard locally without emitting terminal control data', async () => {
    const runCommand = vi.fn<
      (command: string, args: readonly string[], text: string) => Promise<boolean>
    >(async () => true);
    const writeTerminal = vi.fn();

    await expect(
      copyTranscriptText('selected text', {
        platform: 'darwin',
        env: {},
        runCommand,
        writeTerminal,
      })
    ).resolves.toEqual({ success: true, method: 'native' });
    expect(runCommand).toHaveBeenCalledWith('pbcopy', [], 'selected text');
    expect(writeTerminal).not.toHaveBeenCalled();
  });

  it('uses the tmux buffer and passthrough when running remotely in tmux', async () => {
    const runCommand = vi.fn<
      (command: string, args: readonly string[], text: string) => Promise<boolean>
    >(async () => true);
    const writeTerminal = vi.fn();

    await expect(
      copyTranscriptText('remote text', {
        platform: 'linux',
        env: { SSH_CONNECTION: 'host', TMUX: '/tmp/tmux' },
        runCommand,
        writeTerminal,
      })
    ).resolves.toEqual({ success: true, method: 'tmux' });
    expect(runCommand).toHaveBeenCalledWith(
      'tmux',
      ['load-buffer', '-w', '-'],
      'remote text'
    );
    expect(writeTerminal).toHaveBeenCalledWith(
      createOsc52ClipboardSequence('remote text', true)
    );
  });

  it('falls back to OSC 52 when native clipboard commands fail', async () => {
    const runCommand = vi.fn<
      (command: string, args: readonly string[], text: string) => Promise<boolean>
    >(async () => false);
    const writeTerminal = vi.fn();

    await expect(
      copyTranscriptText('fallback', {
        platform: 'linux',
        env: {},
        runCommand,
        writeTerminal,
      })
    ).resolves.toEqual({ success: true, method: 'osc52' });
    expect(runCommand.mock.calls.map(([command]) => command)).toEqual([
      'wl-copy',
      'xclip',
      'xsel',
    ]);
    expect(writeTerminal).toHaveBeenCalledWith(
      createOsc52ClipboardSequence('fallback')
    );
  });

  it('does not report success for an empty selection', async () => {
    await expect(copyTranscriptText('')).resolves.toEqual({ success: false });
  });

  it('contains command and terminal failures instead of rejecting the caller', async () => {
    await expect(
      copyTranscriptText('text', {
        platform: 'darwin',
        env: {},
        runCommand: async () => {
          throw new Error('unavailable');
        },
        writeTerminal: () => {
          throw new Error('closed');
        },
      })
    ).resolves.toEqual({ success: false });
  });
});
