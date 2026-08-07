import { execFile } from 'node:child_process';
import path from 'node:path';
import type { ProjectDirectorySelection } from '../api/schemas.js';

const CANCELLED_MARKER = '__BLADE_DIRECTORY_PICKER_CANCELLED__';
const PICKER_TIMEOUT_MS = 15 * 60 * 1000;

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  errorCode?: string;
}

export type DirectoryPickerCommandRunner = (
  command: string,
  args: readonly string[]
) => Promise<CommandResult>;

interface NativeDirectoryPickerOptions {
  platform?: NodeJS.Platform;
  runCommand?: DirectoryPickerCommandRunner;
}

function runCommand(command: string, args: readonly string[]): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(
      command,
      [...args],
      {
        timeout: PICKER_TIMEOUT_MS,
        maxBuffer: 64 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const code = error?.code;
        resolve({
          stdout,
          stderr,
          exitCode: typeof code === 'number' ? code : error ? 1 : 0,
          ...(typeof code === 'string' ? { errorCode: code } : {}),
        });
      }
    );
  });
}

function selectionFromOutput(output: string): ProjectDirectorySelection {
  const selectedPath = output.replace(/[\r\n]+$/, '');
  if (!selectedPath || selectedPath === CANCELLED_MARKER) {
    return { cancelled: true };
  }
  if (!path.isAbsolute(selectedPath)) {
    throw new Error('The folder picker returned an invalid path');
  }
  return { cancelled: false, path: selectedPath };
}

function pickerFailed(result: CommandResult): boolean {
  return result.exitCode !== 0 || Boolean(result.errorCode);
}

export class NativeDirectoryPicker {
  private readonly platform: NodeJS.Platform;
  private readonly runCommand: DirectoryPickerCommandRunner;
  private activeSelection: Promise<ProjectDirectorySelection> | null = null;

  constructor(options: NativeDirectoryPickerOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.runCommand = options.runCommand ?? runCommand;
  }

  pick(): Promise<ProjectDirectorySelection> {
    if (this.activeSelection) return this.activeSelection;
    const selection = this.pickForPlatform().finally(() => {
      this.activeSelection = null;
    });
    this.activeSelection = selection;
    return selection;
  }

  private async pickForPlatform(): Promise<ProjectDirectorySelection> {
    switch (this.platform) {
      case 'darwin':
        return this.pickOnMac();
      case 'win32':
        return this.pickOnWindows();
      case 'linux':
        return this.pickOnLinux();
      default:
        throw new Error('Native folder selection is unavailable on this system');
    }
  }

  private async pickOnMac(): Promise<ProjectDirectorySelection> {
    const script = [
      'try',
      'set selectedFolder to choose folder with prompt "Choose a project folder"',
      'return POSIX path of selectedFolder',
      'on error number -128',
      `return "${CANCELLED_MARKER}"`,
      'end try',
    ].join('\n');
    const result = await this.runCommand('osascript', ['-e', script]);
    if (pickerFailed(result)) {
      throw new Error('Unable to open the macOS folder picker');
    }
    return selectionFromOutput(result.stdout);
  }

  private async pickOnWindows(): Promise<ProjectDirectorySelection> {
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
      '$dialog.Description = "Choose a project folder"',
      '$dialog.ShowNewFolderButton = $true',
      'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {',
      '  [Console]::Out.Write($dialog.SelectedPath)',
      '} else {',
      `  [Console]::Out.Write("${CANCELLED_MARKER}")`,
      '}',
    ].join('; ');
    const result = await this.runCommand('powershell.exe', [
      '-NoProfile',
      '-STA',
      '-Command',
      script,
    ]);
    if (pickerFailed(result)) {
      throw new Error('Unable to open the Windows folder picker');
    }
    return selectionFromOutput(result.stdout);
  }

  private async pickOnLinux(): Promise<ProjectDirectorySelection> {
    const candidates = [
      {
        command: 'zenity',
        args: ['--file-selection', '--directory', '--title=Choose a project folder'],
      },
      {
        command: 'kdialog',
        args: ['--getexistingdirectory', '.', '--title', 'Choose a project folder'],
      },
    ] as const;

    for (const candidate of candidates) {
      const result = await this.runCommand(candidate.command, candidate.args);
      if (result.errorCode === 'ENOENT') continue;
      if (result.exitCode === 1 && !result.stdout.trim() && !result.stderr.trim()) {
        return { cancelled: true };
      }
      if (pickerFailed(result)) {
        throw new Error('Unable to open the Linux folder picker');
      }
      return selectionFromOutput(result.stdout);
    }

    throw new Error('Install zenity or kdialog to use native folder selection');
  }
}

export const nativeDirectoryPicker = new NativeDirectoryPicker();
