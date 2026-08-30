import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

function parse(relativePath: string): ts.SourceFile {
  const text = source(relativePath);
  return ts.createSourceFile(relativePath, text, ts.ScriptTarget.Latest, true);
}

function findNode<T extends ts.Node>(
  root: ts.Node,
  predicate: (node: ts.Node) => node is T
): T | undefined {
  let match: T | undefined;
  const visit = (node: ts.Node): void => {
    if (match) return;
    if (predicate(node)) {
      match = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return match;
}

describe('history-free Web Session projection source boundary', () => {
  it('stores an authoritative count instead of a transcript array', () => {
    const sessionRoutes = parse('../../src/server/routes/session.ts');
    const sessionInfo = findNode(
      sessionRoutes,
      (node): node is ts.InterfaceDeclaration =>
        ts.isInterfaceDeclaration(node) && node.name.text === 'SessionInfo'
    );
    if (!sessionInfo) throw new Error('Expected SessionInfo interface');
    const members = sessionInfo.members.map((member) => member.getText(sessionRoutes));

    expect(members).toContain('messageCount: number;');
    expect(members).not.toContain('messages: Message[];');
  });

  it('hydrates a live projection without loading durable history', () => {
    const sessionRoutes = parse('../../src/server/routes/session.ts');
    const hydration = findNode(
      sessionRoutes,
      (node): node is ts.VariableDeclaration =>
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === 'acquireOrHydrateSession'
    );
    if (!hydration) throw new Error('Expected acquireOrHydrateSession declaration');
    const hydrationSource = hydration.getText(sessionRoutes);

    expect(hydrationSource).toContain('SessionService.findSessionMetadata(');
    expect(hydrationSource).toContain('SessionService.findSessionTaskWorktree(');
    expect(hydrationSource).not.toContain('SessionService.loadSession(');
  });

  it('keeps Session projection residency controller-local instead of in a module-global session map', () => {
    const sessionRoutes = source('../../src/server/routes/session.ts');

    expect(sessionRoutes).not.toContain(
      'const sessions = new Map<string, SessionInfo>();'
    );
    expect(sessionRoutes).toContain(
      'const sessionProjectionResidency = new SessionProjectionResidency<'
    );
    expect(sessionRoutes).toContain('SessionInfo,');
    expect(sessionRoutes).toContain('SessionInfo');
    expect(sessionRoutes).toContain('toSnapshot: cloneSessionInfo');
  });

  it('exposes projection residency stats through the controller surface', () => {
    const sessionRoutes = parse('../../src/server/routes/session.ts');
    const controller = findNode(
      sessionRoutes,
      (node): node is ts.InterfaceDeclaration =>
        ts.isInterfaceDeclaration(node) && node.name.text === 'SessionRouteController'
    );
    if (!controller) throw new Error('Expected SessionRouteController interface');
    const members = controller.members.map((member) => member.getText(sessionRoutes));

    expect(members).toContain(
      `getProjectionResidencyStats(): {
    resident: number;
    closing: number;
    reserved: number;
    pinned: number;
    retained: number;
    maxResident: number;
    idleMs: number;
  };`
    );
  });
});
