import type { Lod } from '../scene/lod';
import type { Language, Panel } from '../workspace/types';
import { LANGUAGE_COLOR } from '../workspace/types';

export type Rgba = [number, number, number, number];

export const THEME = {
  background: [0.027, 0.035, 0.051] as const,
  grid: [0.20, 0.27, 0.40] as const,
  text: [0.84, 0.89, 0.96] as const,
  textMuted: [0.58, 0.65, 0.76] as const,
  selection: [0.44, 0.67, 1.0] as const,
  hover: [0.62, 0.78, 1.0] as const,
  dirty: [0.96, 0.96, 1.0] as const,
  git: {
    clean: null,
    modified: [0.95, 0.68, 0.22] as const,
    added: [0.32, 0.82, 0.50] as const,
    deleted: [0.94, 0.36, 0.36] as const,
  },
};

function normalize(rgb: readonly [number, number, number]): [number, number, number] {
  return [rgb[0] / 255, rgb[1] / 255, rgb[2] / 255];
}

function lighten(rgb: [number, number, number], amount: number): [number, number, number] {
  return [
    Math.min(1, rgb[0] + amount),
    Math.min(1, rgb[1] + amount),
    Math.min(1, rgb[2] + amount),
  ];
}

export function panelFill(panel: Panel, lod: Lod): Rgba {
  const base = normalize(LANGUAGE_COLOR[panel.language]);
  const variance = 0.9 + ((panel.id * 37) % 11) * 0.014;
  const lodScale = lod === 0 ? 0.72 : lod === 1 ? 0.92 : 1;
  return [
    base[0] * variance * lodScale,
    base[1] * variance * lodScale,
    base[2] * variance * lodScale,
    1,
  ];
}

export function panelBorder(panel: Panel, lod: Lod): Rgba {
  const fill = panelFill(panel, lod);
  const git = THEME.git[panel.git];
  if (panel.dirty) {
    return [THEME.dirty[0], THEME.dirty[1], THEME.dirty[2], 0.95];
  }
  if (git) {
    return [git[0], git[1], git[2], 0.95];
  }
  const lit = lighten([fill[0], fill[1], fill[2]], 0.14);
  return [lit[0], lit[1], lit[2], lod === 0 ? 0.55 : 0.8];
}

export function languageAccent(language: Language): [number, number, number] {
  return normalize(LANGUAGE_COLOR[language]);
}
