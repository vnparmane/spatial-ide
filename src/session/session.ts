import { hashString } from '../util/math';
import type { Workspace } from '../workspace/types';

export interface SessionCamera {
  x: number;
  y: number;
  zoom: number;
}

export interface SessionState {
  fingerprint: string;
  camera: SessionCamera;
  selectedId: number;
}

const STORAGE_KEY = 'spatial-ide.session.v1';

/**
 * Cheap identity for a workspace. Paths plus the root name avoid restoring a
 * camera into a different folder that happens to have the same name.
 */
export function workspaceFingerprint(workspace: Workspace): string {
  let hash = hashString(workspace.rootPath);
  for (const panel of workspace.panels) {
    hash = (Math.imul(hash, 31) + hashString(panel.path)) >>> 0;
  }
  return `${workspace.rootPath}:${workspace.panels.length}:${hash.toString(36)}`;
}

function isValidCamera(value: unknown): value is SessionCamera {
  if (typeof value !== 'object' || value === null) return false;
  const camera = value as Partial<SessionCamera>;
  return (
    Number.isFinite(camera.x) &&
    Number.isFinite(camera.y) &&
    Number.isFinite(camera.zoom) &&
    (camera.zoom ?? 0) > 0
  );
}

export function loadSession(workspace: Workspace): SessionState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SessionState>;
    if (parsed.fingerprint !== workspaceFingerprint(workspace)) return null;
    if (!isValidCamera(parsed.camera)) return null;

    const selectedId =
      typeof parsed.selectedId === 'number' &&
      Number.isInteger(parsed.selectedId) &&
      parsed.selectedId >= 0 &&
      parsed.selectedId < workspace.panels.length
        ? parsed.selectedId
        : -1;

    return {
      fingerprint: parsed.fingerprint,
      camera: parsed.camera,
      selectedId,
    };
  } catch {
    return null;
  }
}

export function saveSession(
  workspace: Workspace,
  camera: SessionCamera,
  selectedId: number,
): void {
  try {
    const state: SessionState = {
      fingerprint: workspaceFingerprint(workspace),
      camera: {
        x: Math.round(camera.x * 100) / 100,
        y: Math.round(camera.y * 100) / 100,
        zoom: Math.round(camera.zoom * 100000) / 100000,
      },
      selectedId,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage can be unavailable in private mode; persistence is best-effort.
  }
}
