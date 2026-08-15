import { describe, expect, it } from 'vitest';

describe('headless event contract', () => {
  it('exports a stable event version and validates tool events', async () => {
    const {
      HEADLESS_EVENT_VERSION,
      HeadlessJsonlEventSchema,
      createHeadlessJsonlEvent,
    } = await import('../../../src/commands/headlessEvents.js');

    expect(HEADLESS_EVENT_VERSION).toBe(1);

    const event = createHeadlessJsonlEvent('tool_start', {
      tool_name: 'Read',
      summary: 'Reading demo.ts',
      target: '/tmp/demo.ts',
    });

    expect(event).toEqual({
      event_version: 1,
      type: 'tool_start',
      tool_name: 'Read',
      summary: 'Reading demo.ts',
      target: '/tmp/demo.ts',
    });

    expect(() => HeadlessJsonlEventSchema.parse(event)).not.toThrow();

    expect(
      createHeadlessJsonlEvent('tool_progress', {
        tool_name: 'progressive',
        message: 'phase-two',
        progress: 2,
        total: 4,
      })
    ).toEqual({
      event_version: 1,
      type: 'tool_progress',
      tool_name: 'progressive',
      message: 'phase-two',
      progress: 2,
      total: 4,
    });

    expect(
      createHeadlessJsonlEvent('tool_progress', {
        tool_name: 'Bash',
        message: 'Waiting for tool execution capacity',
        admission: {
          kind: 'execute',
          scope: 'session',
          queue_position: 2,
          in_flight: 2,
          limit: 2,
        },
      })
    ).toEqual({
      event_version: 1,
      type: 'tool_progress',
      tool_name: 'Bash',
      message: 'Waiting for tool execution capacity',
      admission: {
        kind: 'execute',
        scope: 'session',
        queue_position: 2,
        in_flight: 2,
        limit: 2,
      },
    });

    const handoff = createHeadlessJsonlEvent('tool_result', {
      tool_name: 'Bash',
      summary: 'Command is still running in background',
      success: true,
      background: {
        auto_backgrounded: true,
        background_reason: 'foreground_budget',
        foreground_budget_ms: 15_000,
        shell_id: 'bash_123e4567-e89b-12d3-a456-426614174000',
        pid: 1234,
        terminal_transport: 'local',
      },
    });
    expect(handoff).toMatchObject({
      event_version: 1,
      type: 'tool_result',
      background: {
        auto_backgrounded: true,
        foreground_budget_ms: 15_000,
        shell_id: 'bash_123e4567-e89b-12d3-a456-426614174000',
      },
    });
    expect(() => HeadlessJsonlEventSchema.parse(handoff)).not.toThrow();

    const providerRetry = createHeadlessJsonlEvent('provider_retry', {
      phase: 'scheduled',
      attempt: 1,
      max_retries: 2,
      reason: 'server_error',
      status_code: 503,
      delay_ms: 750,
      next_retry_at: 1_750,
    });
    expect(providerRetry).toEqual({
      event_version: 1,
      type: 'provider_retry',
      phase: 'scheduled',
      attempt: 1,
      max_retries: 2,
      reason: 'server_error',
      status_code: 503,
      delay_ms: 750,
      next_retry_at: 1_750,
    });
    expect(() => HeadlessJsonlEventSchema.parse(providerRetry)).not.toThrow();

    const providerRecoveryHeartbeat = createHeadlessJsonlEvent('provider_retry', {
      phase: 'waiting',
      attempt: 4,
      max_retries: 12,
      reason: 'server_error',
      mode: 'bounded_foreground',
      recovery_budget_ms: 600_000,
      recovery_elapsed_ms: 15_000,
      recovery_remaining_ms: 585_000,
    });
    expect(providerRecoveryHeartbeat).toEqual({
      event_version: 1,
      type: 'provider_retry',
      phase: 'waiting',
      attempt: 4,
      max_retries: 12,
      reason: 'server_error',
      mode: 'bounded_foreground',
      recovery_budget_ms: 600_000,
      recovery_elapsed_ms: 15_000,
      recovery_remaining_ms: 585_000,
    });
    expect(() =>
      HeadlessJsonlEventSchema.parse(providerRecoveryHeartbeat)
    ).not.toThrow();
    expect(() =>
      HeadlessJsonlEventSchema.parse({
        event_version: 1,
        type: 'provider_retry',
        phase: 'waiting',
        attempt: 4,
        max_retries: 12,
        reason: 'server_error',
        mode: 'bounded_foreground',
        recovery_budget_ms: 600_000,
        recovery_elapsed_ms: 600_001,
        recovery_remaining_ms: -1,
      })
    ).toThrow();

    const providerStall = createHeadlessJsonlEvent('provider_stall', {
      phase: 'detected',
      stall_count: 1,
      duration_ms: 30_000,
      warning_after_ms: 30_000,
      timeout_ms: 300_000,
      output_started: true,
    });
    expect(providerStall).toEqual({
      event_version: 1,
      type: 'provider_stall',
      phase: 'detected',
      stall_count: 1,
      duration_ms: 30_000,
      warning_after_ms: 30_000,
      timeout_ms: 300_000,
      output_started: true,
    });
    expect(() => HeadlessJsonlEventSchema.parse(providerStall)).not.toThrow();

    const actionStationarity = createHeadlessJsonlEvent('action_stationarity', {
      phase: 'detected',
      tool_name: 'TaskOutput',
      run_length: 8,
      nudge_threshold: 8,
      halt_threshold: 16,
      progress_aware: true,
    });
    expect(actionStationarity).toEqual({
      event_version: 1,
      type: 'action_stationarity',
      phase: 'detected',
      tool_name: 'TaskOutput',
      run_length: 8,
      nudge_threshold: 8,
      halt_threshold: 16,
      progress_aware: true,
    });
    expect(() => HeadlessJsonlEventSchema.parse(actionStationarity)).not.toThrow();

    expect(
      createHeadlessJsonlEvent('mcp_catalog_changed', {
        revision: 2,
        server_name: 'dynamic',
        added: ['mcp__dynamic__new_tool'],
        removed: [],
        updated: ['mcp__dynamic__stable_tool'],
      })
    ).toEqual({
      event_version: 1,
      type: 'mcp_catalog_changed',
      revision: 2,
      server_name: 'dynamic',
      added: ['mcp__dynamic__new_tool'],
      removed: [],
      updated: ['mcp__dynamic__stable_tool'],
    });
    expect(
      createHeadlessJsonlEvent('mcp_content_changed', {
        revision: 4,
        server_name: 'content',
        content_kind: 'prompts',
        added: ['new_prompt'],
        removed: [],
        updated: ['compose_report'],
      })
    ).toMatchObject({
      event_version: 1,
      type: 'mcp_content_changed',
      content_kind: 'prompts',
    });
    expect(
      createHeadlessJsonlEvent('mcp_resource_updated', {
        revision: 5,
        server_name: 'content',
        uri: 'context://live',
      })
    ).toEqual({
      event_version: 1,
      type: 'mcp_resource_updated',
      revision: 5,
      server_name: 'content',
      uri: 'context://live',
    });
    expect(
      createHeadlessJsonlEvent('mcp_connection_changed', {
        revision: 6,
        server_name: 'content',
        phase: 'reconnecting',
        reason: 'transport_closed',
        attempt: 1,
        max_attempts: 5,
        next_retry_at: 1_000,
        error: 'Connection closed',
      })
    ).toMatchObject({
      event_version: 1,
      type: 'mcp_connection_changed',
      revision: 6,
      phase: 'reconnecting',
      attempt: 1,
      max_attempts: 5,
    });
    expect(
      createHeadlessJsonlEvent('mcp_log', {
        revision: 7,
        server_name: 'content',
        level: 'warning',
        logger: 'fixture',
        message: 'SAFE_LOG_MARKER',
        projected_bytes: 15,
        data_sha256: 'a'.repeat(64),
        truncated: false,
        details_omitted: false,
        timestamp: 1_000,
      })
    ).toMatchObject({
      event_version: 1,
      type: 'mcp_log',
      revision: 7,
      server_name: 'content',
      level: 'warning',
      message: 'SAFE_LOG_MARKER',
    });
    expect(
      createHeadlessJsonlEvent('mcp_instructions_changed', {
        revision: 8,
        server_name: 'content',
        action: 'added',
        reason: 'snapshot',
        text: 'Use INSTRUCTION_CODE_42',
        source_bytes: 23,
        projected_bytes: 23,
        sha256: 'b'.repeat(64),
        truncated: false,
        details_omitted: false,
      })
    ).toMatchObject({
      event_version: 1,
      type: 'mcp_instructions_changed',
      revision: 8,
      server_name: 'content',
      action: 'added',
    });
    expect(
      createHeadlessJsonlEvent('mcp_task_changed', {
        revision: 9,
        task_id: 'mcp_task_safe',
        server_name: 'content',
        tool_name: 'long_task',
        status: 'completed',
        created_at: 1_000,
        updated_at: 2_000,
        completed_at: 2_000,
        has_result: true,
      })
    ).toMatchObject({
      event_version: 1,
      type: 'mcp_task_changed',
      task_id: 'mcp_task_safe',
      status: 'completed',
      has_result: true,
    });
    expect(
      createHeadlessJsonlEvent('project_rules_loaded', {
        files: [
          {
            id: 'project:rule-one',
            relative_path: '.claude/rules/typescript.md',
            source: 'project',
            conditional: true,
            content_sha256: 'c'.repeat(64),
          },
        ],
        trigger_paths: ['src/index.ts'],
        blocked_write: true,
      })
    ).toMatchObject({
      event_version: 1,
      type: 'project_rules_loaded',
      blocked_write: true,
    });
    const structured = createHeadlessJsonlEvent('structured_output', {
      output: { answer: 'done' },
      schema_digest: 'd'.repeat(64),
    });
    expect(structured).toEqual({
      event_version: 1,
      type: 'structured_output',
      output: { answer: 'done' },
      schema_digest: 'd'.repeat(64),
    });
    expect(() => HeadlessJsonlEventSchema.parse(structured)).not.toThrow();

    const goal = createHeadlessJsonlEvent('goal', {
      state: 'updated',
      goal_id: 'goal-1',
      status: 'verifying',
      verification_attempt: 2,
      verification_status: 'partial',
      verifier_session_id: 'verifier-2',
      verification_evidence_sha256: 'e'.repeat(64),
    });
    expect(goal).toEqual({
      event_version: 1,
      type: 'goal',
      state: 'updated',
      goal_id: 'goal-1',
      status: 'verifying',
      verification_attempt: 2,
      verification_status: 'partial',
      verifier_session_id: 'verifier-2',
      verification_evidence_sha256: 'e'.repeat(64),
    });
    expect(() => HeadlessJsonlEventSchema.parse(goal)).not.toThrow();

    const shellStarted = createHeadlessJsonlEvent('user_shell_started', {
      execution_id: 'shell-1',
      command: 'pwd',
      auxiliary: false,
    });
    const shellOutput = createHeadlessJsonlEvent('user_shell_output', {
      execution_id: 'shell-1',
      stream: 'stdout',
      chunk: '/workspace\n',
      stream_truncated: false,
    });
    const shellCompleted = createHeadlessJsonlEvent('user_shell_completed', {
      execution_id: 'shell-1',
      message_id: 'message-1',
      status: 'completed',
      exit_code: 0,
      duration_ms: 4,
      stdout: '/workspace\n',
      stderr: '',
      truncated: false,
      auxiliary: false,
    });

    expect(shellStarted).toEqual({
      event_version: 1,
      type: 'user_shell_started',
      execution_id: 'shell-1',
      command: 'pwd',
      auxiliary: false,
    });
    expect(shellOutput).toMatchObject({
      event_version: 1,
      type: 'user_shell_output',
      stream: 'stdout',
      chunk: '/workspace\n',
    });
    expect(shellCompleted).toMatchObject({
      event_version: 1,
      type: 'user_shell_completed',
      message_id: 'message-1',
      status: 'completed',
      exit_code: 0,
    });
    for (const shellEvent of [shellStarted, shellOutput, shellCompleted]) {
      expect(() => HeadlessJsonlEventSchema.parse(shellEvent)).not.toThrow();
    }
  });

  it('validates phase events for search and target-hit states', async () => {
    const { HeadlessJsonlEventSchema, createHeadlessJsonlEvent } = await import(
      '../../../src/commands/headlessEvents.js'
    );

    const event = createHeadlessJsonlEvent('phase', {
      phase: 'target_hit',
      status: 'hit',
      message: 'Target locked: Editing headless.ts',
      tool_name: 'Edit',
      target: 'packages/cli/src/commands/headless.ts',
    });

    expect(() => HeadlessJsonlEventSchema.parse(event)).not.toThrow();
    expect(event).toEqual({
      event_version: 1,
      type: 'phase',
      phase: 'target_hit',
      status: 'hit',
      message: 'Target locked: Editing headless.ts',
      tool_name: 'Edit',
      target: 'packages/cli/src/commands/headless.ts',
    });
  });

  it('validates durable subagent lineage events', async () => {
    const { HEADLESS_EVENT_VERSION, HeadlessJsonlEventSchema } = await import(
      '../../../src/commands/headlessEvents.js'
    );
    expect(
      HeadlessJsonlEventSchema.parse({
        event_version: HEADLESS_EVENT_VERSION,
        type: 'subagent',
        state: 'spawned',
        session_id: 'agent-child',
        subagent_type: 'Explore',
        resumed_from: 'agent-source',
        root_agent_id: 'agent-root',
        resume_depth: 2,
      })
    ).toMatchObject({
      state: 'spawned',
      session_id: 'agent-child',
      resumed_from: 'agent-source',
      resume_depth: 2,
    });
  });
});
