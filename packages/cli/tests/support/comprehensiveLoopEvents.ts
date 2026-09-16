import type { LoopEvent } from '../../src/agent/loop/types.js';
import events from './comprehensiveLoopEvents.json';
import routeEvents from './sessionRouteLoopEvents.json';

export function comprehensiveLoopEvents(): LoopEvent[] {
  return structuredClone(events) as LoopEvent[];
}

export function sessionRouteLoopEvents(): LoopEvent[] {
  return structuredClone(routeEvents) as LoopEvent[];
}
