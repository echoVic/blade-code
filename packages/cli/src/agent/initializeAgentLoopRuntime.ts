import { PermissionMode } from '../config/index.js';
import { createLogger, LogCategory } from '../logging/Logger.js';
import { injectSkillsMetadata } from '../skills/index.js';
import type { AgentLoopRuntimeInitDependencies } from './agentLoopDependencyTypes.js';
import { buildLoopMetadata, resolveLoopControl } from './loopControl.js';
import { createLoopErrorResult, createLoopSuccessResult } from './loopResult.js';
import type { LoopControl } from './loopControl.js';
import type {
  ChatContext,
  LoopOptions,
  LoopResult,
  LoopResultMetadataInput,
} from './types.js';
import type { FunctionDeclaration } from '../tools/types/index.js';

const logger = createLogger(LogCategory.AGENT);

export function initializeAgentLoopRuntime({
  context,
  options,
  dependencies,
}: {
  context: ChatContext;
  options?: LoopOptions;
  dependencies: AgentLoopRuntimeInitDependencies;
}): {
  loopControl: LoopControl;
  tools: FunctionDeclaration[];
  createLoopMetadata(
    metadata: LoopResultMetadataInput
  ): NonNullable<LoopResult['metadata']>;
  createErrorResult(params: {
    type: NonNullable<LoopResult['error']>['type'];
    message: string;
    details?: unknown;
    metadata: LoopResultMetadataInput;
  }): LoopResult;
  createSuccessResult(params: {
    finalMessage?: string;
    metadata: LoopResultMetadataInput;
  }): LoopResult;
} {
  const loopControl = resolveLoopControl({
    runtimeMaxTurns: dependencies.runtimeOptions.maxTurns,
    optionMaxTurns: options?.maxTurns,
    configMaxTurns: dependencies.config.maxTurns,
    permissionMode: context.permissionMode,
  });
  const registry = dependencies.executionPipeline.getRegistry();
  const permissionMode = context.permissionMode as PermissionMode | undefined;
  let rawTools = registry.getFunctionDeclarationsByMode(permissionMode);
  rawTools = injectSkillsMetadata(rawTools);
  const tools = dependencies.applySkillToolRestrictions(rawTools);

  if (permissionMode === PermissionMode.PLAN) {
    const readOnlyTools = registry.getReadOnlyTools();
    logger.debug(
      `🔒 Plan mode: 使用只读工具 (${readOnlyTools.length} 个): ${readOnlyTools.map((t) => t.name).join(', ')}`
    );
  }

  return {
    loopControl,
    tools,
    createLoopMetadata: (metadata: LoopResultMetadataInput) =>
      buildLoopMetadata(loopControl, metadata),
    createErrorResult: (params) => createLoopErrorResult(loopControl, params),
    createSuccessResult: (params) => createLoopSuccessResult(loopControl, params),
  };
}
