import { reloadWorkspaceTrustConfiguration } from '../security/reloadWorkspaceTrust.js';
import { WorkspaceTrustService } from '../security/WorkspaceTrustService.js';
import {
  getUI,
  type SlashCommand,
  type SlashCommandResult,
  type SlashCommandUI,
} from './types.js';

function formatReview(
  status: Awaited<ReturnType<WorkspaceTrustService['getStatus']>>
): string {
  const lines = [
    '## Workspace Trust',
    '',
    `**状态**: ${status.state}`,
    `**项目**: \`${status.projectPath}\``,
    `**信任身份**: \`${status.trustRoot}\``,
    `**决策**: ${status.decision}`,
  ];
  if (status.inheritedFrom) {
    lines.push(`**继承自**: \`${status.inheritedFrom}\``);
  }
  if (status.error) {
    lines.push('', `**错误**: ${status.error}`);
  }
  if (status.sources.length > 0) {
    lines.push('', '### 待审阅项目来源');
    for (const source of status.sources) {
      lines.push('', `- \`${source.path}\` (${source.kind})`);
      if (source.warning) lines.push(`  ${source.warning}`);
      for (const effect of source.effects) {
        lines.push(
          `  - ${effect.kind}: ${effect.name}${
            effect.target ? ` → \`${effect.target}\`` : ''
          }`
        );
      }
    }
  } else {
    lines.push('', '当前项目没有自动执行型配置，不需要 Folder Trust。');
  }
  return lines.join('\n');
}

async function showStatus(
  projectDir: string,
  ui: SlashCommandUI
): Promise<SlashCommandResult> {
  const status = await WorkspaceTrustService.getInstance().getStatus(projectDir);
  ui.sendMessage(formatReview(status));
  return {
    success: true,
    message: `Workspace trust: ${status.state}`,
  };
}

const trustCommand: SlashCommand = {
  name: 'trust',
  description: 'Review and manage project folder trust',
  fullDescription: `审阅和管理当前项目的 Folder Trust。

  /trust          - 显示状态与自动执行型项目来源
  /trust review   - 显示完整审阅信息
  /trust approve  - 信任当前项目及其子目录
  /trust revoke   - 撤销当前项目信任`,
  usage: '/trust [review|approve|revoke]',
  category: 'system',
  examples: ['/trust', '/trust review', '/trust approve', '/trust revoke'],

  handler: async (args, context): Promise<SlashCommandResult> => {
    const action = args[0]?.toLowerCase() || 'status';
    const ui = getUI(context);
    const service = WorkspaceTrustService.getInstance();

    if (action === 'status' || action === 'review') {
      return showStatus(context.cwd, ui);
    }
    if (action === 'approve' || action === 'trust') {
      const status = await service.trust(context.cwd);
      await reloadWorkspaceTrustConfiguration();
      ui.sendMessage(
        `${formatReview(status)}\n\n` +
          '项目已信任。请重新启动当前 Blade 进程，使项目模型、MCP、权限和插件层完整生效。'
      );
      return {
        success: true,
        message: 'Workspace trusted; restart required',
      };
    }
    if (action === 'revoke' || action === 'untrust') {
      const status = await service.revoke(context.cwd);
      await reloadWorkspaceTrustConfiguration();
      ui.sendMessage(
        `${formatReview(status)}\n\n` +
          '项目信任已撤销。请重新启动当前 Blade 进程，回收已加载的项目资源。'
      );
      return {
        success: true,
        message: 'Workspace trust revoked; restart required',
      };
    }

    ui.sendMessage(`未知子命令: ${action}\n使用 /trust review|approve|revoke`);
    return { success: false, error: `Unknown subcommand: ${action}` };
  },
};

export default trustCommand;
