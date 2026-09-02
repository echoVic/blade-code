import { describe, expect, it } from 'vitest';
import {
  SessionSurfaceCapabilitiesSchema,
  SessionSurfaceCatalogRequestSchema,
  SessionSurfaceCatalogResultSchema,
  SessionSurfaceErrorCodeSchema,
  SessionSurfaceErrorEnvelopeSchema,
  SessionSurfaceForkRequestSchema,
  SessionSurfaceHistoryOpenRequestSchema,
  SessionSurfaceHistoryOpenResultSchema,
  SessionSurfaceHistoryRequestSchema,
  SessionSurfaceHistoryResultSchema,
  SessionSurfaceLocatorSchema,
  SessionSurfaceMessageSchema,
  SessionSurfaceOpenRequestSchema,
  SessionSurfaceOpenResultSchema,
  SessionSurfaceSummaryRequestSchema,
  SessionSurfaceSummaryResultSchema,
} from '../../../../src/api/sessionSurfaceSchemas.js';

describe('session surface schemas', () => {
  describe('SessionSurfaceLocatorSchema', () => {
    it('accepts strict local and remote discriminated locators', () => {
      expect(
        SessionSurfaceLocatorSchema.parse({
          kind: 'local',
          sessionId: 'session-local',
          projectPath: '/workspace/project',
        })
      ).toMatchObject({
        kind: 'local',
        sessionId: 'session-local',
      });

      expect(
        SessionSurfaceLocatorSchema.parse({
          kind: 'remote',
          ref: `acp-remote-workspace:${'A'.repeat(43)}`,
        })
      ).toMatchObject({
        kind: 'remote',
      });
    });

    it('rejects additional properties and invalid remote refs', () => {
      expect(() =>
        SessionSurfaceLocatorSchema.parse({
          kind: 'local',
          sessionId: 'session-local',
          projectPath: '/workspace/project',
          extra: true,
        })
      ).toThrow();

      expect(() =>
        SessionSurfaceLocatorSchema.parse({
          kind: 'remote',
          ref: 'acp-remote-workspace:not-long-enough',
        })
      ).toThrow();
    });
  });

  describe('SessionSurfaceMessageSchema', () => {
    it('accepts a strict message with only the allowed fields', () => {
      expect(
        SessionSurfaceMessageSchema.parse({
          id: 'msg-1',
          role: 'assistant',
          content: 'hello',
          timestamp: 1_726_000_000_000,
          truncated: false,
        })
      ).toMatchObject({
        role: 'assistant',
        truncated: false,
      });
    });

    it('rejects extra message fields', () => {
      expect(() =>
        SessionSurfaceMessageSchema.parse({
          id: 'msg-1',
          role: 'assistant',
          content: 'hello',
          timestamp: 1_726_000_000_000,
          truncated: false,
          metadata: {},
        })
      ).toThrow();
    });
  });

  describe('SessionSurfaceErrorCodeSchema', () => {
    it('contains the required session surface error codes', () => {
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
    it('accepts strict capability, summary, open, history, catalog, and fork shapes', () => {
      const locator = {
        kind: 'remote',
        ref: `acp-remote-workspace:${'B'.repeat(43)}`,
      } as const;

      expect(
        SessionSurfaceCapabilitiesSchema.parse({
          canOpen: true,
          canSummarize: true,
          canReadHistory: true,
          canFork: false,
          canListCatalog: true,
        })
      ).toMatchObject({
        canFork: false,
      });

      expect(
        SessionSurfaceSummaryRequestSchema.parse({
          locator,
        })
      ).toMatchObject({
        locator,
      });

      expect(
        SessionSurfaceSummaryResultSchema.parse({
          locator,
          summary: 'ready',
          capabilities: {
            canOpen: true,
            canSummarize: true,
            canReadHistory: true,
            canFork: false,
            canListCatalog: true,
          },
        })
      ).toMatchObject({
        summary: 'ready',
      });

      expect(
        SessionSurfaceOpenRequestSchema.parse({
          locator,
        })
      ).toMatchObject({
        locator,
      });

      expect(
        SessionSurfaceOpenResultSchema.parse({
          locator,
          opened: true,
          readOnly: false,
          capabilities: {
            canOpen: true,
            canSummarize: true,
            canReadHistory: true,
            canFork: true,
            canListCatalog: true,
          },
        })
      ).toMatchObject({
        opened: true,
      });

      expect(
        SessionSurfaceHistoryRequestSchema.parse({
          locator,
          limit: 100,
        })
      ).toMatchObject({
        limit: 100,
      });

      expect(
        SessionSurfaceHistoryResultSchema.parse({
          locator,
          messages: [
            {
              id: 'msg-1',
              role: 'user',
              content: 'hello',
              timestamp: 1_726_000_000_000,
              truncated: false,
            },
          ],
          hasMore: false,
        })
      ).toMatchObject({
        hasMore: false,
      });

      expect(
        SessionSurfaceHistoryOpenRequestSchema.parse({
          locator,
          cursor: 'cursor-1',
          limit: 1,
        })
      ).toMatchObject({
        limit: 1,
      });

      expect(
        SessionSurfaceHistoryOpenResultSchema.parse({
          locator,
          cursor: 'cursor-1',
          messages: [],
          hasMore: false,
        })
      ).toMatchObject({
        cursor: 'cursor-1',
      });

      expect(
        SessionSurfaceCatalogRequestSchema.parse({
          locator,
          limit: 50,
        })
      ).toMatchObject({
        limit: 50,
      });

      expect(
        SessionSurfaceCatalogResultSchema.parse({
          locator,
          entries: [
            {
              id: 'entry-1',
              title: 'First session',
            },
          ],
          hasMore: false,
        })
      ).toMatchObject({
        hasMore: false,
      });

      expect(
        SessionSurfaceForkRequestSchema.parse({
          locator,
          message: {
            id: 'msg-1',
            role: 'user',
            content: 'fork from here',
            timestamp: 1_726_000_000_000,
            truncated: false,
          },
        })
      ).toMatchObject({
        locator,
      });

      expect(
        SessionSurfaceErrorEnvelopeSchema.parse({
          error: {
            code: 'session_surface_unavailable',
            message: 'surface unavailable',
          },
        })
      ).toMatchObject({
        error: {
          code: 'session_surface_unavailable',
        },
      });
    });

    it('rejects out-of-range limits and extra properties in nested objects', () => {
      const locator = {
        kind: 'remote',
        ref: `acp-remote-workspace:${'C'.repeat(43)}`,
      } as const;

      expect(() =>
        SessionSurfaceHistoryRequestSchema.parse({
          locator,
          limit: 0,
        })
      ).toThrow();

      expect(() =>
        SessionSurfaceCatalogRequestSchema.parse({
          locator,
          limit: 101,
        })
      ).toThrow();

      expect(() =>
        SessionSurfaceSummaryResultSchema.parse({
          locator,
          summary: 'ready',
          capabilities: {
            canOpen: true,
            canSummarize: true,
            canReadHistory: true,
            canFork: true,
            canListCatalog: true,
            extra: false,
          },
        })
      ).toThrow();

      expect(() =>
        SessionSurfaceErrorEnvelopeSchema.parse({
          error: {
            code: 'session_surface_unavailable',
            message: 'surface unavailable',
            detail: 'too much',
          },
        })
      ).toThrow();
    });
  });
});
