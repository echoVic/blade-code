import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function source(relativePath: string): string {
  return readFileSync(new URL(`../../src/${relativePath}`, import.meta.url), 'utf8');
}

function occurrences(value: string, pattern: RegExp): number {
  return value.match(pattern)?.length ?? 0;
}

describe('tool admission search gate', () => {
  it('keeps production tool invocation behind ToolExecutor admission', () => {
    const executor = source('tools/execution/ToolExecutor.ts');
    const runner = source('tools/execution/ToolInvocationRunner.ts');
    const allExecutionSource = [
      source('agent/loop/StreamingToolExecutor.ts'),
      source('agent/loop/executeLoopGenerator.ts'),
      executor,
      runner,
    ].join('\n');

    expect(occurrences(executor, /\bexecuteToolInvocation\(/g)).toBe(1);
    expect(occurrences(allExecutionSource, /\bexecuteToolInvocation\(/g)).toBe(2);
    expect(occurrences(executor, /\bthis\.scheduler\.schedule\(/g)).toBe(1);
  });

  it('keeps every production admission default finite', () => {
    const scheduler = source('tools/execution/ConcurrencyScheduler.ts');
    const gate = source('tools/execution/ToolConcurrencyGate.ts');

    expect(scheduler).not.toContain('Number.POSITIVE_INFINITY');
    expect(scheduler).not.toMatch(/\bInfinity\b/);
    expect(gate).not.toContain('Number.POSITIVE_INFINITY');
    expect(gate).not.toMatch(/\bInfinity\b/);
  });

  it('shares one turn limit across streaming and non-streaming execution', () => {
    const streaming = source('agent/loop/StreamingToolExecutor.ts');
    const loop = source('agent/loop/executeLoopGenerator.ts');
    const admission = source('tools/execution/ToolTurnAdmission.ts');

    expect(admission).toContain('export const TOOL_TURN_MAX_CALLS = 64');
    expect(occurrences(streaming, /\bnew ToolTurnAdmission\(/g)).toBe(1);
    expect(occurrences(loop, /\bnew ToolTurnAdmission\(/g)).toBe(1);
  });

  it('does not install a private scheduler in SessionRuntime or Agent', () => {
    const runtime = source('agent/runtime/SessionRuntime.ts');
    const agent = source('agent/Agent.ts');

    expect(runtime).not.toContain('new ConcurrencyScheduler');
    expect(agent).not.toContain('new ConcurrencyScheduler');
  });
});
