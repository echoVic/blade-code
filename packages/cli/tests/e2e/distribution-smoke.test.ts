import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const cliEntry = path.resolve('dist', 'blade.js');
const environment = { ...process.env, BLADE_TELEMETRY_DISABLED: '1' };

describe('production distribution', () => {
  it('starts the packaged CLI and exposes its primary commands', () => {
    const version = spawnSync('node', [cliEntry, '--version'], {
      encoding: 'utf8',
      env: environment,
    });
    const help = spawnSync('node', [cliEntry, '--help'], {
      encoding: 'utf8',
      env: environment,
    });
    const expectedVersion = JSON.parse(readFileSync('package.json', 'utf8')).version;

    expect(version.error).toBeUndefined();
    expect(version.status).toBe(0);
    expect(version.stdout.trim()).toBe(expectedVersion);
    expect(help.status).toBe(0);
    expect(`${help.stdout}\n${help.stderr}`).toMatch(/--headless|browser/);
  });
});
