import { describe, expect, it } from 'vitest';
import { sanitizeToolMetadata } from '../../../../src/server/routes/session.js';

describe('MCP tool Web metadata projection', () => {
  it('replaces raw MCP results with a strict structural allowlist', () => {
    const projected = sanitizeToolMetadata('mcp__fixture__render', {
      summary: 'MCP result',
      mcpResult: {
        isError: false,
        contentCount: 2,
        textBytes: 10,
        structuredBytes: 20,
        artifactCount: 1,
        truncated: true,
        binaryOmitted: true,
        content: [
          {
            type: 'image',
            data: 'RAW_BASE64',
          },
        ],
        structuredContent: {
          secret: 'RAW_STRUCTURED_SECRET',
        },
        _meta: {
          secret: 'RAW_META_SECRET',
        },
        artifacts: [
          {
            id: 'a'.repeat(64),
            sha256: 'a'.repeat(64),
            kind: 'image',
            size: 42,
            persisted: true,
            mimeType: 'image/png',
            path: '/private/artifact.png',
            ignored: 'RAW_ARTIFACT_SECRET',
          },
        ],
      },
    });

    expect(projected).toEqual({
      summary: 'MCP result',
      mcpResult: {
        isError: false,
        contentCount: 2,
        textBytes: 10,
        structuredBytes: 20,
        artifactCount: 1,
        truncated: true,
        binaryOmitted: true,
        artifacts: [
          {
            id: 'a'.repeat(64),
            sha256: 'a'.repeat(64),
            kind: 'image',
            size: 42,
            persisted: true,
            mimeType: 'image/png',
            path: '/private/artifact.png',
          },
        ],
      },
    });
    expect(JSON.stringify(projected)).not.toContain('RAW_');
  });

  it('drops malformed legacy MCP result metadata', () => {
    expect(
      sanitizeToolMetadata('mcp__fixture__legacy', {
        summary: 'legacy',
        mcpResult: 'RAW_RESULT',
      })
    ).toEqual({ summary: 'legacy' });
  });

  it('uses a strict Bash allowlist and drops every raw output alias', () => {
    const projected = sanitizeToolMetadata('Bash', {
      command: 'printenv SECRET',
      summary: 'Command completed',
      stdout: 'RAW_STDOUT_SENTINEL',
      stderr: 'RAW_STDERR_SENTINEL',
      content: 'RAW_CONTENT_SENTINEL',
      oldContent: 'RAW_OLD_SENTINEL',
      newContent: 'RAW_NEW_SENTINEL',
      output_truncated: true,
      capture_truncated: true,
      stdout_total_bytes: 1_100_000,
      stdout_retained_bytes: 1_048_576,
      stdout_omitted_bytes: 51_424,
      stderr_total_bytes: 0,
      stderr_retained_bytes: 0,
      stderr_omitted_bytes: 0,
      output_accounting_complete: true,
      terminal_transport: 'local',
      terminal_output_merged: false,
      sandboxed: false,
      ignored: 'RAW_IGNORED_SENTINEL',
    });

    expect(projected).toEqual({
      summary: 'Command completed',
      output_truncated: true,
      capture_truncated: true,
      stdout_total_bytes: 1_100_000,
      stdout_retained_bytes: 1_048_576,
      stdout_omitted_bytes: 51_424,
      stderr_total_bytes: 0,
      stderr_retained_bytes: 0,
      stderr_omitted_bytes: 0,
      output_accounting_complete: true,
      terminal_transport: 'local',
      terminal_output_merged: false,
      sandboxed: false,
    });
    expect(JSON.stringify(projected)).not.toContain('RAW_');
    expect(projected).not.toHaveProperty('command');
    expect(projected).not.toHaveProperty('stdout');
    expect(projected).not.toHaveProperty('stderr');
  });

  it('preserves only validated tool admission metadata for Bash results', () => {
    expect(
      sanitizeToolMetadata('Bash', {
        summary: 'Tool execution capacity is busy',
        tool_admission: {
          code: 'tool_busy',
          reason: 'queue_full',
          scope: 'session',
          retryable: true,
          kind: 'execute',
          limit: 64,
          secret: 'RAW_ADMISSION_SECRET',
        },
      })
    ).toEqual({
      summary: 'Tool execution capacity is busy',
      tool_admission: {
        code: 'tool_busy',
        reason: 'queue_full',
        scope: 'session',
        retryable: true,
        kind: 'execute',
        limit: 64,
      },
    });

    expect(
      sanitizeToolMetadata('Bash', {
        summary: 'Malformed admission',
        tool_admission: {
          code: 'tool_busy',
          reason: 'queue_full',
          scope: 'session',
          retryable: true,
          kind: 'execute',
          limit: Number.POSITIVE_INFINITY,
        },
      })
    ).toEqual({ summary: 'Malformed admission' });
  });

  it('preserves only validated foreground handoff metadata for Bash results', () => {
    expect(
      sanitizeToolMetadata('Bash', {
        summary: 'Command is still running in background',
        background: true,
        auto_backgrounded: true,
        background_reason: 'foreground_budget',
        foreground_budget_ms: 15_000,
        bash_id: 'bash_123e4567-e89b-12d3-a456-426614174000',
        shell_id: 'bash_123e4567-e89b-12d3-a456-426614174000',
        pid: 1234,
        terminal_transport: 'local',
        secret: 'RAW_HANDOFF_SECRET',
      })
    ).toEqual({
      summary: 'Command is still running in background',
      background: true,
      auto_backgrounded: true,
      background_reason: 'foreground_budget',
      foreground_budget_ms: 15_000,
      bash_id: 'bash_123e4567-e89b-12d3-a456-426614174000',
      shell_id: 'bash_123e4567-e89b-12d3-a456-426614174000',
      pid: 1234,
      terminal_transport: 'local',
    });

    expect(
      sanitizeToolMetadata('Bash', {
        summary: 'Malformed handoff',
        background: true,
        auto_backgrounded: true,
        background_reason: 'RAW_REASON',
        foreground_budget_ms: Number.POSITIVE_INFINITY,
        bash_id: '../RAW_ID',
        shell_id: 'not-a-shell-id',
      })
    ).toEqual({
      summary: 'Malformed handoff',
      background: true,
      auto_backgrounded: true,
    });
  });

  it('preserves only validated background Shell admission metadata', () => {
    expect(
      sanitizeToolMetadata('Bash', {
        summary: 'Background Shell capacity is busy',
        background_shell_admission: {
          code: 'background_shell_busy',
          scope: 'session',
          limit: 4,
          retryable: true,
          secret: 'RAW_BACKGROUND_ADMISSION_SECRET',
        },
      })
    ).toEqual({
      summary: 'Background Shell capacity is busy',
      background_shell_admission: {
        code: 'background_shell_busy',
        scope: 'session',
        limit: 4,
        retryable: true,
      },
    });

    expect(
      sanitizeToolMetadata('Bash', {
        summary: 'Malformed background admission',
        background_shell_admission: {
          code: 'background_shell_busy',
          scope: 'session',
          limit: 0,
          retryable: true,
        },
      })
    ).toEqual({ summary: 'Malformed background admission' });
  });
});
