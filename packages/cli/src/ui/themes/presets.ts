import presets from './presets.json';
import type { Theme } from './types.js';

export interface ThemeItem {
  id: string;
  label: string;
  theme: Theme;
  description?: string;
  author?: string;
  tags?: string[];
}

export const themes: ThemeItem[] = presets;
