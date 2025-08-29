/**
 * 内置主题预设
 */
import { Theme } from './theme.js';

// Ayu Dark 主题
export const ayuDark: Theme = {
  name: 'ayu-dark',
  colors: {
    primary: '#ffcc66',
    secondary: '#bae67e',
    accent: '#73d0ff',
    success: '#bae67e',
    warning: '#ffcc66',
    error: '#ff3333',
    info: '#73d0ff',
    light: '#f0f0f0',
    dark: '#000000',
    muted: '#5c6773',
    highlight: '#2d323b',
    text: {
      primary: '#e6e1cf',
      secondary: '#bae67e',
      muted: '#5c6773',
      light: '#ffffff',
    },
    background: {
      primary: '#0f1419',
      secondary: '#14191f',
      dark: '#000000',
    },
    border: {
      light: '#2d323b',
      dark: '#000000',
    },
  },
  spacing: {
    xs: 0.25,
    sm: 0.5,
    md: 1,
    lg: 1.5,
    xl: 2,
  },
  typography: {
    fontSize: {
      xs: 0.75,
      sm: 0.875,
      base: 1,
      lg: 1.125,
      xl: 1.25,
      '2xl': 1.5,
      '3xl': 1.875,
    },
    fontWeight: {
      light: 300,
      normal: 400,
      medium: 500,
      semibold: 600,
      bold: 700,
    },
  },
  borderRadius: {
    sm: 0.125,
    base: 0.25,
    lg: 0.5,
    xl: 0.75,
  },
  boxShadow: {
    sm: '0 1px 2px 0 rgba(0, 0, 0, 0.2)',
    base: '0 1px 3px 0 rgba(0, 0, 0, 0.3), 0 1px 2px 0 rgba(0, 0, 0, 0.2)',
    lg: '0 10px 15px -3px rgba(0, 0, 0, 0.3), 0 4px 6px -2px rgba(0, 0, 0, 0.2)',
  },
};

// Dracula 主题
export const dracula: Theme = {
  name: 'dracula',
  colors: {
    primary: '#bd93f9',
    secondary: '#ffb86c',
    accent: '#ff79c6',
    success: '#50fa7b',
    warning: '#f1fa8c',
    error: '#ff5555',
    info: '#8be9fd',
    light: '#f8f8f2',
    dark: '#282a36',
    muted: '#6272a4',
    highlight: '#44475a',
    text: {
      primary: '#f8f8f2',
      secondary: '#f1fa8c',
      muted: '#6272a4',
      light: '#ffffff',
    },
    background: {
      primary: '#282a36',
      secondary: '#44475a',
      dark: '#21222c',
    },
    border: {
      light: '#44475a',
      dark: '#000000',
    },
  },
  spacing: {
    xs: 0.25,
    sm: 0.5,
    md: 1,
    lg: 1.5,
    xl: 2,
  },
  typography: {
    fontSize: {
      xs: 0.75,
      sm: 0.875,
      base: 1,
      lg: 1.125,
      xl: 1.25,
      '2xl': 1.5,
      '3xl': 1.875,
    },
    fontWeight: {
      light: 300,
      normal: 400,
      medium: 500,
      semibold: 600,
      bold: 700,
    },
  },
  borderRadius: {
    sm: 0.125,
    base: 0.25,
    lg: 0.5,
    xl: 0.75,
  },
  boxShadow: {
    sm: '0 1px 2px 0 rgba(40, 42, 54, 0.2)',
    base: '0 1px 3px 0 rgba(40, 42, 54, 0.3), 0 1px 2px 0 rgba(40, 42, 54, 0.2)',
    lg: '0 10px 15px -3px rgba(40, 42, 54, 0.3), 0 4px 6px -2px rgba(40, 42, 54, 0.2)',
  },
};

