import type { Locale } from './index';

const en = {
  title: 'Agent team',
  members: 'members',
  tasks: 'tasks',
  noTasks: 'No tasks',
  expand: 'Expand team',
  collapse: 'Collapse team',
  delete: 'Delete team',
  worktree: 'Isolated worktree',
  recipient: 'Message recipient',
  broadcast: 'Everyone',
  messagePlaceholder: 'Message teammate...',
  send: 'Send team message',
  actionFailed: 'Team action failed',
  settingsTitle: 'Agent Teams',
  settingsHint: 'Enable shared task graphs, teammate worktrees, and peer messaging',
} as const;

type TeamTranslationKey = keyof typeof en;

const translations: Record<Locale, Record<TeamTranslationKey, string>> = {
  en,
  zh: {
    title: '智能体团队',
    members: '成员',
    tasks: '任务',
    noTasks: '暂无任务',
    expand: '展开团队',
    collapse: '收起团队',
    delete: '删除团队',
    worktree: '隔离工作树',
    recipient: '消息收件人',
    broadcast: '所有成员',
    messagePlaceholder: '发送团队消息…',
    send: '发送团队消息',
    actionFailed: '团队操作失败',
    settingsTitle: 'Agent Teams',
    settingsHint: '启用共享任务图、成员 worktree 与点对点消息',
  },
};

export function teamText(locale: Locale, key: TeamTranslationKey): string {
  return translations[locale][key];
}
