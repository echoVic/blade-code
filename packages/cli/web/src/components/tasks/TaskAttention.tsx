import type { SessionRef } from '@api/schemas';
import { useEffect, useMemo } from 'react';
import { useT } from '@/i18n';
import { projectPathOf } from '@/lib/projectIdentity';
import { useSessionStore } from '@/store/session';
import {
  findSessionByRef,
  sessionRefFromSession,
  sessionRefKey,
} from '@/store/session/sessionIdentity';
import { TASK_NOTIFICATION_OPEN_EVENT } from '@/store/session/taskAttention';

const BASE_TITLE = 'BladeCode';

export function TaskAttention() {
  const t = useT();
  const unreadTaskKeys = useSessionStore((state) => state.unreadTaskKeys);
  const sessions = useSessionStore((state) => state.sessions);
  const selectSession = useSessionStore((state) => state.selectSession);
  const selectProject = useSessionStore((state) => state.selectProject);
  const attentionCount = useMemo(() => {
    const keys = new Set(unreadTaskKeys);
    for (const session of sessions) {
      if (!session.pendingInteraction) continue;
      keys.add(sessionRefKey(sessionRefFromSession(session)));
    }
    return keys.size;
  }, [sessions, unreadTaskKeys]);

  useEffect(() => {
    document.title =
      attentionCount > 0 ? `(${attentionCount}) ${BASE_TITLE}` : BASE_TITLE;
    return () => {
      document.title = BASE_TITLE;
    };
  }, [attentionCount]);

  useEffect(() => {
    const openSession = (event: Event) => {
      const ref = (event as CustomEvent<SessionRef>).detail;
      if (!ref?.sessionId || !ref.projectPath) return;
      const state = useSessionStore.getState();
      const session = findSessionByRef(state.sessions, ref);
      const projectPath = session
        ? projectPathOf(
            session,
            state.selectedProjectPath ?? state.taskWorkspaceInfo?.cwd ?? null
          )
        : ref.projectPath;
      if (
        state.boundProjects.some(
          (project) => project.available && project.path === projectPath
        )
      ) {
        selectProject(projectPath);
      }
      void selectSession(ref);
    };
    window.addEventListener(TASK_NOTIFICATION_OPEN_EVENT, openSession);
    return () => window.removeEventListener(TASK_NOTIFICATION_OPEN_EVENT, openSession);
  }, [selectProject, selectSession]);

  return (
    <div className="sr-only" role="status" aria-live="polite">
      {attentionCount > 0
        ? t('attention.unreadAnnouncement', { count: attentionCount })
        : ''}
    </div>
  );
}
