import stripAnsi from 'strip-ansi'

export default function sliceAnsi(
  text: string,
  begin: number,
  end?: number,
): string {
  const stripped = stripAnsi(text)
  const sliced = stripped.slice(begin, end)
  return sliced
}
