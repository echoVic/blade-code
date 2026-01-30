import type { Monaco } from '@monaco-editor/react';

interface ThemeColors {
  background: { primary: string; secondary: string }
  text: { primary: string; secondary: string; muted: string }
  border: { light: string }
  syntax: {
    comment: string; string: string; number: string; keyword: string
    function: string; variable: string; operator: string; type: string
    tag: string; attr: string; default: string
  }
}

const themePresets: Record<string, ThemeColors> = {
  'ayu-dark': {
    background: { primary: '#0f1419', secondary: '#14191f' },
    text: { primary: '#e6e1cf', secondary: '#bae67e', muted: '#5c6773' },
    border: { light: '#2d323b' },
    syntax: { comment: '#5c6773', string: '#bae67e', number: '#ffcc66', keyword: '#ff8f40', function: '#73d0ff', variable: '#e6e1cf', operator: '#f29e74', type: '#73d0ff', tag: '#ff8f40', attr: '#ffd580', default: '#e6e1cf' },
  },
  'dracula': {
    background: { primary: '#282a36', secondary: '#44475a' },
    text: { primary: '#f8f8f2', secondary: '#f1fa8c', muted: '#6272a4' },
    border: { light: '#44475a' },
    syntax: { comment: '#6272a4', string: '#f1fa8c', number: '#bd93f9', keyword: '#ff79c6', function: '#50fa7b', variable: '#f8f8f2', operator: '#ff79c6', type: '#8be9fd', tag: '#ff79c6', attr: '#50fa7b', default: '#f8f8f2' },
  },
  'monokai': {
    background: { primary: '#272822', secondary: '#3e3d32' },
    text: { primary: '#f8f8f2', secondary: '#e6db74', muted: '#75715e' },
    border: { light: '#3e3d32' },
    syntax: { comment: '#75715e', string: '#e6db74', number: '#ae81ff', keyword: '#f92672', function: '#a6e22e', variable: '#f8f8f2', operator: '#f92672', type: '#66d9ef', tag: '#f92672', attr: '#a6e22e', default: '#f8f8f2' },
  },
  'nord': {
    background: { primary: '#2e3440', secondary: '#3b4252' },
    text: { primary: '#eceff4', secondary: '#d8dee9', muted: '#4c566a' },
    border: { light: '#434c5e' },
    syntax: { comment: '#616e88', string: '#a3be8c', number: '#b48ead', keyword: '#81a1c1', function: '#88c0d0', variable: '#d8dee9', operator: '#81a1c1', type: '#8fbcbb', tag: '#81a1c1', attr: '#8fbcbb', default: '#eceff4' },
  },
  'solarized-light': {
    background: { primary: '#fdf6e3', secondary: '#eee8d5' },
    text: { primary: '#586e75', secondary: '#657b83', muted: '#93a1a1' },
    border: { light: '#eee8d5' },
    syntax: { comment: '#93a1a1', string: '#2aa198', number: '#d33682', keyword: '#859900', function: '#268bd2', variable: '#657b83', operator: '#859900', type: '#b58900', tag: '#268bd2', attr: '#93a1a1', default: '#657b83' },
  },
  'solarized-dark': {
    background: { primary: '#002b36', secondary: '#073642' },
    text: { primary: '#839496', secondary: '#93a1a1', muted: '#586e75' },
    border: { light: '#073642' },
    syntax: { comment: '#586e75', string: '#2aa198', number: '#d33682', keyword: '#859900', function: '#268bd2', variable: '#839496', operator: '#859900', type: '#b58900', tag: '#268bd2', attr: '#93a1a1', default: '#839496' },
  },
  'tokyo-night': {
    background: { primary: '#1a1b26', secondary: '#292e42' },
    text: { primary: '#a9b1d6', secondary: '#c0caf5', muted: '#565f89' },
    border: { light: '#292e42' },
    syntax: { comment: '#565f89', string: '#9ece6a', number: '#ff9e64', keyword: '#bb9af7', function: '#7aa2f7', variable: '#c0caf5', operator: '#89ddff', type: '#7dcfff', tag: '#f7768e', attr: '#7aa2f7', default: '#a9b1d6' },
  },
  'github': {
    background: { primary: '#ffffff', secondary: '#f6f8fa' },
    text: { primary: '#24292f', secondary: '#57606a', muted: '#6e7781' },
    border: { light: '#d0d7de' },
    syntax: { comment: '#6e7781', string: '#0a3069', number: '#0550ae', keyword: '#cf222e', function: '#8250df', variable: '#24292f', operator: '#cf222e', type: '#0550ae', tag: '#116329', attr: '#0550ae', default: '#24292f' },
  },
  'gruvbox': {
    background: { primary: '#282828', secondary: '#3c3836' },
    text: { primary: '#ebdbb2', secondary: '#d5c4a1', muted: '#928374' },
    border: { light: '#3c3836' },
    syntax: { comment: '#928374', string: '#b8bb26', number: '#d3869b', keyword: '#fb4934', function: '#b8bb26', variable: '#ebdbb2', operator: '#fe8019', type: '#fabd2f', tag: '#fb4934', attr: '#fabd2f', default: '#ebdbb2' },
  },
  'one-dark': {
    background: { primary: '#282c34', secondary: '#21252b' },
    text: { primary: '#abb2bf', secondary: '#e5c07b', muted: '#5c6370' },
    border: { light: '#3e4451' },
    syntax: { comment: '#5c6370', string: '#98c379', number: '#d19a66', keyword: '#c678dd', function: '#61afef', variable: '#e06c75', operator: '#56b6c2', type: '#e5c07b', tag: '#e06c75', attr: '#d19a66', default: '#abb2bf' },
  },
  'catppuccin': {
    background: { primary: '#1e1e2e', secondary: '#313244' },
    text: { primary: '#cdd6f4', secondary: '#f5e0dc', muted: '#6c7086' },
    border: { light: '#313244' },
    syntax: { comment: '#6c7086', string: '#a6e3a1', number: '#fab387', keyword: '#cba6f7', function: '#89b4fa', variable: '#f5e0dc', operator: '#89dceb', type: '#f9e2af', tag: '#f38ba8', attr: '#f9e2af', default: '#cdd6f4' },
  },
  'rose-pine': {
    background: { primary: '#191724', secondary: '#1f1d2e' },
    text: { primary: '#e0def4', secondary: '#908caa', muted: '#6e6a86' },
    border: { light: '#26233a' },
    syntax: { comment: '#6e6a86', string: '#f6c177', number: '#ebbcba', keyword: '#c4a7e7', function: '#9ccfd8', variable: '#e0def4', operator: '#31748f', type: '#eb6f92', tag: '#eb6f92', attr: '#c4a7e7', default: '#e0def4' },
  },
  'kanagawa': {
    background: { primary: '#1f1f28', secondary: '#2a2a37' },
    text: { primary: '#dcd7ba', secondary: '#c8c093', muted: '#727169' },
    border: { light: '#2a2a37' },
    syntax: { comment: '#727169', string: '#98bb6c', number: '#d27e99', keyword: '#957fb8', function: '#7e9cd8', variable: '#dcd7ba', operator: '#c0a36e', type: '#7aa89f', tag: '#e46876', attr: '#ffa066', default: '#dcd7ba' },
  },
}

