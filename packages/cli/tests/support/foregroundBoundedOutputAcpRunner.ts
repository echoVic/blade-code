import path from 'node:path';
import { WorkspaceTrustService } from '../../src/security/WorkspaceTrustService.js';
import { ensureStoreInitialized } from '../../src/store/vanilla.js';
import type { ForegroundBoundedOutputFixture } from '../integration/real-api/foregroundBoundedOutputFixture.js';
import {
  encodeForegroundBoundedOutputAcpEvidence,
  runForegroundBoundedOutputAcpDriverInProcess,
} from './foregroundBoundedOutputAcpDriver.js';

interface RunnerInput {
  workspace: string;
  fixture: ForegroundBoundedOutputFixture;
  secret: string;
  timeoutMs?: number;
}

const encodedInput = process.env.BLADE_BOUNDED_ACP_INPUT;
if (!encodedInput) throw new Error('Bun ACP runner input is missing');
const input = JSON.parse(
  Buffer.from(encodedInput, 'base64').toString('utf8')
) as RunnerInput;
if (!path.isAbsolute(input.workspace) || !input.fixture?.command || !input.secret) {
  throw new Error('Bun ACP runner input is invalid');
}

await ensureStoreInitialized();
WorkspaceTrustService.resetInstance();
await WorkspaceTrustService.getInstance().trust(input.workspace);

try {
  const evidence = await runForegroundBoundedOutputAcpDriverInProcess(input);
  process.stdout.write(`\n${encodeForegroundBoundedOutputAcpEvidence(evidence)}\n`);
} finally {
  WorkspaceTrustService.resetInstance();
}
