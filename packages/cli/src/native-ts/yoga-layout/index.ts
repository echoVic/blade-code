export { default } from 'yoga-layout'
export * from 'yoga-layout'

export function getYogaCounters() {
  return { visited: 0, measured: 0, cacheHits: 0, live: 0 }
}
