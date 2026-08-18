import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const supportDir = path.resolve(import.meta.dirname, '../../support');
const runnerInventory = [
  'backgroundSubagentCompletionPtyRunner.ts',
  'foregroundBoundedOutputPtyRunner.ts',
  'foregroundCommandHandoffPtyRunner.ts',
  'foregroundProviderRecoveryPtyRunner.ts',
  'goalFinalizationPtyRunner.ts',
  'gracefulShutdownPtyRunner.ts',
  'promptCacheStatusPtyRunner.ts',
  'rootTurnAutoResumePtyRunner.ts',
  'sessionRuntimeResidencyPtyRunner.ts',
  'subagentResultAdoptionPtyRunner.ts',
  'toolAdmissionPtyRunner.ts',
  'tuiPtyRunner.ts',
  'weightedProviderAdmissionPtyRunner.ts',
] as const;

function readRunner(fileName: (typeof runnerInventory)[number]): string {
  return readFileSync(path.join(supportDir, fileName), 'utf8');
}

describe('raw PTY marker latching source contract', () => {
  it('requires every production PTY runner to be explicitly inventoried', () => {
    const actual = readdirSync(supportDir)
      .filter((fileName) => /PtyRunner\.ts$/.test(fileName))
      .sort();

    expect(actual).toEqual([...runnerInventory]);
  });

  it.each([
    ['backgroundSubagentCompletionPtyRunner.ts', 'latchPtyMarker'],
    ['foregroundBoundedOutputPtyRunner.ts', 'latchForegroundBoundedPtyMarkers'],
    ['goalFinalizationPtyRunner.ts', 'latchPtyMarker'],
    ['promptCacheStatusPtyRunner.ts', 'latchPtyMarker'],
    ['rootTurnAutoResumePtyRunner.ts', 'latchPtyMarker'],
    ['subagentResultAdoptionPtyRunner.ts', 'latchPtyMarker'],
    ['tuiPtyRunner.ts', 'latchPtyMarker'],
    ['weightedProviderAdmissionPtyRunner.ts', 'latchPtyEvidence'],
  ] as const)('%s latches positive marker evidence', (fileName, latchName) => {
    expect(readRunner(fileName)).toContain(latchName);
  });

  it('does not derive completed evidence from a rotatable terminal tail', () => {
    const forbidden = [
      'sawChildMarker: output.includes',
      'sawParentFinal: output.includes',
      'sawInitial: output.includes',
      "sawCompleteGoal: output.includes('goal:complete')",
      'sawFollowup: output.includes',
      'sawChild: output.includes',
      'sawParent: output.includes',
      'sawExpected: output.includes',
      'parentFinalVisible: output.includes',
    ];
    const sources = runnerInventory.map(readRunner).join('\n');

    for (const pattern of forbidden) {
      expect(sources).not.toContain(pattern);
    }
  });

  it('gives background completion stages one shared evidence deadline', () => {
    const source = readRunner('backgroundSubagentCompletionPtyRunner.ts');

    expect(source).toContain('const evidenceDeadline = Date.now() + 180_000');
    expect(source).not.toContain(
      "'Raw PTY did not render Provider admission queue',\n      60_000"
    );
  });
});
