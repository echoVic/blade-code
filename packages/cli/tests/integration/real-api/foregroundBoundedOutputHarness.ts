import type { ProcessIdentity } from '../../../src/utils/process/ProcessIdentity.js';
import { processIdentityMatches } from '../../../src/utils/process/ProcessIdentity.js';
import { ForegroundProcessLeaseStore } from '../../../src/context/storage/ForegroundProcessLeaseStore.js';
import type { DurableToolTraceRecord } from './sessionForkTrajectoryHarness.js';
import { assertNoSecrets } from './sessionForkTrajectoryHarness.js';
import type { ForegroundBoundedOutputFixture } from './foregroundBoundedOutputFixture.js';

type Transport = 'local' | 'acp';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireNumber(
  value: unknown,
  field: string,
  predicate: (candidate: number) => boolean
): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    !predicate(value)
  ) {
    throw new Error(`Bounded output trace has invalid ${field}`);
  }
  return value;
}

export function assertForegroundBoundedOutputToolTrace(
  trace: readonly DurableToolTraceRecord[],
  fixture: ForegroundBoundedOutputFixture,
  transport: Transport
): void {
  if (trace.length !== 1) {
    throw new Error(`Expected exactly one foreground Bash call; received ${trace.length}`);
  }
  const record = trace[0];
  if (
    !record ||
    record.toolName !== 'Bash' ||
    !isRecord(record.input) ||
    record.input.command !== fixture.command ||
    record.input.run_in_background === true
  ) {
    throw new Error('Foreground bounded output Bash invocation did not match fixture');
  }
  if (record.error !== null || !isRecord(record.output)) {
    throw new Error('Foreground bounded output Bash result was not successful');
  }

  const output = record.output;
  if (
    output.output_truncated !== true ||
    output.output_accounting_complete !== true
  ) {
    throw new Error('Foreground bounded output result lacks complete truncation facts');
  }
  const stdoutTotal = requireNumber(
    output.stdout_total_bytes,
    'stdout_total_bytes',
    (value) => value > 0
  );
  const stderrTotal = requireNumber(
    output.stderr_total_bytes,
    'stderr_total_bytes',
    (value) => value >= 0
  );
  const stdoutOmitted = requireNumber(
    output.stdout_omitted_bytes,
    'stdout_omitted_bytes',
    (value) => value > 0
  );
  const stderrOmitted = requireNumber(
    output.stderr_omitted_bytes,
    'stderr_omitted_bytes',
    (value) => value >= 0
  );
  const visible = `${String(output.stdout ?? '')}\n${String(output.stderr ?? '')}`;

  if (
    !visible.includes(fixture.stdoutTail) ||
    !visible.includes(fixture.stderrTail) ||
    visible.includes(fixture.stdoutPrefixSentinel) ||
    visible.includes(fixture.stderrPrefixSentinel)
  ) {
    throw new Error('Foreground bounded output retained/omitted markers are invalid');
  }

  if (transport === 'local') {
    if (
      output.terminal_output_merged === true ||
      stdoutTotal !== fixture.stdoutBytes ||
      stderrTotal !== fixture.stderrBytes ||
      stdoutOmitted <= 0 ||
      stderrOmitted <= 0
    ) {
      throw new Error('Local foreground bounded output accounting is invalid');
    }
    return;
  }

  if (
    output.terminal_output_merged !== true ||
    stdoutTotal !== fixture.stdoutBytes + fixture.stderrBytes ||
    stderrTotal !== 0 ||
    stdoutOmitted <= 0 ||
    stderrOmitted !== 0
  ) {
    throw new Error('ACP foreground bounded output merged accounting is invalid');
  }
}

export function assertForegroundBoundedOutputEvidenceSafe(
  evidence: unknown,
  fixture: ForegroundBoundedOutputFixture,
  secrets: readonly string[]
): void {
  assertNoSecrets(evidence, secrets);
  const serialized = JSON.stringify(evidence);
  if (
    serialized.includes(fixture.stdoutPrefixSentinel) ||
    serialized.includes(fixture.stderrPrefixSentinel)
  ) {
    throw new Error('Omitted foreground output sentinel leaked into evidence');
  }
}

export async function assertNoForegroundLeases(
  workspace: string,
  sessionId: string
): Promise<void> {
  const result = await new ForegroundProcessLeaseStore(
    workspace,
    sessionId
  ).reapOrphans();
  if (result.active + result.protected + result.reaped + result.stale !== 0) {
    throw new Error('Foreground process lease remained after qualification');
  }
}

export interface OwnedProcessEvidence {
  pid: number;
  identity: ProcessIdentity;
}

export function assertOwnedProcessesGone(
  processes: readonly OwnedProcessEvidence[]
): void {
  for (const process of processes) {
    if (processIdentityMatches(process.pid, process.identity)) {
      throw new Error(`Owned process ${process.pid} remained after qualification`);
    }
  }
}