// Monokai 主题
export const monokai: Theme = {
  name: 'monokai',
  colors: {
    primary: '#66d9ef',
    secondary: '#a6e22e',
    accent: '#f92672',
    success: '#a6e22e',
    warning: '#e6db74',
    error: '#f92672',
    info: '#66d9ef',
    light: '#f8f8f2',
    dark: '#272822',
    muted: '#75715e',
    highlight: '#3e3d32',
    text: {
      primary: '#f8f8f2',
      secondary: '#e6db74',
      muted: '#75715e',
      light: '#ffffff',
    },
    background: {
      primary: '#272822',
      secondary: '#3e3d32',
      dark: '#1e1f1c',
    },
    border: {
      light: '#3e3d32',
      dark: '#000000',
    },
  },
  spacing: {
    xs: 0.25,
    sm: 0.5,
    md: 1,
    lg: 1.5,
    xl: 2,
  },
  typography: {
    fontSize: {
      xs: 0.75,
      sm: 0.875,
      base: 1,
      lg: 1.125,
      xl: 1.25,
      '2xl': 1.5,
      '3xl': 1.875,
    },
    fontWeight: {
      light: 300,
      normal: 400,
      medium: 500,
      semibold: 600,
      bold: 700,
    },
  },
  borderRadius: {
    sm: 0.125,
    base: 0.25,
    lg: 0.5,
    xl: 0.75,
  },
  boxShadow: {
    sm: '0 1px 2px 0 rgba(39, 40, 34, 0.2)',
    base: '0 1px 3px 0 rgba(39, 40, 34, 0.3), 0 1px 2px 0 rgba(39, 40, 34, 0.2)',
    lg: '0 10px 15px -3px rgba(39, 40, 34, 0.3), 0 4px 6px -2px rgba(39, 40, 34, 0.2)',
  },
};

// Nord 主题
export const nord: Theme = {
  name: 'nord',
  colors: {
    primary: '#88c0d0',
    secondary: '#81a1c1',
    accent: '#b48ead',
    success: '#a3be8c',
    warning: '#ebcb8b',
    error: '#bf616a',
    info: '#88c0d0',
    light: '#eceff4',
    dark: '#2e3440',
    muted: '#4c566a',
    highlight: '#434c5e',
    text: {
      primary: '#eceff4',
      secondary: '#d8dee9',
      muted: '#4c566a',
      light: '#ffffff',
    },
    background: {
      primary: '#2e3440',
      secondary: '#3b4252',
      dark: '#242933',
    },
    border: {
      light: '#434c5e',
      dark: '#000000',
    },
  },
  spacing: {
    xs: 0.25,
    sm: 0.5,
    md: 1,
    lg: 1.5,
    xl: 2,
  },
  typography: {
    fontSize: {
      xs: 0.75,
      sm: 0.875,
      base: 1,
      lg: 1.125,
      xl: 1.25,
      '2xl': 1.5,
      '3xl': 1.875,
    },
    fontWeight: {
      light: 300,
      normal: 400,
      medium: 500,
      semibold: 600,
      bold: 700,
    },
  },
  borderRadius: {
    sm: 0.125,
    base: 0.25,
    lg: 0.5,
    xl: 0.75,
  },
  boxShadow: {
    sm: '0 1px 2px 0 rgba(46, 52, 64, 0.2)',
    base: '0 1px 3px 0 rgba(46, 52, 64, 0.3), 0 1px 2px 0 rgba(46, 52, 64, 0.2)',
    lg: '0 10px 15px -3px rgba(46, 52, 64, 0.3), 0 4px 6px -2px rgba(46, 52, 64, 0.2)',
  },
};

