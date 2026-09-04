import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function source(relativePath: string): string {
  return readFileSync(
    new URL(`../../../../src/${relativePath}`, import.meta.url),
    'utf8'
  );
}

describe('SQLite initialization order', () => {
  it('installs busy waiting before negotiating WAL mode', () => {
    const driverSource = source('context/storage/sqlite/driver.ts');
    const busyTimeoutIndex = driverSource.indexOf('PRAGMA busy_timeout=5000;');
    const journalModeIndex = driverSource.indexOf('PRAGMA journal_mode=WAL;');

    expect(busyTimeoutIndex).toBeGreaterThanOrEqual(0);
    expect(journalModeIndex).toBeGreaterThan(busyTimeoutIndex);
  });

  it('keeps the ACP capacity coordinator on the shared WAL mode', () => {
    const coordinatorSource = source('acp/AcpRemoteWorkspaceReference.ts');

    expect(coordinatorSource).not.toContain('PRAGMA journal_mode=DELETE;');
    expect(coordinatorSource).toContain("database.exec('BEGIN IMMEDIATE;')");
    expect(coordinatorSource).toContain("database.exec('PRAGMA busy_timeout=30000;')");
  });
});
