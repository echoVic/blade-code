import type { SpecManager } from '../spec/SpecManager.js';
import type { SpecMetadata } from '../spec/types.js';

export interface SpecLoopContext {
  currentSpec: SpecMetadata | null;
  steeringContext: string | null;
}

export async function loadSpecLoopContext({
  specManager,
  workspaceRoot,
  onInitializationWarning,
}: {
  specManager: Pick<
    SpecManager,
    'initialize' | 'getCurrentSpec' | 'getSteeringContextString'
  >;
  workspaceRoot: string;
  onInitializationWarning: (error: unknown) => void;
}): Promise<SpecLoopContext> {
  try {
    await specManager.initialize(workspaceRoot);
  } catch (error) {
    onInitializationWarning(error);
  }

  return {
    currentSpec: specManager.getCurrentSpec(),
    steeringContext: await specManager.getSteeringContextString(),
  };
}