// Solarized Light 主题
export const solarizedLight: Theme = {
  name: 'solarized-light',
  colors: {
    primary: '#268bd2',
    secondary: '#2aa198',
    accent: '#d33682',
    success: '#859900',
    warning: '#b58900',
    error: '#dc322f',
    info: '#268bd2',
    light: '#fdf6e3',
    dark: '#073642',
    muted: '#93a1a1',
    highlight: '#eee8d5',
    text: {
      primary: '#586e75',
      secondary: '#657b83',
      muted: '#93a1a1',
      light: '#002b36',
    },
    background: {
      primary: '#fdf6e3',
      secondary: '#eee8d5',
      dark: '#073642',
    },
    border: {
      light: '#eee8d5',
      dark: '#073642',
    },
  },
  spacing: {
    xs: 0.25,
    sm: 0.5,
    md: 1,
    lg: 1.5,
    xl: 2,
  },
  typography: {
    fontSize: {
      xs: 0.75,
      sm: 0.875,
      base: 1,
      lg: 1.125,
      xl: 1.25,
      '2xl': 1.5,
      '3xl': 1.875,
    },
    fontWeight: {
      light: 300,
      normal: 400,
      medium: 500,
      semibold: 600,
      bold: 700,
    },
  },
  borderRadius: {
    sm: 0.125,
    base: 0.25,
    lg: 0.5,
    xl: 0.75,
  },
  boxShadow: {
    sm: '0 1px 2px 0 rgba(253, 246, 227, 0.2)',
    base: '0 1px 3px 0 rgba(253, 246, 227, 0.3), 0 1px 2px 0 rgba(253, 246, 227, 0.2)',
    lg: '0 10px 15px -3px rgba(253, 246, 227, 0.3), 0 4px 6px -2px rgba(253, 246, 227, 0.2)',
  },
};

// Solarized Dark 主题
export const solarizedDark: Theme = {
  name: 'solarized-dark',
  colors: {
    primary: '#268bd2',
    secondary: '#2aa198',
    accent: '#d33682',
    success: '#859900',
    warning: '#b58900',
    error: '#dc322f',
    info: '#268bd2',
    light: '#fdf6e3',
    dark: '#073642',
    muted: '#586e75',
    highlight: '#073642',
    text: {
      primary: '#839496',
      secondary: '#93a1a1',
      muted: '#586e75',
      light: '#fdf6e3',
    },
    background: {
      primary: '#002b36',
      secondary: '#073642',
      dark: '#001f29',
    },
    border: {
      light: '#073642',
      dark: '#000000',
    },
  },
  spacing: {
    xs: 0.25,
    sm: 0.5,
    md: 1,
    lg: 1.5,
    xl: 2,
  },
  typography: {
    fontSize: {
      xs: 0.75,
      sm: 0.875,
      base: 1,
      lg: 1.125,
      xl: 1.25,
      '2xl': 1.5,
      '3xl': 1.875,
    },
    fontWeight: {
      light: 300,
      normal: 400,
      medium: 500,
      semibold: 600,
      bold: 700,
    },
  },
  borderRadius: {
    sm: 0.125,
    base: 0.25,
    lg: 0.5,
    xl: 0.75,
  },
  boxShadow: {
    sm: '0 1px 2px 0 rgba(0, 43, 54, 0.2)',
    base: '0 1px 3px 0 rgba(0, 43, 54, 0.3), 0 1px 2px 0 rgba(0, 43, 54, 0.2)',
    lg: '0 10px 15px -3px rgba(0, 43, 54, 0.3), 0 4px 6px -2px rgba(0, 43, 54, 0.2)',
  },
};

// Tokyo Night 主题
export const tokyoNight: Theme = {
  name: 'tokyo-night',
  colors: {
    primary: '#7aa2f7',
    secondary: '#7dcfff',
    accent: '#bb9af7',
    success: '#9ece6a',
    warning: '#e0af68',
    error: '#f7768e',
    info: '#7aa2f7',
    light: '#c0caf5',
    dark: '#1a1b26',
    muted: '#565f89',
    highlight: '#292e42',
    text: {
      primary: '#a9b1d6',
      secondary: '#c0caf5',
      muted: '#565f89',
      light: '#ffffff',
    },
    background: {
      primary: '#1a1b26',
      secondary: '#292e42',
      dark: '#16161e',
    },
    border: {
      light: '#292e42',
      dark: '#000000',
    },
  },
  spacing: {
    xs: 0.25,
    sm: 0.5,
    md: 1,
    lg: 1.5,
    xl: 2,
  },
  typography: {
    fontSize: {
      xs: 0.75,
      sm: 0.875,
      base: 1,
      lg: 1.125,
      xl: 1.25,
      '2xl': 1.5,
      '3xl': 1.875,
    },
    fontWeight: {
      light: 300,
      normal: 400,
      medium: 500,
      semibold: 600,
      bold: 700,
    },
  },
  borderRadius: {
    sm: 0.125,
    base: 0.25,
    lg: 0.5,
    xl: 0.75,
  },
  boxShadow: {
    sm: '0 1px 2px 0 rgba(26, 27, 38, 0.2)',
    base: '0 1px 3px 0 rgba(26, 27, 38, 0.3), 0 1px 2px 0 rgba(26, 27, 38, 0.2)',
    lg: '0 10px 15px -3px rgba(26, 27, 38, 0.3), 0 4px 6px -2px rgba(26, 27, 38, 0.2)',
  },
};

