import { Box, Files, GitBranch, HardDrive } from 'lucide-react';
import { useAppStore } from '@/store/AppStore';
import { useSessionStore } from '@/store/session';
import { sameSessionRef } from '@/store/session/sessionIdentity';

function basename(path: string): string {
  return path.split('/').filter(Boolean).at(-1) || path;
}

export function TaskArtifactBar() {
  const { sessions, currentSessionRef } = useSessionStore();
  const setFilePreviewOpen = useAppStore((state) => state.setFilePreviewOpen);
  const session = sessions.find((candidate) =>
    sameSessionRef(
      {
        sessionId: candidate.sessionId,
        projectPath: candidate.projectPath,
      },
      currentSessionRef
    )
  );
  if (!session?.taskIsolation) return null;

  const diff = session.taskDiffStat;
  return (
    <div className="flex min-h-10 items-center gap-2 border-b border-zinc-200 bg-zinc-50/80 px-4 font-mono text-[10px] text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950/70 dark:text-zinc-500">
      <span className="inline-flex items-center gap-1.5">
        <HardDrive className="h-3 w-3" />
        {basename(session.taskSourceProjectPath || session.projectPath)}
      </span>
      <span className="text-zinc-300 dark:text-zinc-800">/</span>
      <span className="inline-flex min-w-0 items-center gap-1.5">
        {session.taskIsolation === 'worktree' ? (
          <Box className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
        ) : (
          <HardDrive className="h-3 w-3" />
        )}
        {session.taskIsolation === 'worktree' ? 'isolated' : 'local'}
      </span>
      {session.taskWorktreeBranch && (
        <>
          <span className="text-zinc-300 dark:text-zinc-800">/</span>
          <span className="inline-flex min-w-0 items-center gap-1.5 truncate">
            <GitBranch className="h-3 w-3" />
            <span className="truncate">{session.taskWorktreeBranch}</span>
          </span>
        </>
      )}
      {diff && (
        <span className="ml-auto inline-flex items-center gap-2">
          <span className="inline-flex items-center gap-1 text-zinc-600 dark:text-zinc-400">
            <Files className="h-3 w-3" />
            {diff.changedFiles}
          </span>
          <span className="text-emerald-700 dark:text-emerald-400">
            +{diff.additions}
          </span>
          <span className="text-red-600 dark:text-red-400">-{diff.deletions}</span>
          {diff.commits > 0 && <span>{diff.commits} commits</span>}
          {diff.changedFiles > 0 && (
            <button
              type="button"
              onClick={() => setFilePreviewOpen(true)}
              className="ml-1 rounded border border-zinc-300 bg-white px-2 py-1 text-zinc-700 transition hover:border-emerald-500 hover:text-emerald-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:border-emerald-600 dark:hover:text-emerald-400"
            >
              Review changes
            </button>
          )}
        </span>
      )}
    </div>
  );
}
