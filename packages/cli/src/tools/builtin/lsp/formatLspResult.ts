import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  CallHierarchyIncomingCall,
  CallHierarchyItem,
  CallHierarchyOutgoingCall,
  Diagnostic,
  DocumentSymbol,
  Hover,
  Location,
  LocationLink,
  MarkedString,
  MarkupContent,
  SymbolInformation,
} from 'vscode-languageserver-types';
import type {
  DiagnosticPublication,
  LspQuery,
} from '../../../lsp/LspSessionManager.js';

function displayPath(uri: string, workspaceRoot: string): string {
  let filePath = uri;
  try {
    if (uri.startsWith('file:')) filePath = fileURLToPath(uri);
  } catch {
    // Keep the server-provided URI for diagnostics.
  }
  const relative = path.relative(workspaceRoot, filePath);
  return relative && !relative.startsWith('..') ? relative : filePath;
}

function locationLine(location: Location, workspaceRoot: string): string {
  return `${displayPath(location.uri, workspaceRoot)}:${
    location.range.start.line + 1
  }:${location.range.start.character + 1}`;
}

function asLocation(value: Location | LocationLink): Location {
  return 'targetUri' in value
    ? {
        uri: value.targetUri,
        range: value.targetSelectionRange ?? value.targetRange,
      }
    : value;
}

function locations(
  value: Location | LocationLink | Array<Location | LocationLink> | null,
  workspaceRoot: string,
  empty: string
): string {
  if (!value) return empty;
  const items = (Array.isArray(value) ? value : [value])
    .filter((item): item is Location | LocationLink =>
      Boolean(item && ('uri' in item || 'targetUri' in item))
    )
    .map(asLocation);
  if (items.length === 0) return empty;
  return items.map((item) => locationLine(item, workspaceRoot)).join('\n');
}

function markupText(value: MarkupContent | MarkedString | MarkedString[]): string {
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === 'string' ? item : item.value))
      .join('\n\n');
  }
  return typeof value === 'string' ? value : value.value;
}

function symbolLines(symbol: DocumentSymbol, depth = 0): string[] {
  const line = `${'  '.repeat(depth)}${symbol.name} (${symbol.kind}) - Line ${
    symbol.range.start.line + 1
  }${symbol.detail ? ` ${symbol.detail}` : ''}`;
  return [
    line,
    ...(symbol.children ?? []).flatMap((child) => symbolLines(child, depth + 1)),
  ];
}

function formatDiagnostics(
  publication: DiagnosticPublication | null,
  workspaceRoot: string
): string {
  if (!publication || publication.diagnostics.length === 0) {
    return 'No diagnostics reported for this file.';
  }
  const file = path.relative(workspaceRoot, publication.filePath);
  return [
    `${file} (${publication.serverName}):`,
    ...publication.diagnostics.slice(0, 30).map((diagnostic: Diagnostic) => {
      const severity = ['Error', 'Warning', 'Info', 'Hint'][
        (diagnostic.severity ?? 1) - 1
      ];
      return `  ${severity ?? 'Error'} ${diagnostic.range.start.line + 1}:${
        diagnostic.range.start.character + 1
      } ${diagnostic.message.replace(/\s+/g, ' ').slice(0, 500)}`;
    }),
  ].join('\n');
}

export function formatLspResult(
  operation: LspQuery['operation'],
  result: unknown,
  workspaceRoot: string
): string {
  switch (operation) {
    case 'goToDefinition':
    case 'goToImplementation':
      return locations(
        result as Location | LocationLink | Array<Location | LocationLink> | null,
        workspaceRoot,
        'No matching location found.'
      );
    case 'findReferences':
      return locations(
        result as Location[] | null,
        workspaceRoot,
        'No references found.'
      );
    case 'hover': {
      const hover = result as Hover | null;
      return hover ? markupText(hover.contents) : 'No hover information found.';
    }
    case 'documentSymbol': {
      const symbols = (result ?? []) as Array<DocumentSymbol | SymbolInformation>;
      if (symbols.length === 0) return 'No document symbols found.';
      return symbols
        .flatMap((symbol) =>
          'range' in symbol
            ? symbolLines(symbol)
            : [
                `${symbol.name} (${symbol.kind}) - ${locationLine(
                  symbol.location,
                  workspaceRoot
                )}`,
              ]
        )
        .join('\n');
    }
    case 'workspaceSymbol': {
      const symbols = (result ?? []) as SymbolInformation[];
      return symbols.length === 0
        ? 'No workspace symbols found.'
        : symbols
            .slice(0, 100)
            .map(
              (symbol) =>
                `${symbol.name} (${symbol.kind}) - ${locationLine(
                  symbol.location,
                  workspaceRoot
                )}`
            )
            .join('\n');
    }
    case 'prepareCallHierarchy': {
      const items = (result ?? []) as CallHierarchyItem[];
      return items.length === 0
        ? 'No call hierarchy item found.'
        : items
            .map(
              (item) =>
                `${item.name} - ${displayPath(item.uri, workspaceRoot)}:${
                  item.range.start.line + 1
                }`
            )
            .join('\n');
    }
    case 'incomingCalls': {
      const calls = (result ?? []) as CallHierarchyIncomingCall[];
      return calls.length === 0
        ? 'No incoming calls found.'
        : calls
            .map(
              (call) =>
                `${call.from.name} - ${displayPath(
                  call.from.uri,
                  workspaceRoot
                )}:${call.from.range.start.line + 1}`
            )
            .join('\n');
    }
    case 'outgoingCalls': {
      const calls = (result ?? []) as CallHierarchyOutgoingCall[];
      return calls.length === 0
        ? 'No outgoing calls found.'
        : calls
            .map(
              (call) =>
                `${call.to.name} - ${displayPath(call.to.uri, workspaceRoot)}:${
                  call.to.range.start.line + 1
                }`
            )
            .join('\n');
    }
    case 'diagnostics':
      return formatDiagnostics(result as DiagnosticPublication | null, workspaceRoot);
  }
}
