import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { openDb } from '../../../../src/context/storage/sqlite/driver.js';

vi.unmock('child_process');
vi.unmock('node:child_process');

function source(relativePath: string): string {
  return readFileSync(
    new URL(`../../../../src/${relativePath}`, import.meta.url),
    'utf8'
  );
}

describe('SQLite initialization order', () => {
  it('installs busy waiting before negotiating WAL mode', () => {
    const driverSource = source('context/storage/sqlite/driver.ts');
    const busyTimeoutIndex = driverSource.indexOf(
      'PRAGMA busy_timeout=${busyTimeoutMs};'
    );
    const journalModeIndex = driverSource.indexOf('PRAGMA journal_mode=WAL;');

    expect(busyTimeoutIndex).toBeGreaterThanOrEqual(0);
    expect(journalModeIndex).toBeGreaterThan(busyTimeoutIndex);
  });

  it('keeps the ACP capacity coordinator on the shared WAL mode', () => {
    const coordinatorSource = source('acp/AcpRemoteWorkspaceReference.ts');

    expect(coordinatorSource).not.toContain('PRAGMA journal_mode=DELETE;');
    expect(coordinatorSource).toContain(
      'openDb(databasePath, { busyTimeoutMs: 30_000 })'
    );
    expect(coordinatorSource).toContain("database.exec('BEGIN IMMEDIATE;')");
    expect(coordinatorSource).toContain("database.exec('PRAGMA busy_timeout=30000;')");
  });

  it('closes a database whose initialization pragmas fail', () => {
    const driverSource = source('context/storage/sqlite/driver.ts');

    expect(driverSource).toContain('db?.close()');
  });

  it('waits for a real better-sqlite3 lock before negotiating WAL', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'blade-sqlite-open-'));
    const databasePath = path.join(root, 'coordinator.db');
    const childSource = [
      "const Database = require('better-sqlite3');",
      'const database = new Database(process.env.BLADE_SQLITE_TEST_PATH);',
      "database.exec('PRAGMA journal_mode=DELETE;');",
      "database.exec('CREATE TABLE IF NOT EXISTS lock_probe (id INTEGER);');",
      "database.exec('BEGIN EXCLUSIVE;');",
      "process.stdout.write('ready\\n');",
      'setTimeout(() => {',
      "database.exec('ROLLBACK;');",
      'database.close();',
      '}, 250);',
    ].join('\n');
    const child = spawn(process.execPath, ['-e', childSource], {
      cwd: path.resolve(import.meta.dirname, '../../../..'),
      env: { ...process.env, BLADE_SQLITE_TEST_PATH: databasePath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const childExit = new Promise<void>((resolve, reject) => {
      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
      });
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        if (code === 0 && signal === null) {
          resolve();
        } else {
          reject(new Error(`SQLite lock child failed (${code ?? signal}): ${stderr}`));
        }
      });
    });
    const childReady = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('SQLite lock child timed out')),
        5_000
      );
      child.stdout.setEncoding('utf8');
      child.stdout.once('data', (chunk: string) => {
        clearTimeout(timeout);
        if (chunk.includes('ready')) resolve();
        else reject(new Error(`Unexpected SQLite lock child output: ${chunk}`));
      });
    });

    try {
      await childReady;
      const database = await openDb(databasePath, { busyTimeoutMs: 1_000 });
      expect(database).not.toBeNull();
      database?.close();
      await childExit;
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await childExit.catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });
});
