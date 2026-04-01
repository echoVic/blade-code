function detectTerminal(): string | undefined {
  const term = process.env['TERM_PROGRAM']
  if (term === 'iTerm.app') return 'iterm'
  if (term === 'WezTerm') return 'wezterm'
  if (process.env['KITTY_WINDOW_ID'] || process.env['TERM']?.includes('kitty'))
    return 'kitty'
  if (process.env['TERM']?.includes('ghostty') || term === 'ghostty')
    return 'ghostty'
  return term?.toLowerCase()
}

export const env = {
  terminal: detectTerminal(),
}