// GitHub 主题
export const github: Theme = {
  name: 'github',
  colors: {
    primary: '#0969da',
    secondary: '#8250df',
    accent: '#bc4c00',
    success: '#1a7f37',
    warning: '#9a6700',
    error: '#d1242f',
    info: '#0969da',
    light: '#f6f8fa',
    dark: '#24292f',
    muted: '#6e7781',
    highlight: '#ddf4ff',
    text: {
      primary: '#24292f',
      secondary: '#57606a',
      muted: '#6e7781',
      light: '#ffffff',
    },
    background: {
      primary: '#ffffff',
      secondary: '#f6f8fa',
      dark: '#24292f',
    },
    border: {
      light: '#d0d7de',
      dark: '#24292f',
    },
  },
  spacing: {
    xs: 0.25,
    sm: 0.5,
    md: 1,
    lg: 1.5,
    xl: 2,
  },
  typography: {
    fontSize: {
      xs: 0.75,
      sm: 0.875,
      base: 1,
      lg: 1.125,
      xl: 1.25,
      '2xl': 1.5,
      '3xl': 1.875,
    },
    fontWeight: {
      light: 300,
      normal: 400,
      medium: 500,
      semibold: 600,
      bold: 700,
    },
  },
  borderRadius: {
    sm: 0.125,
    base: 0.25,
    lg: 0.5,
    xl: 0.75,
  },
  boxShadow: {
    sm: '0 1px 2px 0 rgba(255, 255, 255, 0.2)',
    base: '0 1px 3px 0 rgba(255, 255, 255, 0.3), 0 1px 2px 0 rgba(255, 255, 255, 0.2)',
    lg: '0 10px 15px -3px rgba(255, 255, 255, 0.3), 0 4px 6px -2px rgba(255, 255, 255, 0.2)',
  },
};

// Gruvbox 主题
export const gruvbox: Theme = {
  name: 'gruvbox',
  colors: {
    primary: '#83a598',
    secondary: '#8ec07c',
    accent: '#d3869b',
    success: '#b8bb26',
    warning: '#fabd2f',
    error: '#fb4934',
    info: '#83a598',
    light: '#fbf1c7',
    dark: '#282828',
    muted: '#928374',
    highlight: '#3c3836',
    text: {
      primary: '#ebdbb2',
      secondary: '#d5c4a1',
      muted: '#928374',
      light: '#ffffff',
    },
    background: {
      primary: '#282828',
      secondary: '#3c3836',
      dark: '#1d2021',
    },
    border: {
      light: '#3c3836',
      dark: '#000000',
    },
  },
  spacing: {
    xs: 0.25,
    sm: 0.5,
    md: 1,
    lg: 1.5,
    xl: 2,
  },
  typography: {
    fontSize: {
      xs: 0.75,
      sm: 0.875,
      base: 1,
      lg: 1.125,
      xl: 1.25,
      '2xl': 1.5,
      '3xl': 1.875,
    },
    fontWeight: {
      light: 300,
      normal: 400,
      medium: 500,
      semibold: 600,
      bold: 700,
    },
  },
  borderRadius: {
    sm: 0.125,
    base: 0.25,
    lg: 0.5,
    xl: 0.75,
  },
  boxShadow: {
    sm: '0 1px 2px 0 rgba(40, 40, 40, 0.2)',
    base: '0 1px 3px 0 rgba(40, 40, 40, 0.3), 0 1px 2px 0 rgba(40, 40, 40, 0.2)',
    lg: '0 10px 15px -3px rgba(40, 40, 40, 0.3), 0 4px 6px -2px rgba(40, 40, 40, 0.2)',
  },
};

