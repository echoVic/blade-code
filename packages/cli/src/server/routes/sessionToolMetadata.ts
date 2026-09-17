import {
  MAX_BROWSER_DIAGNOSTIC_RESULT_ENTRIES,
  MAX_BROWSER_ID_BYTES,
  MAX_BROWSER_ORIGIN_BYTES,
  MAX_BROWSER_PROJECTED_URL_BYTES,
  MAX_BROWSER_REF_BYTES,
  MAX_BROWSER_SCREENSHOT_BYTES,
  MAX_BROWSER_TITLE_BYTES,
} from '../../browser/constants.js';
import { isBrowserToolName } from '../../browser/types.js';
import type { ToolResultMetadata } from '../../tools/types/ToolTypes.js';

function sanitizeToolAdmissionMetadata(
  value: unknown
): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const admission = value as Record<string, unknown>;
  const { code, kind, limit, reason, scope } = admission;
  if (
    (code !== 'tool_busy' && code !== 'tool_batch_full') ||
    (reason !== 'queue_full' && reason !== 'wait_timeout' && reason !== 'turn_limit') ||
    (scope !== 'global' && scope !== 'session') ||
    typeof admission.retryable !== 'boolean' ||
    !Number.isSafeInteger(limit) ||
    (limit as number) <= 0 ||
    (kind !== undefined &&
      kind !== 'readonly' &&
      kind !== 'write' &&
      kind !== 'execute')
  ) {
    return undefined;
  }
  return {
    code,
    reason,
    scope,
    retryable: admission.retryable,
    ...(kind === undefined ? {} : { kind }),
    limit,
  };
}

