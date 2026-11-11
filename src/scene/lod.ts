export type Lod = 0 | 1 | 2 | 3;

export const LOD_THRESHOLDS = {
  l0Max: 40,
  l1Max: 220,
  l2Max: 700,
} as const;

const LOD_ENTER = [0, 44, 242, 770] as const;
const LOD_EXIT = [0, 36, 198, 630] as const;

/** Per-panel level of detail is driven by on-screen width, never global zoom. */
export function lodForScreenWidth(width: number): Lod {
  if (width < LOD_THRESHOLDS.l0Max) return 0;
  if (width < LOD_THRESHOLDS.l1Max) return 1;
  if (width < LOD_THRESHOLDS.l2Max) return 2;
  return 3;
}

/**
 * Hysteresis prevents flicker when a panel sits on a threshold during a zoom.
 * Enter and exit widths differ by roughly 10%.
 */
export function lodWithHysteresis(previous: Lod, width: number): Lod {
  let lod = previous;
  while (lod < 3 && width >= LOD_ENTER[lod + 1]) lod += 1;
  while (lod > 0 && width < LOD_EXIT[lod]) lod -= 1;
  return lod;
}

export const LOD_LABEL: Record<Lod, string> = {
  0: 'dot',
  1: 'overview',
  2: 'inspect',
  3: 'edit',
};