// One Dark 主题
export const oneDark: Theme = {
  name: 'one-dark',
  colors: {
    primary: '#61afef',
    secondary: '#c678dd',
    accent: '#e5c07b',
    success: '#98c379',
    warning: '#e5c07b',
    error: '#e06c75',
    info: '#56b6c2',
    light: '#abb2bf',
    dark: '#282c34',
    muted: '#5c6370',
    highlight: '#3e4451',
    text: {
      primary: '#abb2bf',
      secondary: '#c6c8d0',
      muted: '#5c6370',
      light: '#ffffff',
    },
    background: {
      primary: '#282c34',
      secondary: '#3e4451',
      dark: '#21252b',
    },
    border: {
      light: '#3e4451',
      dark: '#000000',
    },
  },
  spacing: {
    xs: 0.25,
    sm: 0.5,
    md: 1,
    lg: 1.5,
    xl: 2,
  },
  typography: {
    fontSize: {
      xs: 0.75,
      sm: 0.875,
      base: 1,
      lg: 1.125,
      xl: 1.25,
      '2xl': 1.5,
      '3xl': 1.875,
    },
    fontWeight: {
      light: 300,
      normal: 400,
      medium: 500,
      semibold: 600,
      bold: 700,
    },
  },
  borderRadius: {
    sm: 0.125,
    base: 0.25,
    lg: 0.5,
    xl: 0.75,
  },
  boxShadow: {
    sm: '0 1px 2px 0 rgba(40, 44, 52, 0.2)',
    base: '0 1px 3px 0 rgba(40, 44, 52, 0.3), 0 1px 2px 0 rgba(40, 44, 52, 0.2)',
    lg: '0 10px 15px -3px rgba(40, 44, 52, 0.3), 0 4px 6px -2px rgba(40, 44, 52, 0.2)',
  },
};

// Catppuccin 主题
export const catppuccin: Theme = {
  name: 'catppuccin',
  colors: {
    primary: '#89b4fa',
    secondary: '#cba6f7',
    accent: '#f5c2e7',
    success: '#a6e3a1',
    warning: '#f9e2af',
    error: '#f38ba8',
    info: '#89dceb',
    light: '#cdd6f4',
    dark: '#11111b',
    muted: '#6c7086',
    highlight: '#181825',
    text: {
      primary: '#cdd6f4',
      secondary: '#bac2de',
      muted: '#6c7086',
      light: '#ffffff',
    },
    background: {
      primary: '#1e1e2e',
      secondary: '#181825',
      dark: '#11111b',
    },
    border: {
      light: '#181825',
      dark: '#000000',
    },
  },
  spacing: {
    xs: 0.25,
    sm: 0.5,
    md: 1,
    lg: 1.5,
    xl: 2,
  },
  typography: {
    fontSize: {
      xs: 0.75,
      sm: 0.875,
      base: 1,
      lg: 1.125,
      xl: 1.25,
      '2xl': 1.5,
      '3xl': 1.875,
    },
    fontWeight: {
      light: 300,
      normal: 400,
      medium: 500,
      semibold: 600,
      bold: 700,
    },
  },
  borderRadius: {
    sm: 0.125,
    base: 0.25,
    lg: 0.5,
    xl: 0.75,
  },
  boxShadow: {
    sm: '0 1px 2px 0 rgba(30, 30, 46, 0.2)',
    base: '0 1px 3px 0 rgba(30, 30, 46, 0.3), 0 1px 2px 0 rgba(30, 30, 46, 0.2)',
    lg: '0 10px 15px -3px rgba(30, 30, 46, 0.3), 0 4px 6px -2px rgba(30, 30, 46, 0.2)',
  },
};