export function sanitizeToolMetadata(
  toolName: string,
  metadata: ToolResultMetadata | undefined
): ToolResultMetadata | undefined {
  if (!metadata || typeof metadata !== 'object') return metadata;
  const sanitized = { ...(metadata as Record<string, unknown>) };
  const toolAdmission = sanitizeToolAdmissionMetadata(sanitized.tool_admission);
  if (toolAdmission) sanitized.tool_admission = toolAdmission;
  else delete sanitized.tool_admission;
  if (isBrowserToolName(toolName)) {
    const source =
      sanitized.browser &&
      typeof sanitized.browser === 'object' &&
      !Array.isArray(sanitized.browser)
        ? (sanitized.browser as Record<string, unknown>)
        : {};
    const projected: Record<string, unknown> = {};
    const boundedString = (key: string, maximum: number, pattern?: RegExp): void => {
      const value = source[key];
      if (
        typeof value === 'string' &&
        Buffer.byteLength(value) <= maximum &&
        (!pattern || pattern.test(value))
      ) {
        projected[key] = value;
      }
    };
    boundedString('action', 64);
    boundedString('status', 16, /^(?:ok|warning|error)$/);
    boundedString('pageId', MAX_BROWSER_ID_BYTES, /^browser_page_[a-f0-9-]+$/);
    boundedString('snapshotId', MAX_BROWSER_ID_BYTES, /^browser_snapshot_[a-f0-9-]+$/);
    boundedString('origin', MAX_BROWSER_ORIGIN_BYTES);
    boundedString('candidateOrigin', MAX_BROWSER_ORIGIN_BYTES);
    boundedString('url', MAX_BROWSER_PROJECTED_URL_BYTES);
    boundedString('title', MAX_BROWSER_TITLE_BYTES);
    boundedString('errorCode', 64, /^browser_[a-z_]+$/);
    if (typeof source.truncated === 'boolean') {
      projected.truncated = source.truncated;
    }
    if (
      typeof source.actionApplied === 'boolean' ||
      source.actionApplied === 'unknown'
    ) {
      projected.actionApplied = source.actionApplied;
    }
    if (typeof source.sideEffectsUncertain === 'boolean') {
      projected.sideEffectsUncertain = source.sideEffectsUncertain;
    }
    if (
      typeof source.diagnosticCount === 'number' &&
      Number.isSafeInteger(source.diagnosticCount) &&
      source.diagnosticCount >= 0 &&
      source.diagnosticCount <= MAX_BROWSER_DIAGNOSTIC_RESULT_ENTRIES
    ) {
      projected.diagnosticCount = source.diagnosticCount;
    }
    if (
      source.interaction &&
      typeof source.interaction === 'object' &&
      !Array.isArray(source.interaction)
    ) {
      const interaction = source.interaction as Record<string, unknown>;
      const allowedActions = new Set([
        'click',
        'hover',
        'fill',
        'type',
        'press',
        'select',
        'check',
        'uncheck',
        'scroll',
      ]);
      if (
        typeof interaction.action === 'string' &&
        allowedActions.has(interaction.action)
      ) {
        const projectedInteraction: Record<string, unknown> = {
          action: interaction.action,
        };
        if (
          typeof interaction.ref === 'string' &&
          Buffer.byteLength(interaction.ref) <= MAX_BROWSER_REF_BYTES &&
          /^[a-z][a-z0-9]*$/.test(interaction.ref)
        ) {
          projectedInteraction.ref = interaction.ref;
        }
        const boundedNumber = (
          value: unknown,
          minimum: number,
          maximum: number
        ): value is number =>
          typeof value === 'number' &&
          Number.isFinite(value) &&
          value >= minimum &&
          value <= maximum;
        if (
          interaction.viewport &&
          typeof interaction.viewport === 'object' &&
          !Array.isArray(interaction.viewport)
        ) {
          const viewport = interaction.viewport as Record<string, unknown>;
          if (
            boundedNumber(viewport.width, 1, 16_384) &&
            boundedNumber(viewport.height, 1, 16_384)
          ) {
            projectedInteraction.viewport = {
              width: viewport.width,
              height: viewport.height,
            };
          }
        }
        if (
          interaction.targetBox &&
          typeof interaction.targetBox === 'object' &&
          !Array.isArray(interaction.targetBox)
        ) {
          const targetBox = interaction.targetBox as Record<string, unknown>;
          if (
            boundedNumber(targetBox.x, -16_384, 32_768) &&
            boundedNumber(targetBox.y, -16_384, 32_768) &&
            boundedNumber(targetBox.width, 0, 16_384) &&
            boundedNumber(targetBox.height, 0, 16_384)
          ) {
            projectedInteraction.targetBox = {
              x: targetBox.x,
              y: targetBox.y,
              width: targetBox.width,
              height: targetBox.height,
            };
          }
        }
        projected.interaction = projectedInteraction;
      }
    }
    if (
      source.artifact &&
      typeof source.artifact === 'object' &&
      !Array.isArray(source.artifact)
    ) {
      const artifact = source.artifact as Record<string, unknown>;
      if (
        typeof artifact.id === 'string' &&
        /^[a-f0-9]{64}$/.test(artifact.id) &&
        artifact.sha256 === artifact.id &&
        artifact.kind === 'image' &&
        artifact.mimeType === 'image/png' &&
        typeof artifact.size === 'number' &&
        Number.isSafeInteger(artifact.size) &&
        artifact.size >= 0 &&
        artifact.size <= MAX_BROWSER_SCREENSHOT_BYTES &&
        artifact.persisted === true
      ) {
        projected.artifact = {
          id: artifact.id,
          sha256: artifact.sha256,
          kind: artifact.kind,
          mimeType: artifact.mimeType,
          size: artifact.size,
          persisted: true,
          ...(typeof artifact.path === 'string' &&
          Buffer.byteLength(artifact.path) <= 8_192
            ? { path: artifact.path }
            : {}),
        };
      }
    }
    return {
      ...(typeof sanitized.summary === 'string'
        ? { summary: sanitized.summary.slice(0, 512) }
        : {}),
      browser: projected,
      ...(toolAdmission ? { tool_admission: toolAdmission } : {}),
    } as ToolResultMetadata;
  }
  if (toolName === 'Bash') {
    const projected: Record<string, unknown> = {};
    const stringFields = ['message', 'signal', 'status', 'summary'] as const;
    const booleanFields = [
      'aborted',
      'acp_mode',
      'admission_failed',
      'auto_backgrounded',
      'background',
      'capture_truncated',
      'finalization_failed',
      'has_stderr',
      'output_accounting_complete',
      'output_truncated',
      'projection_truncated',
      'sandbox_required',
      'sandboxed',
      'stderr_projection_truncated',
      'stdout_projection_truncated',
      'terminal_output_merged',
      'timeout',
    ] as const;
    const numberFields = [
      'execution_time',
      'foreground_budget_ms',
      'pid',
      'raw_output_bytes',
      'stderr_length',
      'stderr_omitted_bytes',
      'stderr_retained_bytes',
      'stderr_total_bytes',
      'stdout_length',
      'stdout_omitted_bytes',
      'stdout_retained_bytes',
      'stdout_total_bytes',
    ] as const;
    for (const field of stringFields) {
      const value = sanitized[field];
      if (typeof value === 'string') projected[field] = value.slice(0, 8_192);
    }
    for (const field of booleanFields) {
      const value = sanitized[field];
      if (typeof value === 'boolean') projected[field] = value;
    }
    for (const field of numberFields) {
      const value = sanitized[field];
      if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
        projected[field] = value;
      }
    }
    if (
      sanitized.exit_code === null ||
      (typeof sanitized.exit_code === 'number' &&
        Number.isSafeInteger(sanitized.exit_code))
    ) {
      projected.exit_code = sanitized.exit_code;
    }
    if (
      sanitized.terminal_transport === 'local' ||
      sanitized.terminal_transport === 'acp' ||
      sanitized.terminal_transport === 'local_fallback'
    ) {
      projected.terminal_transport = sanitized.terminal_transport;
    }
    if (
      sanitized.background_reason === 'explicit' ||
      sanitized.background_reason === 'foreground_budget'
    ) {
      projected.background_reason = sanitized.background_reason;
    }
    for (const field of ['bash_id', 'shell_id'] as const) {
      const value = sanitized[field];
      if (
        typeof value === 'string' &&
        value.length <= 128 &&
        /^bash_[A-Za-z0-9-]+$/.test(value)
      ) {
        projected[field] = value;
      }
    }
    if (toolAdmission) projected.tool_admission = toolAdmission;
    const backgroundAdmission = sanitized.background_shell_admission;
    if (
      backgroundAdmission &&
      typeof backgroundAdmission === 'object' &&
      !Array.isArray(backgroundAdmission)
    ) {
      const value = backgroundAdmission as Record<string, unknown>;
      if (
        value.code === 'background_shell_busy' &&
        (value.scope === 'session' || value.scope === 'global') &&
        value.retryable === true &&
        Number.isSafeInteger(value.limit) &&
        (value.limit as number) > 0
      ) {
        projected.background_shell_admission = {
          code: value.code,
          scope: value.scope,
          retryable: value.retryable,
          limit: value.limit,
        };
      }
    }
    return projected as ToolResultMetadata;
  }
  const MAX_INLINE_CONTENT = 200000;
  const safeInteger = (value: unknown, maximum: number): number =>
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= maximum
      ? value
      : 0;
  if (
    typeof sanitized.oldContent === 'string' &&
    sanitized.oldContent.length > MAX_INLINE_CONTENT
  ) {
    delete sanitized.oldContent;
  }
  if (
    typeof sanitized.newContent === 'string' &&
    sanitized.newContent.length > MAX_INLINE_CONTENT
  ) {
    delete sanitized.newContent;
  }
  if (
    sanitized.mcpResult &&
    typeof sanitized.mcpResult === 'object' &&
    !Array.isArray(sanitized.mcpResult)
  ) {
    const result = sanitized.mcpResult as Record<string, unknown>;
    const artifacts = Array.isArray(result.artifacts)
      ? result.artifacts.slice(0, 64).flatMap((value) => {
          if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
          const artifact = value as Record<string, unknown>;
          const artifactKinds = new Set(['text', 'image', 'audio', 'resource']);
          if (
            typeof artifact.id !== 'string' ||
            !/^[a-f0-9]{64}$/.test(artifact.id) ||
            typeof artifact.sha256 !== 'string' ||
            artifact.sha256 !== artifact.id ||
            typeof artifact.kind !== 'string' ||
            !artifactKinds.has(artifact.kind) ||
            safeInteger(artifact.size, 64 * 1024 * 1024) !== artifact.size ||
            typeof artifact.persisted !== 'boolean'
          ) {
            return [];
          }
          return [
            {
              id: artifact.id.slice(0, 128),
              sha256: artifact.sha256.slice(0, 128),
              kind: artifact.kind,
              size: artifact.size,
              persisted: artifact.persisted,
              ...(typeof artifact.mimeType === 'string'
                ? { mimeType: artifact.mimeType.slice(0, 256) }
                : {}),
              ...(typeof artifact.sourceUri === 'string'
                ? { sourceUri: artifact.sourceUri.slice(0, 8_192) }
                : {}),
              ...(typeof artifact.path === 'string'
                ? { path: artifact.path.slice(0, 8_192) }
                : {}),
            },
          ];
        })
      : [];
    sanitized.mcpResult = {
      isError: result.isError === true,
      contentCount: safeInteger(result.contentCount, 64),
      textBytes: safeInteger(result.textBytes, 4 * 1024 * 1024),
      structuredBytes: safeInteger(result.structuredBytes, 4 * 1024 * 1024),
      artifactCount: safeInteger(result.artifactCount, 64),
      truncated: result.truncated === true,
      binaryOmitted: result.binaryOmitted === true,
      artifacts,
    };
  } else {
    delete sanitized.mcpResult;
  }
  return sanitized as ToolResultMetadata;
}
