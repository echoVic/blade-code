export const INTERACTIVE_SHELL_INPUT = 'blade-stdin\n';

export function buildInteractiveShellCommand(outputFile: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(outputFile)) {
    throw new Error(`Unsafe interactive shell output file: ${outputFile}`);
  }
  return `tee ${outputFile}`;
}

export function buildInteractiveShellPrompt(command: string): string {
  return [
    'Exercise the Agent-owned interactive background shell contract exactly.',
    `1. Call Bash exactly once with command ${JSON.stringify(command)} and run_in_background=true.`,
    '2. Read shell_id from the Bash result. Call WriteStdin exactly once with that shell_id, data "blade-stdin\\n", and close_stdin=true.',
    '3. Call TaskOutput exactly once with task_id set to the same shell_id, block=true, and timeout=30000.',
    'Finish only after TaskOutput reports the process output. Do not call Write, Edit, KillShell, or another Bash command.',
  ].join('\n');
}
