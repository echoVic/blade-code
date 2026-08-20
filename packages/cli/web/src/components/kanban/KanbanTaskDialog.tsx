import type { SessionTaskKind, SessionTaskPriority } from '@api/schemas';
import { CalendarClock, FolderGit2, Loader2, Tag } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useT } from '@/i18n';
import type { BoundProject, Session, TaskUpdateInput } from '@/services';

interface CreateTaskValues {
  title?: string;
  prompt: string;
  projectPath: string;
  taskPriority: SessionTaskPriority;
  taskKind: SessionTaskKind;
  taskDueAt?: string;
}

interface KanbanTaskDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projects: BoundProject[];
  defaultProjectPath: string | null;
  session?: Session | null;
  submitting: boolean;
  canCreate: boolean;
  onCreate: (values: CreateTaskValues) => Promise<void>;
  onUpdate: (values: TaskUpdateInput) => Promise<void>;
}

function toLocalDateTime(value: string | undefined): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

export function KanbanTaskDialog({
  open,
  onOpenChange,
  projects,
  defaultProjectPath,
  session,
  submitting,
  canCreate,
  onCreate,
  onUpdate,
}: KanbanTaskDialogProps) {
  const t = useT();
  const editing = Boolean(session);
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [projectPath, setProjectPath] = useState(defaultProjectPath ?? '');
  const [priority, setPriority] = useState<SessionTaskPriority>('medium');
  const [kind, setKind] = useState<SessionTaskKind>('feature');
  const [dueAt, setDueAt] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setTitle(session?.title ?? '');
    setPrompt(session?.taskPromptSummary ?? '');
    setProjectPath(
      session?.taskSourceProjectPath ??
        session?.projectPath ??
        defaultProjectPath ??
        projects.find((project) => project.available)?.path ??
        ''
    );
    setPriority(session?.taskPriority ?? 'medium');
    setKind(session?.taskKind ?? 'feature');
    setDueAt(toLocalDateTime(session?.taskDueAt));
    setError(null);
  }, [defaultProjectPath, open, projects, session]);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmedTitle = title.trim();
    const trimmedPrompt = prompt.trim();
    if (!editing && (!trimmedPrompt || !projectPath)) return;
    setError(null);
    try {
      if (editing) {
        await onUpdate({
          ...(trimmedTitle ? { title: trimmedTitle } : {}),
          taskPriority: priority,
          taskKind: kind,
          taskDueAt: dueAt ? new Date(dueAt).toISOString() : null,
        });
      } else {
        await onCreate({
          ...(trimmedTitle ? { title: trimmedTitle } : {}),
          prompt: trimmedPrompt,
          projectPath,
          taskPriority: priority,
          taskKind: kind,
          ...(dueAt ? { taskDueAt: new Date(dueAt).toISOString() } : {}),
        });
      }
      onOpenChange(false);
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : t('kanban.dialog.submitFailed')
      );
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[560px] gap-0 overflow-hidden border-[hsl(var(--deck-border))] bg-[hsl(var(--deck-surface))] p-0">
        <DialogHeader className="border-b border-[hsl(var(--deck-hairline))] px-5 py-4">
          <DialogTitle className="font-mono text-[15px] text-[hsl(var(--deck-ink))]">
            {t(editing ? 'kanban.dialog.editTitle' : 'kanban.dialog.createTitle')}
          </DialogTitle>
          <DialogDescription className="text-[11.5px] text-[hsl(var(--deck-ink-faint))]">
            {t(
              editing
                ? 'kanban.dialog.editDescription'
                : 'kanban.dialog.createDescription'
            )}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit}>
          <div className="grid gap-4 px-5 py-5">
            <label className="grid gap-1.5">
              <span className="font-mono text-[10px] uppercase text-[hsl(var(--deck-ink-muted))]">
                {t('kanban.field.title')}
              </span>
              <input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                maxLength={200}
                className="field"
                placeholder={t('kanban.field.titlePlaceholder')}
              />
            </label>

            {!editing && (
              <label className="grid gap-1.5">
                <span className="font-mono text-[10px] uppercase text-[hsl(var(--deck-ink-muted))]">
                  {t('kanban.field.prompt')}
                </span>
                <textarea
                  required
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  maxLength={32_000}
                  rows={6}
                  className="min-h-32 w-full resize-y rounded-md border border-[hsl(var(--deck-border))] bg-[hsl(var(--deck-canvas))] px-3 py-2.5 text-[13px] leading-5 text-[hsl(var(--deck-ink))] outline-none placeholder:text-[hsl(var(--deck-ink-faint))] focus:border-[hsl(var(--deck-accent)/0.6)] focus:ring-1 focus:ring-[hsl(var(--deck-accent)/0.35)]"
                  placeholder={t('kanban.field.promptPlaceholder')}
                />
              </label>
            )}

            {!editing && (
              <label className="grid gap-1.5">
                <span className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase text-[hsl(var(--deck-ink-muted))]">
                  <FolderGit2 className="h-3 w-3" />
                  {t('kanban.field.project')}
                </span>
                <select
                  required
                  value={projectPath}
                  onChange={(event) => setProjectPath(event.target.value)}
                  className="field"
                >
                  {projects
                    .filter((project) => project.available)
                    .map((project) => (
                      <option key={project.path} value={project.path}>
                        {project.name}
                      </option>
                    ))}
                </select>
              </label>
            )}

            <div className="grid gap-3 sm:grid-cols-3">
              <label className="grid gap-1.5">
                <span className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase text-[hsl(var(--deck-ink-muted))]">
                  <Tag className="h-3 w-3" />
                  {t('kanban.field.kind')}
                </span>
                <select
                  value={kind}
                  onChange={(event) => setKind(event.target.value as SessionTaskKind)}
                  className="field"
                >
                  <option value="feature">{t('kanban.kind.feature')}</option>
                  <option value="bug">{t('kanban.kind.bug')}</option>
                  <option value="maintenance">{t('kanban.kind.maintenance')}</option>
                  <option value="research">{t('kanban.kind.research')}</option>
                </select>
              </label>
              <label className="grid gap-1.5">
                <span className="font-mono text-[10px] uppercase text-[hsl(var(--deck-ink-muted))]">
                  {t('kanban.field.priority')}
                </span>
                <select
                  value={priority}
                  onChange={(event) =>
                    setPriority(event.target.value as SessionTaskPriority)
                  }
                  className="field"
                >
                  <option value="high">{t('kanban.priority.high')}</option>
                  <option value="medium">{t('kanban.priority.medium')}</option>
                  <option value="low">{t('kanban.priority.low')}</option>
                </select>
              </label>
              <label className="grid gap-1.5">
                <span className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase text-[hsl(var(--deck-ink-muted))]">
                  <CalendarClock className="h-3 w-3" />
                  {t('kanban.field.dueAt')}
                </span>
                <input
                  type="datetime-local"
                  value={dueAt}
                  onChange={(event) => setDueAt(event.target.value)}
                  className="field min-w-0"
                />
              </label>
            </div>

            {!editing && (
              <div className="flex items-center gap-2 rounded-md border border-[hsl(var(--deck-border))] bg-[hsl(var(--deck-surface-2))] px-3 py-2 font-mono text-[10px] text-[hsl(var(--deck-ink-muted))]">
                <span className="h-1.5 w-1.5 rounded-full bg-[hsl(var(--deck-accent))]" />
                {t('kanban.dialog.localExecution')}
              </div>
            )}

            {error && (
              <div
                role="alert"
                className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[11px] text-red-700 dark:border-red-900/70 dark:bg-red-950/35 dark:text-red-300"
              >
                {error}
              </div>
            )}
          </div>

          <DialogFooter className="border-t border-[hsl(var(--deck-hairline))] bg-[hsl(var(--deck-surface-2))]/60 px-5 py-3">
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              {t('kanban.dialog.cancel')}
            </Button>
            <Button
              type="submit"
              disabled={
                submitting ||
                (!editing && (!canCreate || !prompt.trim() || !projectPath))
              }
              className="gap-2"
            >
              {submitting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {t(editing ? 'kanban.dialog.save' : 'kanban.dialog.dispatch')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export type { CreateTaskValues };
