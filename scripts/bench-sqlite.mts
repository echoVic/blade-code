import { mkdtemp, rm, mkdir, writeFile, readdir, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../packages/cli/src/context/storage/sqlite/driver.ts';
import { migrate } from '../packages/cli/src/context/storage/sqlite/schema.ts';
import {
  syncAll,
  resetProjectionDbCache,
} from '../packages/cli/src/context/storage/sqlite/projection.ts';
import { parseSessionJSONL } from '../packages/cli/src/context/storage/JSONLStore.ts';
import { materializeSessionEvents } from '../packages/cli/src/services/sessionRewind.ts';

// ---- fixture generation ----
function iso(sec: number): string {
  return new Date(Date.UTC(2024, 0, 1, 0, 0, 0, 0) + sec * 1000).toISOString();
}

function buildTranscript(sessionId: string, cwd: string, turns: number): string {
  const lines: string[] = [];
  let seq = 0;
  const push = (type: string, data: unknown, at: string) =>
    lines.push(
      JSON.stringify({
        seq: ++seq,
        id: `${sessionId}-${seq}`,
        sessionId,
        projectPath: cwd,
        timestamp: at,
        type,
        cwd,
        version: 't',
        data,
      })
    );
  push('session_created', { sessionId, rootId: sessionId, createdAt: iso(0), updatedAt: iso(0) }, iso(0));
  for (let t = 0; t < turns; t++) {
    const u = `u${t}`;
    const a = `a${t}`;
    push('message_created', { messageId: u, role: 'user', createdAt: iso(t * 2) }, iso(t * 2));
    push('part_created', { partId: `p${u}`, messageId: u, partType: 'text', payload: { text: `question ${t} about topic keyword${t % 17}` }, createdAt: iso(t * 2) }, iso(t * 2));
    push('message_created', { messageId: a, role: 'assistant', parentMessageId: u, createdAt: iso(t * 2 + 1) }, iso(t * 2 + 1));
    push('part_created', { partId: `p${a}`, messageId: a, partType: 'text', payload: { text: `answer ${t} explaining details with keyword${t % 13} and more words to make it realistic length for a transcript line` }, createdAt: iso(t * 2 + 1) }, iso(t * 2 + 1));
  }
  return lines.join('\n') + '\n';
}

// ---- JSONL baseline implementations (mirror current scan/search) ----
async function jsonlListMetadata(projectsDir: string): Promise<number> {
  const dirs = await readdir(projectsDir);
  let count = 0;
  for (const dir of dirs) {
    const pdir = path.join(projectsDir, dir);
    let files: string[];
    try {
      files = await readdir(pdir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const content = await readFile(path.join(pdir, f), 'utf8');
      const entries = materializeSessionEvents(parseSessionJSONL(content, f));
      // simulate metadata aggregation (message count)
      count += entries.filter((e) => e.type === 'message_created').length;
    }
  }
  return count;
}

async function jsonlSearch(projectsDir: string, query: string): Promise<number> {
  const dirs = await readdir(projectsDir);
  let hits = 0;
  for (const dir of dirs) {
    const pdir = path.join(projectsDir, dir);
    let files: string[];
    try {
      files = await readdir(pdir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const content = await readFile(path.join(pdir, f), 'utf8');
      const events = materializeSessionEvents(parseSessionJSONL(content, f));
      for (const e of events) {
        if (e.type === 'part_created' && e.data.partType === 'text') {
          const text = (e.data.payload as { text?: string }).text ?? '';
          if (text.toLowerCase().includes(query)) hits++;
        }
      }
    }
  }
  return hits;
}

function now(): number {
  return Number(process.hrtime.bigint() / 1000n) / 1000; // ms
}

async function median(fn: () => Promise<unknown>, runs = 5): Promise<number> {
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = now();
    await fn();
    samples.push(now() - t0);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}

const deriver = (entries: readonly any[], sessionId: string, projectPath: string) => {
  const created = entries.find((e) => e.type === 'session_created');
  if (!created) return null;
  const projected = materializeSessionEvents(entries as any);
  const messageCount = projected.filter((e) => e.type === 'message_created').length;
  const times = projected.map((e) => e.timestamp).sort();
  return {
    sessionId,
    projectPath,
    rootId: sessionId,
    taskStatus: 'completed',
    title: sessionId,
    messageCount,
    firstMessageTime: times[0] ?? iso(0),
    lastMessageTime: times[times.length - 1] ?? iso(0),
    hasErrors: false,
  };
};

async function main() {
  const scales = [50, 200, 1000];
  const turnsPerSession = 20;
  const results: Array<Record<string, string>> = [];

  for (const N of scales) {
    const root = await mkdtemp(path.join(os.tmpdir(), `blade-bench-${N}-`));
    process.env.BLADE_STORAGE_ROOT = root;
    const projectsDir = path.join(root, 'projects');
    // spread across 5 project dirs
    const projectCount = 5;
    for (let p = 0; p < projectCount; p++) {
      const cwd = `/bench/project-${p}`;
      const escaped = cwd.replace(/[/\\]/g, '-').replace(/:/g, '_');
      const dir = path.join(projectsDir, escaped);
      await mkdir(dir, { recursive: true });
      const per = Math.ceil(N / projectCount);
      for (let s = 0; s < per; s++) {
        const sessionId = `sess-${p}-${String(s).padStart(4, '0')}`;
        await writeFile(path.join(dir, `${sessionId}.jsonl`), buildTranscript(sessionId, cwd, turnsPerSession), 'utf8');
      }
    }

    // measure avg transcript size
    const sampleDir = path.join(projectsDir, '-bench-project-0');
    const sampleFiles = await readdir(sampleDir);
    const sampleStat = await stat(path.join(sampleDir, sampleFiles[0]));

    // ---- JSONL cold ----
    const jsonlList = await median(() => jsonlListMetadata(projectsDir));
    const jsonlSearchMs = await median(() => jsonlSearch(projectsDir, 'keyword5'));

    // ---- SQLite: first build (cold sync) then warm query ----
    resetProjectionDbCache();
    const db = await openDb(path.join(root, 'index.db'));
    if (!db) throw new Error('no sqlite');
    migrate(db);

    const sqliteBuild = await median(async () => {
      // force re-sync by clearing state each run for a fair "build" number
      db.exec('DELETE FROM projection_state; DELETE FROM sessions; DELETE FROM parts; DELETE FROM parts_fts;');
      await syncAll(db, deriver as any);
    }, 3);

    // warm list (mtime-gated syncAll is near-zero, then SELECT)
    const sqliteList = await median(async () => {
      await syncAll(db, deriver as any);
      db.prepare('SELECT metadata_json FROM sessions').all();
    });
    const sqliteSearch = await median(async () => {
      await syncAll(db, deriver as any);
      db.prepare("SELECT session_id FROM parts_fts WHERE parts_fts MATCH ? LIMIT 20").all('keyword5*');
    });
    db.close();

    results.push({
      N: String(N),
      size: `${(sampleStat.size / 1024).toFixed(1)} KB/session`,
      jsonlList: jsonlList.toFixed(1),
      sqliteList: sqliteList.toFixed(1),
      listSpeedup: `${(jsonlList / sqliteList).toFixed(1)}x`,
      jsonlSearch: jsonlSearchMs.toFixed(1),
      sqliteSearch: sqliteSearch.toFixed(1),
      searchSpeedup: `${(jsonlSearchMs / sqliteSearch).toFixed(1)}x`,
      sqliteBuild: sqliteBuild.toFixed(1),
    });

    await rm(root, { recursive: true, force: true });
  }

  console.log('\n=== RESULTS (median ms, ' + turnsPerSession + ' turns/session, 5 projects) ===');
  console.log(JSON.stringify(results, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
