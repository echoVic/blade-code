import { writeFileSync } from 'node:fs';

const [rootPidFile, forbiddenEffectFile] = process.argv.slice(2);
if (!rootPidFile || !forbiddenEffectFile) process.exit(2);

writeFileSync(rootPidFile, String(process.pid));
process.on('SIGTERM', () => undefined);
setTimeout(() => writeFileSync(forbiddenEffectFile, 'late'), 5_000);
setInterval(() => undefined, 1_000);
