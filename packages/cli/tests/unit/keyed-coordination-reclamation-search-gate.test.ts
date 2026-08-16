import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const cliRoot = fileURLToPath(new URL('../..', import.meta.url));
const srcRoot = path.join(cliRoot, 'src');

function source(relativePath: string): string {
  return readFileSync(path.join(cliRoot, relativePath), 'utf8');
}

const owners = [
  'src/services/SessionInteractionService.ts',
  'src/goals/GoalStore.ts',
  'src/mcp/auth/OAuthTokenStorage.ts',
  'src/config/ConfigService.ts',
  'src/worktree/WorktreeManager.ts',
  'src/server/routes/session.ts',
];

describe('keyed coordination reclamation source gate', () => {
  it('routes every audited keyed mutex owner through the reclaiming registry', () => {
    for (const owner of owners) {
      expect(source(owner), owner).toContain('KeyedMutexRegistry');
    }
  });

  it('does not retain a production Map keyed to raw Mutex instances', () => {
    const violations = readdirSync(srcRoot, {
      recursive: true,
      withFileTypes: true,
    })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
      .map((entry) => path.join(entry.parentPath, entry.name))
      .filter(
        (filePath) =>
          !filePath.endsWith(`${path.sep}KeyedMutexRegistry.ts`) &&
          /(?:Map<string,\s*Mutex>|new Map<[^;\n]*Mutex)/.test(
            readFileSync(filePath, 'utf8')
          )
      )
      .map((filePath) => path.relative(srcRoot, filePath));

    expect(violations).toEqual([]);
  });

  it('charges queued ownership before awaiting and reclaims in finally', () => {
    const registry = source('src/utils/KeyedMutexRegistry.ts');
    expect(registry.indexOf('entry.operations++')).toBeLessThan(
      registry.indexOf('entry.mutex.runExclusive(operation)')
    );
    expect(registry).toContain('finally');
    expect(registry).toContain('this.entries.get(key) === entry');
    expect(registry).toContain('this.entries.delete(key)');
  });

  it('does not depend on GC, timers, or unlocked eviction', () => {
    const registry = source('src/utils/KeyedMutexRegistry.ts');
    for (const forbidden of [
      'WeakRef',
      'FinalizationRegistry',
      'setTimeout',
      'setInterval',
      'isLocked',
    ]) {
      expect(registry).not.toContain(forbidden);
    }
  });
});
