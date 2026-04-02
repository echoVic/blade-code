export {
  default,
  Align,
  Direction,
  Display,
  Edge,
  FlexDirection,
  Gutter,
  Justify,
  MeasureMode,
  Overflow,
  PositionType,
  Wrap,
  type Node,
} from 'yoga-layout'

export function getYogaCounters() {
  return { visited: 0, measured: 0, cacheHits: 0, live: 0 }
}
