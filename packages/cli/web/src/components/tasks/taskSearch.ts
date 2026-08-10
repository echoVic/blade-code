import { t } from '@/i18n';
import { projectNameOf, projectPathOf } from '@/lib/projectIdentity';
import { sessionDisplayTitle } from '@/lib/sessionDisplayTitle';
import { compareTaskAttentionThenActivity } from '@/lib/taskOrdering';
import type { Session } from '@/services';
import { sessionRefFromSession, sessionRefKey } from '@/store/session/sessionIdentity';

const STATUS_TERMS: Record<Session['taskStatus'], string> = {
  running: 'running active 进行中 运行中',
  queued: 'queued waiting 排队中 等待中',
  interrupted: 'interrupted paused 已暂停 已中断',
  failed: 'failed error 已失败 错误',
  cancelled: 'cancelled canceled 已取消',
  completed: 'completed done finished 已完成 完成',
};

export function sessionSearchTitle(session: Session): string {
  return sessionDisplayTitle(session, t);
}

export function sessionActivityLabel(session: Session): string {
  const raw = session.lastMessageTime || session.firstMessageTime;
  if (!raw) return '';
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function normalize(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().trim();
}

function searchableText(session: Session, activePath: string | null): string {
  const projectPath = projectPathOf(session, activePath);
  return normalize(
    [
      sessionSearchTitle(session),
      projectNameOf(projectPath),
      projectPath,
      session.projectPath,
      session.gitBranch,
      session.taskWorktreeBranch,
      session.taskStatus,
      STATUS_TERMS[session.taskStatus],
      session.pendingInteraction?.type === 'question'
        ? 'needs answer question attention 等待回答 需要回答'
        : session.pendingInteraction?.type === 'elicitation'
          ? 'mcp input elicitation attention MCP 输入 等待输入'
          : session.pendingInteraction
            ? 'needs approval permission attention 等待审批 需要授权'
            : '',
      session.sessionId,
    ]
      .filter(Boolean)
      .join(' ')
  );
}

function relevance(session: Session, query: string, activePath: string | null): number {
  if (!query) return 0;
  const title = normalize(sessionSearchTitle(session));
  const project = normalize(projectNameOf(projectPathOf(session, activePath)));
  if (title === query) return 500;
  if (title.startsWith(query)) return 400;
  if (title.includes(query)) return 300;
  if (project === query) return 250;
  if (project.startsWith(query)) return 200;
  return 100;
}

export function searchSessions(
  sessions: Session[],
  rawQuery: string,
  activePath: string | null,
  limit = 50
): Session[] {
  const query = normalize(rawQuery);
  const terms = query.split(/\s+/).filter(Boolean);
  const seen = new Set<string>();

  return sessions
    .filter((session) => {
      if (terms.length === 0) return true;
      const text = searchableText(session, activePath);
      return terms.every((term) => text.includes(term));
    })
    .sort((left, right) => {
      const attentionRank =
        Number(Boolean(right.pendingInteraction)) -
        Number(Boolean(left.pendingInteraction));
      if (attentionRank !== 0) return attentionRank;
      const rank =
        relevance(right, query, activePath) - relevance(left, query, activePath);
      return rank || compareTaskAttentionThenActivity(left, right);
    })
    .filter((session) => {
      const key = sessionRefKey(sessionRefFromSession(session));
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit);
}
