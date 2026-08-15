import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function source(relativePath: string): string {
  return readFileSync(new URL(`../../src/${relativePath}`, import.meta.url), 'utf8');
}

function occurrences(value: string, pattern: RegExp): number {
  return value.match(pattern)?.length ?? 0;
}

describe('surface egress search gate', () => {
  it('keeps ACP sessionUpdate behind the Session-scoped serial writer', () => {
    const session = source('acp/Session.ts');
    const serviceContext = source('acp/AcpServiceContext.ts');

    expect(occurrences(session, /\bconnection\.sessionUpdate\(/g)).toBe(1);
    expect(serviceContext).not.toMatch(/\bconnection\.sessionUpdate\(/);
  });

  it('keeps each Web route writeSSE call inside its ordered writer adapter', () => {
    const sessionRoute = source('server/routes/session.ts');
    const globalRoute = source('server/routes/events.ts');

    expect(occurrences(sessionRoute, /\bstream\.writeSSE\(/g)).toBe(1);
    expect(occurrences(globalRoute, /\bstream\.writeSSE\(/g)).toBe(1);
    expect(sessionRoute).not.toContain('.writeSSE({');
    expect(globalRoute).not.toContain('.writeSSE({');
  });

  it('keeps raw Headless IO out of runHeadless after egress construction', () => {
    const headless = source('commands/headless.ts');
    const runner = headless.slice(
      headless.indexOf('export async function runHeadless')
    );
    const adapter = source('commands/HeadlessOutputEgress.ts');

    expect(runner).not.toMatch(/\bio\.(stdout|stderr)\.write\(/);
    expect(occurrences(adapter, /\bwriter\.write\(/g)).toBe(1);
  });
});
