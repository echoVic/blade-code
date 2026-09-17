import type { Monaco } from '@monaco-editor/react';
import presets from '../../../src/ui/themes/presets.json';

interface ThemeColors {
  background: { primary: string; secondary: string };
  text: { primary: string; secondary: string; muted: string };
  border: { light: string };
  syntax: {
    comment: string;
    string: string;
    number: string;
    keyword: string;
    function: string;
    variable: string;
    operator: string;
    type: string;
    tag: string;
    attr: string;
    default: string;
  };
}

const themePresets = presets.reduce<Record<string, ThemeColors>>((themes, preset) => {
  themes[preset.id] = preset.theme.colors;
  return themes;
}, {});

function isColorDark(hex: string): boolean {
  const color = hex.replace('#', '');
  const r = parseInt(color.substring(0, 2), 16);
  const g = parseInt(color.substring(2, 4), 16);
  const b = parseInt(color.substring(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.5;
}

function createMonacoThemeData(colors: ThemeColors) {
  const isDark = isColorDark(colors.background.primary);
  const base: 'vs' | 'vs-dark' | 'hc-black' = isDark ? 'vs-dark' : 'vs';
  return {
    base,
    inherit: true,
    rules: [
      {
        token: '',
        foreground: colors.text.primary.replace('#', ''),
        background: colors.background.primary.replace('#', ''),
      },
      {
        token: 'comment',
        foreground: colors.syntax.comment.replace('#', ''),
        fontStyle: 'italic',
      },
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
  };
}

const registeredThemes = new Set<string>();

export function registerMonacoTheme(monaco: Monaco, themeName: string): string {
  const normalizedName = themeName.toLowerCase().replace(/\s+/g, '-');
  const colors = themePresets[normalizedName];

  if (!colors) {
    return 'vs-dark';
  }

  if (!registeredThemes.has(normalizedName)) {
    const themeData = createMonacoThemeData(colors);
    monaco.editor.defineTheme(normalizedName, themeData);
    registeredThemes.add(normalizedName);
  }

  return normalizedName;
}
