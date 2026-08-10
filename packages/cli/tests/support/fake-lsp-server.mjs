import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from 'vscode-jsonrpc/node.js';

const traceFile = process.env.LSP_TRACE_FILE;
const pidFile = process.env.LSP_PID_FILE;
const files = new Map();

function trace(event, properties = {}) {
  if (!traceFile) return;
  appendFileSync(
    traceFile,
    `${JSON.stringify({
      event,
      pid: process.pid,
      cwd: process.cwd(),
      sessionId: process.env.BLADE_SESSION_ID,
      sessionMarker: process.env.LSP_SESSION_MARKER,
      ...properties,
    })}\n`
  );
}

if (pidFile) writeFileSync(pidFile, String(process.pid));

const connection = createMessageConnection(
  new StreamMessageReader(process.stdin),
  new StreamMessageWriter(process.stdout)
);

connection.onRequest('initialize', (params) => {
  trace('initialize', {
    rootUri: params.rootUri,
    workspaceFolders: params.workspaceFolders,
  });
  return {
    capabilities: {
      textDocumentSync: 1,
      definitionProvider: true,
      referencesProvider: true,
      hoverProvider: true,
      documentSymbolProvider: true,
      workspaceSymbolProvider: true,
      implementationProvider: true,
      callHierarchyProvider: true,
    },
  };
});

connection.onNotification('initialized', () => trace('initialized'));
connection.onNotification('workspace/didChangeConfiguration', (params) =>
  trace('configuration', { settings: params.settings })
);
connection.onNotification('textDocument/didOpen', (params) => {
  files.set(params.textDocument.uri, params.textDocument.text);
  trace('didOpen', {
    uri: params.textDocument.uri,
    version: params.textDocument.version,
  });
});
connection.onNotification('textDocument/didChange', (params) => {
  files.set(params.textDocument.uri, params.contentChanges.at(-1)?.text ?? '');
  trace('didChange', {
    uri: params.textDocument.uri,
    version: params.textDocument.version,
  });
});
connection.onNotification('textDocument/didSave', (params) => {
  const uri = params.textDocument.uri;
  const content = params.text ?? files.get(uri) ?? '';
  files.set(uri, content);
  trace('didSave', { uri });
  const diagnostics = content.includes('missingSymbol')
    ? [
        {
          range: {
            start: { line: 0, character: 13 },
            end: { line: 0, character: 26 },
          },
          severity: 1,
          code: 'FAKE1001',
          source: 'blade-fake-lsp',
          message: 'Cannot find name missingSymbol',
        },
      ]
    : [];
  connection.sendNotification('textDocument/publishDiagnostics', {
    uri,
    diagnostics,
  });
});
connection.onNotification('textDocument/didClose', (params) => {
  files.delete(params.textDocument.uri);
  trace('didClose', { uri: params.textDocument.uri });
});

function location(uri, line = 0, character = 0) {
  return {
    uri,
    range: {
      start: { line, character },
      end: { line, character: character + 5 },
    },
  };
}

connection.onRequest('textDocument/definition', (params) => [
  location(params.textDocument.uri, 1, 2),
]);
connection.onRequest('textDocument/implementation', (params) => [
  location(params.textDocument.uri, 2, 3),
]);
connection.onRequest('textDocument/references', (params) => [
  location(params.textDocument.uri, 0, 6),
  location(params.textDocument.uri, 3, 4),
]);
connection.onRequest('textDocument/hover', async () => {
  const crashFile = process.env.LSP_CRASH_ONCE_FILE;
  if (crashFile && !existsSync(crashFile)) {
    writeFileSync(crashFile, 'crashed');
    const childPidFile = process.env.LSP_CRASH_CHILD_PID_FILE;
    if (childPidFile) {
      const child = spawn(
        process.execPath,
        ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000);'],
        { stdio: 'ignore' }
      );
      if (child.pid) writeFileSync(childPidFile, String(child.pid));
      child.unref();
    }
    trace('crash');
    setImmediate(() => process.exit(9));
    await new Promise(() => {
      // The process exits before this request resolves.
    });
  }
  const delay = Number(process.env.LSP_HOVER_DELAY_MS || 0);
  if (delay > 0) {
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  return {
    contents: { kind: 'markdown', value: '**FakeType**: string' },
  };
});
connection.onRequest('textDocument/documentSymbol', (params) => [
  {
    name: 'fakeFunction',
    kind: 12,
    range: location(params.textDocument.uri, 0, 0).range,
    selectionRange: location(params.textDocument.uri, 0, 0).range,
  },
]);
connection.onRequest('workspace/symbol', (params) => [
  {
    name: `workspace:${params.query}`,
    kind: 12,
    location: location([...files.keys()][0] ?? 'file:///unknown.ts', 0, 0),
  },
]);
connection.onRequest('textDocument/prepareCallHierarchy', (params) => [
  {
    name: 'fakeFunction',
    kind: 12,
    uri: params.textDocument.uri,
    range: location(params.textDocument.uri, 0, 0).range,
    selectionRange: location(params.textDocument.uri, 0, 0).range,
  },
]);
connection.onRequest('callHierarchy/incomingCalls', (params) => [
  { from: { ...params.item, name: 'caller' }, fromRanges: [params.item.range] },
]);
connection.onRequest('callHierarchy/outgoingCalls', (params) => [
  { to: { ...params.item, name: 'callee' }, fromRanges: [params.item.range] },
]);
connection.onRequest('shutdown', () => {
  trace('shutdown');
  return null;
});
connection.onNotification('exit', () => {
  trace('exit');
  connection.dispose();
  process.exit(0);
});

connection.listen();
