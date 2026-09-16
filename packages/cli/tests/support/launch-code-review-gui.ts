import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { launchRealApiGuiFixture } from './launchRealApiGuiFixture.js';

const execFileAsync = promisify(execFile);
const authorized = (assignment: boolean) =>
  [
    'export interface User {',
    '  id: string;',
    '  isAdmin: boolean;',
    '}',
    '',
    'export function isAuthorized(user: User, resourceOwnerId: string) {',
    '  if (user.isAdmin) return true;',
    `  return ${assignment ? '(user.id = resourceOwnerId)' : 'user.id === resourceOwnerId'};`,
    '}',
    '',
  ].join('\n');

await launchRealApiGuiFixture({
  scriptName: 'launch-code-review-gui.ts',
  defaultPort: 4341,
  environment: { BLADE_TELEMETRY_DISABLED: '1' },
  configure: () => ({
    config: {
      permissionMode: 'default',
      hooks: { enabled: false },
      disableAllHooks: true,
      mcpServers: {},
    },
  }),
  setup: async ({ workspace }) => {
    await writeFile(path.join(workspace, 'authorization.ts'), authorized(false));
  },
  afterCommit: async ({ canonicalWorkspace }) => {
    const target = path.join(canonicalWorkspace, 'authorization.ts');
    await writeFile(target, authorized(true));
    const beforeContent = await readFile(target, 'utf8');
    const beforeStatus = (
      await execFileAsync('git', ['status', '--porcelain=v1'], {
        cwd: canonicalWorkspace,
        encoding: 'utf8',
      })
    ).stdout.trim();
    return { target, beforeContent, beforeStatus };
  },
});
