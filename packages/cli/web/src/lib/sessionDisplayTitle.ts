import type { TranslationKey } from '@/i18n';
import type { Session } from '@/services';

type SessionTitleTranslator = (
  key: TranslationKey,
  params?: Record<string, string | number>
) => string;

export function sessionDisplayTitle(
  session: Session,
  t: SessionTitleTranslator
): string {
  const title = session.title?.trim();
  if (title) return title;

  const raw = session.firstMessageTime || session.lastMessageTime;
  if (raw) {
    const date = new Date(raw);
    if (!Number.isNaN(date.getTime())) {
      return t('recent.session.fallbackDated', {
        y: String(date.getFullYear()).slice(-2),
        m: String(date.getMonth() + 1).padStart(2, '0'),
        d: String(date.getDate()).padStart(2, '0'),
        hh: String(date.getHours()).padStart(2, '0'),
        mm: String(date.getMinutes()).padStart(2, '0'),
      });
    }
  }

  return t('recent.session.fallbackShort', {
    id: session.sessionId.slice(0, 6),
  });
}
