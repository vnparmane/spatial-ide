import type { Bounds, Group, Panel } from '../workspace/types';
import { GROUP_HEADER, GROUP_PAD } from './layout';

/**
 * Fits a directory frame around its member panels after manual moves.
 * The frame keeps the same padding and header height as the automatic layout.
 */
export function fitGroupBounds(group: Group, panels: readonly Panel[]): void {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const panelId of group.panelIds) {
    const panel = panels[panelId];
    if (!panel) continue;
    minX = Math.min(minX, panel.x);
    minY = Math.min(minY, panel.y);
    maxX = Math.max(maxX, panel.x + panel.w);
    maxY = Math.max(maxY, panel.y + panel.h);
  }

  // An empty group keeps its previous frame rather than collapsing to a point.
  if (minX === Infinity) return;

  group.x = minX - GROUP_PAD;
  group.y = minY - GROUP_HEADER;
  group.w = maxX - minX + GROUP_PAD * 2;
  group.h = maxY - minY + GROUP_HEADER + GROUP_PAD;
}

/** Recomputes the world bounds from the current group frames. */
export function fitWorkspaceBounds(groups: readonly Group[]): Bounds {
  if (groups.length === 0) return { x: 0, y: 0, w: 1, h: 1 };

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const group of groups) {
    minX = Math.min(minX, group.x);
    minY = Math.min(minY, group.y);
    maxX = Math.max(maxX, group.x + group.w);
    maxY = Math.max(maxY, group.y + group.h);
  }

  return {
    x: minX,
    y: minY,
    w: Math.max(1, maxX - minX),
    h: Math.max(1, maxY - minY),
  };
}
