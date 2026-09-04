import { stat, writeFile } from 'node:fs/promises';
import { DurableSteeringInbox } from '../../src/agent/runtime/DurableSteeringInbox.js';

const [workspaceRoot, sessionId, messageId, readyPath, releasePath] =
  process.argv.slice(2);
if (!workspaceRoot || !sessionId || !messageId || !readyPath || !releasePath) {
  throw new Error(
    'usage: durable-steering-inbox-writer <workspace> <session> <message> <ready> <release>'
  );
}

const inbox = await DurableSteeringInbox.open(workspaceRoot, sessionId);
await writeFile(readyPath, 'ready', 'utf8');
const deadline = Date.now() + 5_000;
while (true) {
  try {
    await stat(releasePath);
    break;
  } catch {
    if (Date.now() >= deadline) throw new Error('writer release deadline exceeded');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const accepted = await inbox.enqueue({
  id: messageId,
  content: messageId,
  queuedAt: Date.now(),
});
if (!accepted) throw new Error('writer input was rejected');
