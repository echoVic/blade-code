import { appendFile } from 'node:fs/promises';
import { withPatchWorkspaceLock } from '../../src/tools/builtin/file/PatchTransactionCoordinator.js';

const [workspace, storageRoot, traceFile, name, holdMs = '0'] = process.argv.slice(2);
if (!workspace || !storageRoot || !traceFile || !name) {
  throw new Error(
    'Usage: patch-lock-worker <workspace> <storage-root> <trace> <name> [hold-ms]'
  );
}

process.env.BLADE_STORAGE_ROOT = storageRoot;
await withPatchWorkspaceLock(workspace, async () => {
  await appendFile(traceFile, `${name}:start\n`);
  await new Promise((resolve) => setTimeout(resolve, Number(holdMs)));
  await appendFile(traceFile, `${name}:end\n`);
});
