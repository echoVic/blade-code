import { AutoMemoryManager } from '../../src/memory/AutoMemoryManager.js';

const [memoryDir, topic, entry] = process.argv.slice(2);
if (!memoryDir || !topic || !entry) {
  throw new Error(
    'Usage: memoryConsolidationConcurrentWriter <memory-dir> <topic> <entry>'
  );
}

const manager = new AutoMemoryManager(process.cwd(), undefined, memoryDir);
await manager.appendUniqueEntries(new Map([[topic, [entry]]]));
