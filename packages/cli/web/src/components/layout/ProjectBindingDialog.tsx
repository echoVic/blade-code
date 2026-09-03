import {
  FolderGit2,
  FolderOpen,
  FolderPlus,
  GitBranch,
  Loader2,
  Trash2,
} from 'lucide-react';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useT } from '@/i18n';
import { restoreFocusToSelector } from '@/lib/mobileNavigationFocus';
import { cn } from '@/lib/utils';
import { sessionService } from '@/services';
import { useSessionStore } from '@/store/session';
import {
  isHistorySurfaceActive,
  rejectHistorySurfaceAction,
} from '@/store/session/historySurfaceGuard';

interface ProjectBindingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ProjectBindingDialog({
  open,
  onOpenChange,
}: ProjectBindingDialogProps) {
  const t = useT();
  const {
    boundProjects,
    selectedProjectPath,
    isBindingProject,
    loadBoundProjects,
    bindProject,
    unbindProject,
    selectProject,
    startTemporarySession,
  } = useSessionStore();
  const historyOnly = useSessionStore((state) =>
    isHistorySurfaceActive(state.historySurfaceSelection)
  );
  const [projectPath, setProjectPath] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const [isPickingDirectory, setIsPickingDirectory] = useState(false);
  const pickerRequestRef = useRef(0);

  useEffect(() => {
    if (open && !historyOnly) {
      void loadBoundProjects();
      return;
    }
    pickerRequestRef.current += 1;
    setIsPickingDirectory(false);
  }, [historyOnly, loadBoundProjects, open]);

  const bindAndOpenProject = async (path: string) => {
    if (rejectHistorySurfaceAction(useSessionStore.getState())) return;
    await bindProject(path);
    setProjectPath('');
    startTemporarySession();
    onOpenChange(false);
  };

  const handleBind = async (event: FormEvent) => {
    event.preventDefault();
    if (!projectPath.trim() || isBindingProject || isPickingDirectory) return;
    setLocalError(null);
    try {
      await bindAndOpenProject(projectPath.trim());
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : t('projects.bind.failed'));
    }
  };

  const handlePickDirectory = async () => {
    if (rejectHistorySurfaceAction(useSessionStore.getState())) return;
    if (isPickingDirectory || isBindingProject) return;
    const requestId = ++pickerRequestRef.current;
    setLocalError(null);
    setIsPickingDirectory(true);
    try {
      const selection = await sessionService.pickProjectDirectory();
      if (requestId !== pickerRequestRef.current) return;
      if (selection.cancelled) return;
      setProjectPath(selection.path);
      await bindAndOpenProject(selection.path);
    } catch (error) {
      if (requestId !== pickerRequestRef.current) return;
      setLocalError(error instanceof Error ? error.message : t('projects.pick.failed'));
    } finally {
      if (requestId === pickerRequestRef.current) {
        setIsPickingDirectory(false);
      }
    }
  };

  const handleSelect = (path: string) => {
    if (rejectHistorySurfaceAction(useSessionStore.getState())) return;
    selectProject(path);
    startTemporarySession();
    onOpenChange(false);
  };

  if (!open || historyOnly) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        onCloseAutoFocus={(event) =>
          restoreFocusToSelector('[data-project-setup-trigger]', event)
        }
        className="border-[hsl(var(--deck-border))] bg-[hsl(var(--deck-canvas))] text-[hsl(var(--deck-ink))] sm:max-w-xl"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 font-mono text-[16px]">
            <FolderPlus className="h-4 w-4 text-[hsl(var(--deck-accent))]" />
            {t('projects.dialog.title')}
          </DialogTitle>
          <DialogDescription className="text-[12px] text-[hsl(var(--deck-ink-muted))]">
            {t('projects.dialog.description')}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleBind} className="flex gap-2">
          <input
            value={projectPath}
            onChange={(event) => setProjectPath(event.target.value)}
            disabled={isBindingProject}
            placeholder={t('projects.bind.placeholder')}
            aria-label={t('projects.bind.pathLabel')}
            className="h-9 min-w-0 flex-1 rounded-md border border-[hsl(var(--deck-border))] bg-[hsl(var(--deck-surface))] px-3 font-mono text-[12px] outline-none placeholder:text-[hsl(var(--deck-ink-faint))] focus:border-[hsl(var(--deck-accent)/0.65)]"
          />
          <button
            type="button"
            onClick={() => void handlePickDirectory()}
            disabled={isPickingDirectory || isBindingProject}
            title={t('projects.pick.action')}
            aria-label={t('projects.pick.action')}
            className="inline-flex h-9 shrink-0 items-center gap-2 rounded-md border border-[hsl(var(--deck-border))] bg-[hsl(var(--deck-surface))] px-2.5 font-mono text-[12px] text-[hsl(var(--deck-ink-muted))] transition-colors hover:border-[hsl(var(--deck-border-strong))] hover:text-[hsl(var(--deck-ink))] disabled:cursor-wait disabled:opacity-50"
          >
            {isPickingDirectory ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <FolderOpen className="h-3.5 w-3.5" />
            )}
            <span className="hidden sm:inline">
              {t(
                isPickingDirectory
                  ? 'projects.pick.picking'
                  : 'projects.pick.actionShort'
              )}
            </span>
          </button>
          <button
            type="submit"
            disabled={!projectPath.trim() || isBindingProject || isPickingDirectory}
            className="inline-flex h-9 items-center gap-2 rounded-md bg-[hsl(var(--deck-ink))] px-3 font-mono text-[12px] text-[hsl(var(--deck-canvas))] transition-opacity disabled:opacity-40"
          >
            {isBindingProject ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <FolderPlus className="h-3.5 w-3.5" />
            )}
            {t('projects.bind.action')}
          </button>
        </form>

        {localError && (
          <div
            role="alert"
            className="rounded-md border border-red-200 bg-red-50 px-3 py-2 font-mono text-[11px] text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300"
          >
            {localError}
          </div>
        )}

        <div className="max-h-72 space-y-1 overflow-y-auto">
          {boundProjects.map((project) => {
            const selected = project.path === selectedProjectPath;
            return (
              <div
                key={project.path}
                className={cn(
                  'group flex items-center gap-3 rounded-md border px-3 py-2',
                  selected
                    ? 'border-[hsl(var(--deck-accent)/0.55)] bg-[hsl(var(--deck-accent-soft))]'
                    : 'border-transparent hover:border-[hsl(var(--deck-border))] hover:bg-[hsl(var(--deck-surface))]'
                )}
              >
                <FolderGit2
                  className={cn(
                    'h-4 w-4 shrink-0',
                    selected
                      ? 'text-[hsl(var(--deck-accent))]'
                      : 'text-[hsl(var(--deck-ink-faint))]'
                  )}
                />
                <button
                  type="button"
                  disabled={!project.available}
                  onClick={() => handleSelect(project.path)}
                  className="min-w-0 flex-1 text-left disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <span className="block truncate font-mono text-[12px] text-[hsl(var(--deck-ink))]">
                    {project.name}
                  </span>
                  <span className="mt-0.5 flex items-center gap-1.5 truncate font-mono text-[10px] text-[hsl(var(--deck-ink-faint))]">
                    {project.gitBranch && (
                      <>
                        <GitBranch className="h-2.5 w-2.5" />
                        <span>{project.gitBranch}</span>
                        <span>·</span>
                      </>
                    )}
                    <span className="truncate">{project.path}</span>
                    {!project.available && (
                      <span className="shrink-0 text-red-500">
                        · {t('projects.unavailable')}
                      </span>
                    )}
                  </span>
                </button>
                {!project.isCurrent && (
                  <button
                    type="button"
                    onClick={() =>
                      rejectHistorySurfaceAction(useSessionStore.getState())
                        ? undefined
                        : void unbindProject(project.path).catch(() => undefined)
                    }
                    title={t('projects.unbind.action')}
                    aria-label={t('projects.unbind.action')}
                    className="rounded p-1.5 text-[hsl(var(--deck-ink-faint))] opacity-0 transition group-hover:opacity-100 hover:bg-red-50 hover:text-red-600 focus-visible:opacity-100 dark:hover:bg-red-950/30"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}
