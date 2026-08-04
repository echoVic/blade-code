import { writeFile } from 'node:fs/promises';
import path from 'node:path';

export const INTERACTIVE_SHELL_INPUT = 'blade-stdin\n';
export const BOUNDED_OUTPUT_TAIL = 'BLADE_BOUNDED_OUTPUT_TAIL';
export const BOUNDED_OUTPUT_PROOF = 'bounded-output-observed\n';

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

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

export async function createBoundedOutputFixture(
  workspace: string,
  proofFile: string
): Promise<{ command: string; prompt: string }> {
  if (!/^[A-Za-z0-9._-]+$/.test(proofFile)) {
    throw new Error(`Unsafe bounded output proof file: ${proofFile}`);
  }

  const scriptFile = 'bounded-output.mjs';
  await writeFile(
    path.join(workspace, scriptFile),
    [
      "process.stdout.write('x'.repeat(1_100_000));",
      `process.stdout.write('${BOUNDED_OUTPUT_TAIL}\\n');`,
      '',
    ].join('\n')
  );
  const command = `${shellQuote(process.execPath)} ${scriptFile}`;
  const prompt = [
    'Exercise the bounded background output contract exactly.',
    `1. Call Bash exactly once with command ${JSON.stringify(command)} and run_in_background=true.`,
    '2. Read shell_id from the Bash result. Call TaskOutput exactly once with that task_id, block=true, and timeout=30000.',
    `3. Confirm the structured TaskOutput says output_truncated=true, stdout_omitted_bytes is positive, and stdout ends with ${BOUNDED_OUTPUT_TAIL}.`,
    `4. Call Write exactly once to create ${proofFile} with exact content ${JSON.stringify(BOUNDED_OUTPUT_PROOF)}.`,
    'Finish after Write succeeds. Do not call Read, Edit, WriteStdin, KillShell, or another Bash command.',
  ].join('\n');
  return { command, prompt };
}
