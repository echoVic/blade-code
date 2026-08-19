import { writeFileSync } from 'node:fs';
import { SessionLease } from '../../src/agent/runtime/SessionLease.js';

const [sessionId, workspace, readyPath] = process.argv.slice(2);
if (!sessionId || !workspace || !readyPath) {
  throw new Error('missing lease input');
}

const lease = await SessionLease.acquire(sessionId, workspace);
try {
  writeFileSync(readyPath, String(process.pid));
  process.stdin.resume();
  await new Promise<void>((resolve) => process.stdin.once('end', resolve));
} finally {
  await lease.release();
}
