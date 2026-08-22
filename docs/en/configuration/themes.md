# 🎨 Theme System

Blade ships with 13 built-in terminal themes, supporting runtime switching without a restart.

## Built-in Themes

| Theme Name | Style | Description |
|------------|-------|-------------|
| `github` | Light | GitHub style (default) |
| `ayu-dark` | Dark | Ayu dark theme |
| `dracula` | Dark | Classic Dracula theme |
| `monokai` | Dark | Classic Monokai theme |
| `nord` | Dark | Nord polar theme |
| `solarized-light` | Light | Solarized light |
| `solarized-dark` | Dark | Solarized dark |
| `tokyo-night` | Dark | Tokyo Night theme |
| `gruvbox` | Dark | Gruvbox retro theme |
| `one-dark` | Dark | Atom One Dark |
| `catppuccin` | Dark | Catppuccin soft theme |
| `rose-pine` | Dark | Rosé Pine theme |
| `kanagawa` | Dark | Kanagawa Japanese-style theme |

## Usage

### Configuration File Setting

Set it in `~/.blade/config.json` or `.blade/config.json`:

```json
{
  "codeTheme": "dracula"
}
```

The legacy `theme` field is automatically migrated to `codeTheme` at startup; the Web light/dark mode uses `uiTheme` independently.

### Runtime Switching

Type `/theme` in the interactive interface to open the theme selector:

```
/theme
```

Once selected, it takes effect immediately and is automatically saved to the configuration file.

## Theme Effects

Themes affect the following UI elements:

- **Text colors** - normal text, highlighted text, error prompts
- **Code highlighting** - syntax coloring, keywords, strings, comments
- **Border styles** - panel borders, dividers
- **Status indicators** - success, warning, error status colors
- **Background colors** - message area and input area backgrounds

## Theme Preview

### GitHub (default light)

```
┌─────────────────────────────────────┐
│ 🗡️ Blade Code                       │
│ Light background, clear contrast    │
│ Great for bright environments       │
└─────────────────────────────────────┘
```

### Dracula (dark)

```
┌─────────────────────────────────────┐
│ 🗡️ Blade Code                       │
│ Purple-toned dark theme             │
│ Easy on the eyes and elegant        │
└─────────────────────────────────────┘
```

### Tokyo Night (dark)

```
┌─────────────────────────────────────┐
│ 🗡️ Blade Code                       │
│ Blue-purple tones, modern feel      │
│ A popular editor theme              │
└─────────────────────────────────────┘
```

## Related Resources

- [Configuration System](/en/configuration/config-system.md) - Full configuration reference
- Theme source: `src/ui/themes/presets.ts`
