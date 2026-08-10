import type { SessionRef } from '@api/schemas';
import { type SessionMarkdownDownload, sessionService } from '@/services';

export async function downloadSessionMarkdown(
  ref: SessionRef,
  includeReasoning = false
): Promise<SessionMarkdownDownload> {
  const exported = await sessionService.exportSessionMarkdown(ref, includeReasoning);
  const blob = new Blob([exported.markdown], {
    type: 'text/markdown;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = exported.filename;
  anchor.hidden = true;
  document.body.appendChild(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    await new Promise<void>((resolve) => {
      window.setTimeout(() => {
        URL.revokeObjectURL(url);
        resolve();
      }, 0);
    });
  }
  return exported;
}
