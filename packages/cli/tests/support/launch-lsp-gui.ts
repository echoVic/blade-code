import { mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { launchRealApiGuiFixture } from './launchRealApiGuiFixture.js';

await launchRealApiGuiFixture({
  scriptName: 'launch-lsp-gui.ts',
  defaultPort: 4320,
  configure: () => ({ config: {} }),
  setup: async ({ root, workspace }) => {
    const trace = path.join(root, 'lsp-trace.jsonl');
    const pidFile = path.join(root, 'lsp.pid');
    await mkdir(path.join(workspace, '.blade'), { recursive: true });
    await Promise.all([
      writeFile(
        path.join(workspace, '.blade', 'config.json'),
        `${JSON.stringify(
          {
            lspServers: {
              qualification: {
                command: process.execPath,
                args: [path.resolve(import.meta.dirname, 'fake-lsp-server.mjs')],
                extensionToLanguage: { '.ts': 'typescript' },
                env: { LSP_TRACE_FILE: trace, LSP_PID_FILE: pidFile },
                diagnosticWaitTimeout: 2_000,
              },
            },
          },
          null,
          2
        )}\n`
      ),
      writeFile(path.join(workspace, 'source.ts'), 'export const value = "ready";\n'),
    ]);
  },
  afterCommit: async ({ root, canonicalWorkspace }) => ({
    source: await realpath(path.join(canonicalWorkspace, 'source.ts')),
    diagnosticTarget: path.join(canonicalWorkspace, 'diagnostic.ts'),
    trace: path.join(root, 'lsp-trace.jsonl'),
    pidFile: path.join(root, 'lsp.pid'),
  }),
});
