import type { Workspace } from '../workspace/types';

export interface StoredPanelPosition {
  x: number;
  y: number;
}

interface StoredLayout {
  positions: Record<string, StoredPanelPosition>;
  updatedAt: number;
}

/** One layout per workspace root, keyed by folder name. */
type LayoutStore = Record<string, StoredLayout>;

const STORAGE_KEY = 'spatial-ide.layouts.v1';

function readStore(): LayoutStore {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return {};
    return parsed as LayoutStore;
  } catch {
    return {};
  }
}

function writeStore(store: LayoutStore): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // Storage can be unavailable or full; arrangement persistence is best-effort.
  }
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Returns saved panel positions for a workspace root, if any are valid. */
export function loadPanelPositions(
  rootPath: string,
): Record<string, StoredPanelPosition> | null {
  const record = readStore()[rootPath];
  if (!record || typeof record.positions !== 'object') return null;

  const positions: Record<string, StoredPanelPosition> = {};
  for (const [path, position] of Object.entries(record.positions)) {
    if (Number.isFinite(position?.x) && Number.isFinite(position?.y)) {
      positions[path] = { x: position.x, y: position.y };
    }
  }
  return Object.keys(positions).length > 0 ? positions : null;
}

/**
 * Saves current panel positions. When `paths` is provided only those panels are
 * written, merging with the existing layout so untouched panels stay put.
 * Positions for files that no longer exist are pruned.
 */
export function savePanelPositions(workspace: Workspace, paths?: readonly string[]): void {
  const store = readStore();
  const existing = store[workspace.rootPath]?.positions ?? {};
  const byPath = new Map(workspace.panels.map((panel) => [panel.path, panel]));

  const positions: Record<string, StoredPanelPosition> = {};
  for (const [path, position] of Object.entries(existing)) {
    if (byPath.has(path)) positions[path] = position;
  }

  const updated = paths ?? [...byPath.keys()];
  for (const path of updated) {
    const panel = byPath.get(path);
    if (!panel) continue;
    positions[path] = { x: round(panel.x), y: round(panel.y) };
  }

  store[workspace.rootPath] = { positions, updatedAt: Date.now() };
  writeStore(store);
}

/** Forgets the saved arrangement so the automatic layout applies again. */
export function clearPanelPositions(rootPath: string): void {
  const store = readStore();
  if (!(rootPath in store)) return;
  delete store[rootPath];
  writeStore(store);
}
