import { describe, expect, it } from 'vitest';
import {
  SessionLocatorV2Schema,
  SessionSurfaceCapabilitiesSchema,
  SessionSurfaceCatalogPageSchema,
  SessionSurfaceErrorCodeSchema,
  SessionSurfaceErrorEnvelopeSchema,
  SessionSurfaceForkRequestSchema,
  type SessionSurfaceForkResult,
  SessionSurfaceHistoryPageSchema,
  SessionSurfaceHistoryRequestSchema,
  type SessionSurfaceHistoryResult,
  SessionSurfaceMessageSchema,
  SessionSurfaceOpenRequestSchema,
  SessionSurfaceOpenResultSchema,
  SessionSurfaceSummarySchema,
  SurfaceUnavailableReasonSchema,
} from '../../../../src/api/sessionSurfaceSchemas.js';

describe('session surface schemas', () => {
  const remoteLocator = {
    version: 2,
    sessionId: 'session-remote',
    workspace: {
      kind: 'acp-remote',
      workspaceRef: `acp-remote-workspace:${'Z'.repeat(43)}`,
    },
  } as const;

  const summaryFixture = {
    locator: remoteLocator,
    displayCwd: '/workspace/remote',
    rootId: 'root-1',
    taskStatus: 'running',
    messageCount: 12,
    firstMessageTime: '2026-09-02T00:00:00.000Z',
    lastMessageTime: '2026-09-02T01:00:00.000Z',
    hasErrors: false,
    capabilities: {
      connection: 'offline',
      history: {
        read: true,
        fork: false,
      },
      turn: {
        start: false,
        reason: 'owner-offline',
      },
      files: {
        readText: false,
        writeText: false,
        browse: 'none',
        reason: 'owner-offline',
      },
      terminal: {
        mode: 'none',
        owner: 'none',
        reason: 'owner-offline',
      },
    },
  } as const;

  const historyResultFixture: SessionSurfaceHistoryResult = {
    messages: [
      {
        id: 'surface-message:1:abc',
        role: 'user',
        content: 'hello',
        timestamp: '2026-09-02T00:00:00.000Z',
      },
    ],
    olderCursor: 'cursor-2',
    snapshot: 'snapshot-1',
    truncated: false,
  };

  const forkResultFixture: SessionSurfaceForkResult = {
    session: summaryFixture,
    history: historyResultFixture,
  };

  describe('SessionLocatorV2Schema', () => {
    it('accepts strict local and remote locators with nested workspaces', () => {
      expect(
        SessionLocatorV2Schema.parse({
          version: 2,
          sessionId: 'session-local',
          workspace: {
            kind: 'local',
            projectPath: '/workspace/project',
          },
        })
      ).toMatchObject({
        version: 2,
        sessionId: 'session-local',
      });

      expect(
        SessionLocatorV2Schema.parse({
          version: 2,
          sessionId: 'session-remote',
          workspace: {
            kind: 'acp-remote',
            workspaceRef: `acp-remote-workspace:${'A'.repeat(43)}`,
          },
        })
      ).toMatchObject({
        version: 2,
        sessionId: 'session-remote',
      });
    });

    it('rejects forbidden remote fields, extra properties, and invalid refs', () => {
      const remoteLocator = {
        version: 2,
        sessionId: 'session-remote',
        workspace: {
          kind: 'acp-remote',
          workspaceRef: `acp-remote-workspace:${'B'.repeat(43)}`,
        },
      } as const;

      expect(() =>
        SessionLocatorV2Schema.parse({
          ...remoteLocator,
          projectPath: '/private/state',
        })
      ).toThrow();

      expect(() =>
        SessionLocatorV2Schema.parse({
          ...remoteLocator,
          workspace: {
            ...remoteLocator.workspace,
            wirePath: 'C:/private/repo',
          },
        })
      ).toThrow();

      expect(() =>
        SessionLocatorV2Schema.parse({
          version: 2,
          sessionId: 'session-remote',
          workspace: {
            kind: 'acp-remote',
            workspaceRef: 'acp-remote-workspace:not-long-enough',
          },
        })
      ).toThrow();
    });
  });

  describe('SessionSurfaceMessageSchema', () => {
    it('accepts a strict message with only the allowed fields', () => {
      expect(
        SessionSurfaceMessageSchema.parse({
          id: 'surface-message:1:abc',
          role: 'assistant',
          content: 'hello',
          timestamp: '2026-09-02T00:00:00.000Z',
        })
      ).toMatchObject({
        id: 'surface-message:1:abc',
        role: 'assistant',
        timestamp: '2026-09-02T00:00:00.000Z',
      });
    });

    it('rejects extra fields, forbidden roles, and non-string timestamps', () => {
      expect(() =>
        SessionSurfaceMessageSchema.parse({
          id: 'surface-message:1:abc',
          role: 'assistant',
          content: 'hello',
          timestamp: '2026-09-02T00:00:00.000Z',
          metadata: {},
        })
      ).toThrow();

      expect(() =>
        SessionSurfaceMessageSchema.parse({
          id: 'surface-message:2:def',
          role: 'tool',
          content: 'hello',
          timestamp: '2026-09-02T00:00:00.000Z',
        })
      ).toThrow();

      expect(() =>
        SessionSurfaceMessageSchema.parse({
          id: 'surface-message:3:ghi',
          role: 'assistant',
          content: 'hello',
          timestamp: 1_726_000_000_000,
        })
      ).toThrow();
    });
  });

  describe('enum contracts', () => {
    it('contains the approved unavailable reasons and error codes', () => {
      const reasons = [
        'history-only',
        'owner-offline',
        'owner-mismatch',
        'archived',
        'surface-not-supported',
        'capability-not-advertised',
      ] as const;

      for (const reason of reasons) {
        expect(SurfaceUnavailableReasonSchema.parse(reason)).toBe(reason);
      }

      const codes = [
        'invalid_session_surface_request',
        'invalid_session_locator',
        'session_surface_not_found',
        'workspace_binding_mismatch',
        'session_surface_cursor_invalid',
        'session_surface_snapshot_changed',
        'session_surface_read_only',
        'session_surface_capability_unavailable',
        'session_surface_capacity',
        'session_surface_unavailable',
        'session_surface_state_invalid',
      ] as const;

      for (const code of codes) {
        expect(SessionSurfaceErrorCodeSchema.parse(code)).toBe(code);
      }
    });
  });

  describe('strict envelopes', () => {
    it('reuses existing wire shapes for history and fork result aliases', () => {
      expect(SessionSurfaceHistoryPageSchema.parse(historyResultFixture)).toEqual(
        historyResultFixture
      );
      expect(SessionSurfaceOpenResultSchema.parse(forkResultFixture)).toEqual(
        forkResultFixture
      );
    });

    it('accepts capability, summary, open, history, catalog, fork, and error shapes', () => {
      const locator = {
        version: 2,
        sessionId: 'session-remote',
        workspace: {
          kind: 'acp-remote',
          workspaceRef: `acp-remote-workspace:${'C'.repeat(43)}`,
        },
      } as const;

      expect(
        SessionSurfaceCapabilitiesSchema.parse({
          connection: 'online',
          history: {
            read: true,
            fork: true,
          },
          turn: {
            start: false,
            reason: 'history-only',
          },
          files: {
            readText: false,
            writeText: false,
            browse: 'none',
            reason: 'capability-not-advertised',
          },
          terminal: {
            mode: 'none',
            owner: 'acp-remote',
            reason: 'history-only',
          },
        })
      ).toMatchObject({
        connection: 'online',
      });

      expect(
        SessionSurfaceSummarySchema.parse({
          locator,
          displayCwd: '/workspace/remote',
          pathStyle: 'posix',
          title: 'Remote session',
          rootId: 'root-1',
          parentId: 'parent-1',
          relationType: 'fork',
          taskStatus: 'running',
          messageCount: 12,
          firstMessageTime: '2026-09-02T00:00:00.000Z',
          lastMessageTime: '2026-09-02T01:00:00.000Z',
          hasErrors: false,
          archivedAt: '2026-09-02T02:00:00.000Z',
          selectedModelId: 'openai/gpt-5.6',
          capabilities: {
            connection: 'offline',
            history: {
              read: true,
              fork: false,
            },
            turn: {
              start: false,
              reason: 'archived',
            },
            files: {
              readText: false,
              writeText: false,
              browse: 'none',
              reason: 'archived',
            },
            terminal: {
              mode: 'none',
              owner: 'none',
              reason: 'archived',
            },
          },
        })
      ).toMatchObject({
        locator,
        title: 'Remote session',
      });

      expect(
        SessionSurfaceOpenRequestSchema.parse({
          locator,
          limit: 50,
        })
      ).toMatchObject({
        locator,
        limit: 50,
      });

      expect(
        SessionSurfaceOpenResultSchema.parse({
          session: {
            locator,
            displayCwd: '/workspace/remote',
            rootId: 'root-1',
            taskStatus: 'running',
            messageCount: 12,
            firstMessageTime: '2026-09-02T00:00:00.000Z',
            lastMessageTime: '2026-09-02T01:00:00.000Z',
            hasErrors: false,
            capabilities: {
              connection: 'online',
              history: {
                read: true,
                fork: true,
              },
              turn: {
                start: false,
                reason: 'history-only',
              },
              files: {
                readText: false,
                writeText: false,
                browse: 'none',
                reason: 'capability-not-advertised',
              },
              terminal: {
                mode: 'none',
                owner: 'acp-remote',
                reason: 'history-only',
              },
            },
          },
          history: {
            messages: [
              {
                id: 'surface-message:1:abc',
                role: 'user',
                content: 'hello',
                timestamp: '2026-09-02T00:00:00.000Z',
              },
            ],
            snapshot: 'snapshot-1',
            truncated: false,
          },
        })
      ).toMatchObject({
        history: {
          snapshot: 'snapshot-1',
        },
      });

      expect(
        SessionSurfaceHistoryRequestSchema.parse({
          locator,
          cursor: 'cursor-1',
          expectedSnapshot: 'snapshot-1',
          limit: 100,
        })
      ).toMatchObject({
        cursor: 'cursor-1',
        expectedSnapshot: 'snapshot-1',
        limit: 100,
      });

      expect(
        SessionSurfaceHistoryPageSchema.parse({
          messages: [
            {
              id: 'surface-message:1:abc',
              role: 'user',
              content: 'hello',
              timestamp: '2026-09-02T00:00:00.000Z',
            },
          ],
          olderCursor: 'cursor-2',
          snapshot: 'snapshot-1',
          truncated: false,
        })
      ).toMatchObject({
        olderCursor: 'cursor-2',
      });

      expect(
        SessionSurfaceCatalogPageSchema.parse({
          sessions: [
            {
              locator,
              displayCwd: '/workspace/remote',
              rootId: 'root-1',
              taskStatus: 'running',
              messageCount: 12,
              firstMessageTime: '2026-09-02T00:00:00.000Z',
              lastMessageTime: '2026-09-02T01:00:00.000Z',
              hasErrors: false,
              capabilities: {
                connection: 'offline',
                history: {
                  read: true,
                  fork: false,
                },
                turn: {
                  start: false,
                  reason: 'owner-offline',
                },
                files: {
                  readText: false,
                  writeText: false,
                  browse: 'none',
                  reason: 'owner-offline',
                },
                terminal: {
                  mode: 'none',
                  owner: 'none',
                  reason: 'owner-offline',
                },
              },
            },
          ],
          nextCursor: 'catalog-cursor-1',
        })
      ).toMatchObject({
        nextCursor: 'catalog-cursor-1',
      });

      expect(
        SessionSurfaceForkRequestSchema.parse({
          locator,
        })
      ).toMatchObject({
        locator,
      });

      expect(
        SessionSurfaceErrorEnvelopeSchema.parse({
          error: {
            code: 'session_surface_unavailable',
            message: 'surface unavailable',
            retryable: true,
          },
        })
      ).toMatchObject({
        error: {
          code: 'session_surface_unavailable',
          retryable: true,
        },
      });
    });

    it('rejects out-of-range limits and extra properties in nested objects', () => {
      const locator = {
        version: 2,
        sessionId: 'session-remote',
        workspace: {
          kind: 'acp-remote',
          workspaceRef: `acp-remote-workspace:${'D'.repeat(43)}`,
        },
      } as const;

      expect(
        SessionSurfaceOpenRequestSchema.parse({
          locator,
          limit: 1,
        })
      ).toMatchObject({
        limit: 1,
      });

      expect(
        SessionSurfaceOpenRequestSchema.parse({
          locator,
          limit: 100,
        })
      ).toMatchObject({
        limit: 100,
      });

      expect(() =>
        SessionSurfaceOpenRequestSchema.parse({
          locator,
          limit: 0,
        })
      ).toThrow();

      expect(() =>
        SessionSurfaceHistoryRequestSchema.parse({
          locator,
          cursor: 'cursor-1',
          expectedSnapshot: 'snapshot-1',
          limit: 101,
        })
      ).toThrow();

      expect(() =>
        SessionSurfaceSummarySchema.parse({
          locator,
          displayCwd: '/workspace/remote',
          rootId: 'root-1',
          taskStatus: 'running',
          messageCount: 12,
          firstMessageTime: '2026-09-02T00:00:00.000Z',
          lastMessageTime: '2026-09-02T01:00:00.000Z',
          hasErrors: false,
          capabilities: {
            connection: 'offline',
            history: {
              read: true,
              fork: false,
              extra: false,
            },
            turn: {
              start: false,
              reason: 'archived',
            },
            files: {
              readText: false,
              writeText: false,
              browse: 'none',
              reason: 'archived',
            },
            terminal: {
              mode: 'none',
              owner: 'none',
              reason: 'archived',
            },
          },
        })
      ).toThrow();

      expect(() =>
        SessionSurfaceHistoryPageSchema.parse({
          messages: [],
          snapshot: 'snapshot-1',
          truncated: false,
          extra: true,
        })
      ).toThrow();

      expect(() =>
        SessionSurfaceErrorEnvelopeSchema.parse({
          error: {
            code: 'session_surface_unavailable',
            message: 'surface unavailable',
            retryable: true,
            detail: 'too much',
          },
        })
      ).toThrow();
    });
  });
});
