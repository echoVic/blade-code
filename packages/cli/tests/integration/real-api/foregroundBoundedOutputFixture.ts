import { writeFile } from 'node:fs/promises';
import path from 'node:path';

export const FOREGROUND_STREAM_BYTES = 1024 * 1024 + 64 * 1024;

export interface ForegroundBoundedOutputFixture {
  scriptPath: string;
  command: string;
  localPrompt: string;
  acpPrompt: string;
  stdoutPrefixSentinel: string;
  stderrPrefixSentinel: string;
  stdoutTail: string;
  stderrTail: string;
  stdoutBytes: number;
  stderrBytes: number;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export async function createForegroundBoundedOutputFixture(
  workspace: string,
  nonce: string
): Promise<ForegroundBoundedOutputFixture> {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(nonce)) {
    throw new Error('Foreground bounded output nonce is invalid');
  }

  const stdoutPrefixSentinel = `STDOUT_OMITTED_PREFIX_${nonce}`;
  const stderrPrefixSentinel = `STDERR_OMITTED_PREFIX_${nonce}`;
  const stdoutTail = `STDOUT_RETAINED_TAIL_${nonce}`;
  const stderrTail = `STDERR_RETAINED_TAIL_${nonce}`;
  const scriptPath = path.join(workspace, `bounded-foreground-${nonce}.mjs`);
  const script = [
    'const totalBytes = 1024 * 1024 + 64 * 1024;',
    `const stdoutPrefix = Buffer.from(${JSON.stringify(`${stdoutPrefixSentinel}\n`)});`,
    `const stderrPrefix = Buffer.from(${JSON.stringify(`${stderrPrefixSentinel}\n`)});`,
    `const stdoutTail = Buffer.from(${JSON.stringify(`\n${stdoutTail}\n`)});`,
    `const stderrTail = Buffer.from(${JSON.stringify(`\n${stderrTail}\n`)});`,
    'const stdoutFiller = Buffer.alloc(totalBytes - stdoutPrefix.length - stdoutTail.length, 0x78);',
    'const stderrFiller = Buffer.alloc(totalBytes - stderrPrefix.length - stderrTail.length, 0x79);',
    'process.stdout.write(stdoutPrefix);',
    'process.stdout.write(stdoutFiller);',
    'process.stderr.write(stderrPrefix);',
    'process.stderr.write(stderrFiller);',
    'process.stdout.write(stdoutTail);',
    'process.stderr.write(stderrTail);',
    '',
  ].join('\n');
  await writeFile(scriptPath, script, { mode: 0o600 });

  const command = `${shellQuote(process.execPath)} ${shellQuote(scriptPath)}`;
  const localPrompt = [
    'Run the bounded foreground output fixture exactly once.',
    `Call Bash exactly once with command ${JSON.stringify(command)}, run_in_background=false, and timeout=30000.`,
    `After the result, verify output_truncated=true, both stdout_omitted_bytes and stderr_omitted_bytes are positive, and the visible tails contain ${stdoutTail} and ${stderrTail}.`,
    `Reply with BOUNDED_FOREGROUND_OK_${nonce}. Do not call any other tool.`,
  ].join('\n');
  const acpPrompt = [
    'Run the bounded ACP foreground output fixture exactly once.',
    `Call Bash exactly once with command ${JSON.stringify(command)}, run_in_background=false, and timeout=30000.`,
    `After the result, verify terminal_output_merged=true, stdout_omitted_bytes is positive, stderr_total_bytes=0, and the merged visible output contains ${stdoutTail} and ${stderrTail}.`,
    `Reply with BOUNDED_FOREGROUND_ACP_OK_${nonce}. Do not call any other tool.`,
  ].join('\n');

  return {
    scriptPath,
    command,
    localPrompt,
    acpPrompt,
    stdoutPrefixSentinel,
    stderrPrefixSentinel,
    stdoutTail,
    stderrTail,
    stdoutBytes: FOREGROUND_STREAM_BYTES,
    stderrBytes: FOREGROUND_STREAM_BYTES,
  };
}
