import { writeSessionMarkdownExport } from '../services/SessionExportWriter.js';
import { MAX_ACP_INLINE_SESSION_EXPORT_BYTES } from '../services/SessionMarkdownExporter.js';
import { SessionService } from '../services/SessionService.js';
import type { SlashCommand, SlashCommandResult } from './types.js';

function parseArguments(args: string[]): {
  includeReasoning: boolean;
  outputPath?: string;
} {
  let includeReasoning = false;
  const paths: string[] = [];
  for (const argument of args) {
    if (argument === '--reasoning') {
      includeReasoning = true;
      continue;
    }
    if (argument.startsWith('--')) {
      throw new Error(`Unknown export option: ${argument}`);
    }
    paths.push(argument);
  }
  if (paths.length > 1) {
    throw new Error('Usage: /export [path] [--reasoning]');
  }
  return {
    includeReasoning,
    ...(paths[0] ? { outputPath: paths[0] } : {}),
  };
}

const exportCommand: SlashCommand = {
  name: 'export',
  description: 'Export the current durable conversation as safe Markdown',
  fullDescription:
    '将当前完整 durable history 导出为 Markdown。工具活动经过凭证、二进制、宿主路径和体积清理；reasoning 仅在显式 --reasoning 时包含。',
  usage: '/export [path] [--reasoning]',
  category: 'Session',
  examples: ['/export', '/export reports/conversation.md', '/export --reasoning'],
  async handler(args, context): Promise<SlashCommandResult> {
    if (!context.sessionId) {
      return { success: false, error: 'No active session to export' };
    }
    const workspaceRoot = context.workspaceRoot ?? context.cwd;
    try {
      const { includeReasoning, outputPath } = parseArguments(args);
      const exported = await SessionService.exportSessionMarkdown(
        context.sessionId,
        workspaceRoot,
        { includeReasoning }
      );

      if (context.surface === 'acp') {
        if (outputPath) {
          return {
            success: false,
            error:
              'ACP export does not write host paths; omit the path to receive Markdown',
          };
        }
        if (
          Buffer.byteLength(exported.markdown, 'utf8') >
          MAX_ACP_INLINE_SESSION_EXPORT_BYTES
        ) {
          return {
            success: false,
            error:
              'Session export exceeds the ACP inline limit; use the Web export endpoint',
          };
        }
        return {
          success: true,
          message: 'Session export ready',
          content: exported.markdown,
          data: {
            action: 'session_exported',
            filename: exported.filename,
            contentSha256: exported.contentSha256,
            contentBytes: exported.contentBytes,
          },
        };
      }

      const filePath = await writeSessionMarkdownExport(
        workspaceRoot,
        exported,
        outputPath
      );
      return {
        success: true,
        message:
          `Saved conversation to ${filePath}\n` + `SHA-256 ${exported.contentSha256}`,
        data: {
          action: 'session_exported',
          filePath,
          filename: exported.filename,
          contentSha256: exported.contentSha256,
          contentBytes: exported.contentBytes,
          redactionCount: exported.redactionCount,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Session export failed',
      };
    }
  },
};

export default exportCommand;