function isColorDark(hex: string): boolean {
  const color = hex.replace('#', '')
  const r = parseInt(color.substring(0, 2), 16)
  const g = parseInt(color.substring(2, 4), 16)
  const b = parseInt(color.substring(4, 6), 16)
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.5
}

function createMonacoThemeData(colors: ThemeColors) {
  const isDark = isColorDark(colors.background.primary)
  const base: 'vs' | 'vs-dark' | 'hc-black' = isDark ? 'vs-dark' : 'vs'
  return {
    base,
    inherit: true,
    rules: [
      { token: '', foreground: colors.text.primary.replace('#', ''), background: colors.background.primary.replace('#', '') },
      { token: 'comment', foreground: colors.syntax.comment.replace('#', ''), fontStyle: 'italic' },
      { token: 'string', foreground: colors.syntax.string.replace('#', '') },
      { token: 'number', foreground: colors.syntax.number.replace('#', '') },
      { token: 'keyword', foreground: colors.syntax.keyword.replace('#', '') },
      { token: 'type', foreground: colors.syntax.type.replace('#', '') },
      { token: 'identifier', foreground: colors.syntax.variable.replace('#', '') },
      { token: 'function', foreground: colors.syntax.function.replace('#', '') },
      { token: 'variable', foreground: colors.syntax.variable.replace('#', '') },
      { token: 'operator', foreground: colors.syntax.operator.replace('#', '') },
      { token: 'delimiter', foreground: colors.syntax.operator.replace('#', '') },
      { token: 'tag', foreground: colors.syntax.tag.replace('#', '') },
      { token: 'attribute.name', foreground: colors.syntax.attr.replace('#', '') },
      { token: 'attribute.value', foreground: colors.syntax.string.replace('#', '') },
    ],
    colors: {
      'editor.background': colors.background.primary,
      'editor.foreground': colors.text.primary,
      'editor.lineHighlightBackground': colors.background.secondary,
      'editor.selectionBackground': `${colors.syntax.function}40`,
      'editorLineNumber.foreground': colors.text.muted,
      'editorLineNumber.activeForeground': colors.text.secondary,
      'editorCursor.foreground': colors.text.primary,
      'editorIndentGuide.background': colors.border.light,
      'editorWidget.background': colors.background.secondary,
      'editorWidget.border': colors.border.light,
      'scrollbarSlider.background': `${colors.text.muted}40`,
      'scrollbarSlider.hoverBackground': `${colors.text.muted}60`,
    },
  }
}

const registeredThemes = new Set<string>()

export function registerMonacoTheme(monaco: Monaco, themeName: string): string {
  const normalizedName = themeName.toLowerCase().replace(/\s+/g, '-')
  const colors = themePresets[normalizedName]
  
  if (!colors) {
    return 'vs-dark'
  }
  
  if (!registeredThemes.has(normalizedName)) {
    const themeData = createMonacoThemeData(colors)
    monaco.editor.defineTheme(normalizedName, themeData)
    registeredThemes.add(normalizedName)
  }
  
  return normalizedName
}

export function getAvailableThemes(): string[] {
  return Object.keys(themePresets)
}
