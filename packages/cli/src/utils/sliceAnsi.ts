// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequence matching requires \x1b
const ANSI_REGEX = /\x1b\[[0-9;]*m/g

export default function sliceAnsi(
  text: string,
  begin: number,
  end?: number,
): string {
  let visibleIdx = 0
  let result = ''
  let openSeqs = ''
  let i = 0

  while (i < text.length) {
    ANSI_REGEX.lastIndex = i
    const match = ANSI_REGEX.exec(text)

    if (match && match.index === i) {
      if (visibleIdx >= begin && (end === undefined || visibleIdx < end)) {
        result += match[0]
      } else if (visibleIdx < begin) {
        openSeqs += match[0]
      }
      i += match[0].length
      continue
    }

    if (visibleIdx >= begin && (end === undefined || visibleIdx < end)) {
      if (result === '' && openSeqs) {
        result = openSeqs
        openSeqs = ''
      }
      result += text[i]
    }
    visibleIdx++
    i++

    if (end !== undefined && visibleIdx >= end) {
      while (i < text.length) {
        ANSI_REGEX.lastIndex = i
        const trailing = ANSI_REGEX.exec(text)
        if (trailing && trailing.index === i && trailing[0] === '\x1b[0m') {
          result += trailing[0]
          break
        }
        break
      }
      break
    }
  }

  if (result && !result.endsWith('\x1b[0m') && openSeqs) {
    result += '\x1b[0m'
  }

  return result
}
