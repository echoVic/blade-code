let segmenter: Intl.Segmenter | undefined

export function getGraphemeSegmenter(): Intl.Segmenter {
  segmenter ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  return segmenter
}