// Rose Pine 主题
export const rosePine: Theme = {
  name: 'rose-pine',
  colors: {
    primary: '#9ccfd8',
    secondary: '#c4a7e7',
    accent: '#f6c177',
    success: '#31748f',
    warning: '#f6c177',
    error: '#eb6f92',
    info: '#9ccfd8',
    light: '#e0def4',
    dark: '#191724',
    muted: '#6e6a86',
    highlight: '#1f1d2e',
    text: {
      primary: '#e0def4',
      secondary: '#cecacd',
      muted: '#6e6a86',
      light: '#ffffff',
    },
    background: {
      primary: '#191724',
      secondary: '#1f1d2e',
      dark: '#12101a',
    },
    border: {
      light: '#1f1d2e',
      dark: '#000000',
    },
  },
  spacing: {
    xs: 0.25,
    sm: 0.5,
    md: 1,
    lg: 1.5,
    xl: 2,
  },
  typography: {
    fontSize: {
      xs: 0.75,
      sm: 0.875,
      base: 1,
      lg: 1.125,
      xl: 1.25,
      '2xl': 1.5,
      '3xl': 1.875,
    },
    fontWeight: {
      light: 300,
      normal: 400,
      medium: 500,
      semibold: 600,
      bold: 700,
    },
  },
  borderRadius: {
    sm: 0.125,
    base: 0.25,
    lg: 0.5,
    xl: 0.75,
  },
  boxShadow: {
    sm: '0 1px 2px 0 rgba(25, 23, 36, 0.2)',
    base: '0 1px 3px 0 rgba(25, 23, 36, 0.3), 0 1px 2px 0 rgba(25, 23, 36, 0.2)',
    lg: '0 10px 15px -3px rgba(25, 23, 36, 0.3), 0 4px 6px -2px rgba(25, 23, 36, 0.2)',
  },
};

// Kanagawa 主题
export const kanagawa: Theme = {
  name: 'kanagawa',
  colors: {
    primary: '#8ba4b0',
    secondary: '#a292a3',
    accent: '#c47fd5',
    success: '#76946a',
    warning: '#c0a36e',
    error: '#c34043',
    info: '#7e9cd8',
    light: '#dcd7ba',
    dark: '#1f1f28',
    muted: '#727169',
    highlight: '#2a2a37',
    text: {
      primary: '#dcd7ba',
      secondary: '#c8c093',
      muted: '#727169',
      light: '#ffffff',
    },
    background: {
      primary: '#1f1f28',
      secondary: '#2a2a37',
      dark: '#16161d',
    },
    border: {
      light: '#2a2a37',
      dark: '#000000',
    },
  },
  spacing: {
    xs: 0.25,
    sm: 0.5,
    md: 1,
    lg: 1.5,
    xl: 2,
  },
  typography: {
    fontSize: {
      xs: 0.75,
      sm: 0.875,
      base: 1,
      lg: 1.125,
      xl: 1.25,
      '2xl': 1.5,
      '3xl': 1.875,
    },
    fontWeight: {
      light: 300,
      normal: 400,
      medium: 500,
      semibold: 600,
      bold: 700,
    },
  },
  borderRadius: {
    sm: 0.125,
    base: 0.25,
    lg: 0.5,
    xl: 0.75,
  },
  boxShadow: {
    sm: '0 1px 2px 0 rgba(31, 31, 40, 0.2)',
    base: '0 1px 3px 0 rgba(31, 31, 40, 0.3), 0 1px 2px 0 rgba(31, 31, 40, 0.2)',
    lg: '0 10px 15px -3px rgba(31, 31, 40, 0.3), 0 4px 6px -2px rgba(31, 31, 40, 0.2)',
  },
};

// 导出所有主题
export const themes = {
  'ayu-dark': ayuDark,
  dracula: dracula,
  monokai: monokai,
  nord: nord,
  'solarized-light': solarizedLight,
  'solarized-dark': solarizedDark,
  'tokyo-night': tokyoNight,
  github: github,
  gruvbox: gruvbox,
  'one-dark': oneDark,
  catppuccin: catppuccin,
  'rose-pine': rosePine,
  kanagawa: kanagawa,
};
