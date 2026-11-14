import type { Bounds, Group, Panel } from '../workspace/types';

const PANEL_GAP = 12;
export const GROUP_PAD = 26;
export const GROUP_HEADER = 38;
const GROUP_MAX_WIDTH = 2200;
const GROUP_GAP = 84;
const GROUP_ROW_WIDTH = 24000;

/**
 * Deterministic directory-grid layout for phase 0.
 * Panels are shelf-packed inside their group, then groups are shelf-packed
 * into the world. Replaced by the real layout engine in a later phase.
 */
export function layoutWorkspace(panels: Panel[], groups: Group[]): Bounds {
  for (const group of groups) {
    let cursorX = GROUP_PAD;
    let cursorY = GROUP_PAD + GROUP_HEADER;
    let rowHeight = 0;
    let maxX = 0;

    for (const panelId of group.panelIds) {
      const panel = panels[panelId];
      if (!panel) continue;
      if (cursorX > GROUP_PAD && cursorX + panel.w > GROUP_MAX_WIDTH) {
        cursorX = GROUP_PAD;
        cursorY += rowHeight + PANEL_GAP;
        rowHeight = 0;
      }
      panel.x = cursorX;
      panel.y = cursorY;
      cursorX += panel.w + PANEL_GAP;
      rowHeight = Math.max(rowHeight, panel.h);
      maxX = Math.max(maxX, panel.x + panel.w);
    }

    group.w = maxX + GROUP_PAD;
    group.h = cursorY + rowHeight + GROUP_PAD;
  }

  let groupX = 0;
  let groupY = 0;
  let groupRowHeight = 0;

  for (const group of groups) {
    if (groupX > 0 && groupX + group.w > GROUP_ROW_WIDTH) {
      groupX = 0;
      groupY += groupRowHeight + GROUP_GAP;
      groupRowHeight = 0;
    }
    for (const panelId of group.panelIds) {
      const panel = panels[panelId];
      if (!panel) continue;
      panel.x += groupX;
      panel.y += groupY;
    }
    group.x = groupX;
    group.y = groupY;
    groupX += group.w + GROUP_GAP;
    groupRowHeight = Math.max(groupRowHeight, group.h);
  }

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
