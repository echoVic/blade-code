import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Blade durable state root. Kept in a leaf module so storage helpers and ACP
 * remote workspace validation can share one authority without circular imports.
 */
export function getBladeStorageRoot(): string {
  return process.env.BLADE_STORAGE_ROOT || path.join(os.homedir(), '.blade');
}
