import { useSyncExternalStore } from 'react'
import type { AppState } from './AppState.js'
import { vanillaStore } from './vanilla.js'

export function useAppState<T>(selector: (s: AppState) => T): T {
  return useSyncExternalStore(
    vanillaStore.subscribe,
    () => selector(flattenState(vanillaStore.getState())),
    () => selector(flattenState(vanillaStore.getState()))
  )
}

function flattenState(zustandState: any): AppState {
  const { session, app, config, focus, command, spec } = zustandState

  return {
    ...session,
    ...app,
    ...config,
    ...focus,
    ...command,

    specIsActive: spec.isActive,
    specError: spec.error,
    currentSpec: spec.currentSpec,
    specPath: spec.specPath,
    steeringContext: spec.steeringContext,
    recentSpecs: spec.recentSpecs,
    isLoading: spec.isLoading,
    workspaceRoot: spec.workspaceRoot,

    ...session.actions,
    setSessionError: session.actions.setError,
    ...app.actions,
    ...config.actions,
    ...focus.actions,
    ...command.actions,
    ...spec.actions,
    setSpecError: spec.actions.setError,
    resetSpec: spec.actions.reset,
  } as AppState
}
