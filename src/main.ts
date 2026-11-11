import './style.css';
import { DraftStore } from './editor/draftStore';
import { EditorOverlay, type EditorFocus } from './editor/editorOverlay';
import { InputController, isEditableTarget } from './input/input';
import { Camera } from './scene/camera';
import { SpatialHash } from './scene/spatial';
import { Renderer } from './render/renderer';
import { loadSession, saveSession } from './session/session';
import { TokenStore } from './tokens/tokenStore';
import { createHud } from './ui/hud';
import { createLoadingOverlay } from './ui/loading';
import { createMinimap } from './ui/minimap';
import { createQuickOpen } from './ui/quickOpen';
import { createSearch } from './ui/search';
import { formatInt } from './util/math';
import { FsAccessProvider } from './workspace/fsAccess';
import {
  directoryPermission,
  loadDirectoryHandle,
  requestDirectoryPermission,
  saveDirectoryHandle,
} from './workspace/handleStore';
import { createMockWorkspace } from './workspace/mock';
import { MockProvider } from './workspace/mockProvider';
import type { ScanProgress, WorkspaceProvider } from './workspace/provider';
import type { Panel, Workspace } from './workspace/types';

const canvas = document.getElementById('canvas');
if (!(canvas instanceof HTMLCanvasElement)) {
  throw new Error('Missing #canvas element');
}

function buildSpatial(workspace: Workspace): SpatialHash {
  const spatial = new SpatialHash(workspace.panels.length);
  for (const panel of workspace.panels) {
    spatial.insert(panel.id, panel.x, panel.y, panel.w, panel.h);
  }
  return spatial;
}

let workspace = createMockWorkspace();
let spatial = buildSpatial(workspace);
let provider: WorkspaceProvider = new MockProvider(workspace);

const camera = new Camera();
const tokens = new TokenStore((path) => provider.readText(path));
const renderer = new Renderer(canvas, workspace, spatial, tokens);
const input = new InputController(canvas, camera, workspace, spatial);
const loading = createLoadingOverlay();
const hud = createHud(workspace.rootPath, workspace.panels.length, workspace.groups.length, {
  onOpenFolder: () => {
    void openFolder();
  },
  onNewFile: () => {
    void createNewFile();
  },
  onRefresh: () => {
    void refreshWorkspace();
  },
});
const minimap = createMinimap(workspace, (worldX, worldY) => camera.centerOn(worldX, worldY));

const editor = new EditorOverlay({
  readText: (path) => provider.readText(path),
  writeText: async (path, content) => {
    await provider.writeText(path, content);
    const panel = workspace.panels.find((candidate) => candidate.path === path);
    if (!panel) return;
    tokens.set(panel.path, panel.language, content);
    const status = await provider.gitStatus?.(path, content);
    if (status) panel.git = status;
  },
  stat: (path) => provider.stat?.(path) ?? Promise.resolve(undefined),
  getDiagnostics: (path) => tokens.getDiagnostics(path),
  onDocSettled: (panel, text) => tokens.set(panel.path, panel.language, text),
  onDirtyChange: () => {},
  onContentReplaced: (panel, text) => {
    tokens.set(panel.path, panel.language, text);
    void provider.gitStatus?.(panel.path, text).then((status) => {
      if (status) panel.git = status;
    });
  },
});

tokens.onDiagnostics((path, diagnostics) => editor.setDiagnostics(path, diagnostics));
editor.setDraftPersistence(new DraftStore(workspace.rootPath));

const quickOpen = createQuickOpen({
  getPanels: () => workspace.panels,
  onPick: (panel) => activatePanel(panel),
});

const search = createSearch({
  getPanels: () => workspace.panels,
  readText: (path) => provider.readText(path),
  onPick: (panel, line, column) => activatePanel(panel, { line, column }),
});

/** Camera flight plus editor mount, shared by double-click and quick-open. */
function activatePanel(panel: Panel, focus?: EditorFocus): void {
  input.selectedId = panel.id;
  camera.focusRect(panel, 72);

  // Guarantee the panel crosses the edit LOD even when it is short or narrow.
  const editWidth = Math.min(900, camera.vw * 0.86);
  const editZoom = Math.min(camera.maxZoom, editWidth / panel.w);
  if (camera.tzoom < editZoom) camera.tzoom = editZoom;

  void editor.open(panel, camera, focus);
}

input.onActivate = activatePanel;

window.addEventListener(
  'keydown',
  (event) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
    if (event.key.toLowerCase() !== 'p') return;
    event.preventDefault();
    if (search.isOpen) search.close();
    if (quickOpen.isOpen) quickOpen.close();
    else quickOpen.open();
  },
  { capture: true },
);

window.addEventListener(
  'keydown',
  (event) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    if (!event.shiftKey || event.key.toLowerCase() !== 'f') return;
    event.preventDefault();
    if (search.isOpen) search.close();
    else {
      quickOpen.close();
      search.open();
    }
  },
  { capture: true },
);

// File operations only fire from the canvas, never while typing or searching.
window.addEventListener('keydown', (event) => {
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
  if (quickOpen.isOpen || isEditableTarget(event.target)) return;
  if (!(provider instanceof FsAccessProvider)) return;

  if (event.key === 'n' || event.key === 'N') {
    event.preventDefault();
    void createNewFile();
    return;
  }
  if (event.key === 'F2') {
    event.preventDefault();
    void renameSelectedFile();
    return;
  }
  if (event.key === 'Delete') {
    event.preventDefault();
    void deleteSelectedFile();
  }
});

/** Restores the last camera for this workspace, or fits the whole map. */
function restoreOrFit(nextWorkspace: Workspace): void {
  const session = loadSession(nextWorkspace);
  if (session) {
    camera.tx = session.camera.x;
    camera.ty = session.camera.y;
    camera.tzoom = session.camera.zoom;
    camera.snap();
    input.selectedId = session.selectedId;
    return;
  }

  input.selectedId = -1;
  camera.focusRect(nextWorkspace.bounds, 72);
  camera.snap();
}

camera.resize(renderer.viewportWidth, renderer.viewportHeight);
restoreOrFit(workspace);

interface ApplyView {
  camera: { x: number; y: number; zoom: number };
  selectedPath: string | null;
  focusPath?: string;
  /** Reopens this file after the rescan, e.g. manual Refresh. */
  openPath?: string | null;
}

function applyWorkspace(
  nextWorkspace: Workspace,
  nextProvider: WorkspaceProvider,
  view?: ApplyView,
): void {
  editor.reset();
  editor.setDraftPersistence(new DraftStore(nextWorkspace.rootPath));
  tokens.reset();
  provider = nextProvider;
  workspace = nextWorkspace;
  spatial = buildSpatial(workspace);

  renderer.setWorkspace(workspace, spatial);
  input.setWorkspace(workspace, spatial);
  hud.setWorkspace(workspace.rootPath, workspace.panels.length, workspace.groups.length);
  hud.setFileActionsEnabled(nextProvider instanceof FsAccessProvider);
  minimap.setWorkspace(workspace);
  search.reset();

  camera.resize(renderer.viewportWidth, renderer.viewportHeight);
  if (!view) {
    restoreOrFit(workspace);
    return;
  }

  camera.tx = view.camera.x;
  camera.ty = view.camera.y;
  camera.tzoom = view.camera.zoom;
  camera.snap();

  const selected = view.selectedPath
    ? workspace.panels.find((panel) => panel.path === view.selectedPath)
    : null;
  input.selectedId = selected ? selected.id : -1;

  const openPath = view.focusPath ?? view.openPath ?? null;
  if (openPath) {
    const panel = workspace.panels.find((candidate) => candidate.path === openPath);
    if (panel) activatePanel(panel);
  }
}

function workspaceScanDetail(progress: ScanProgress): string {
  return progress.phase === 'layout'
    ? `Laying out ${formatInt(progress.files)} files…`
    : `Scanning… ${formatInt(progress.files)} files · ${formatInt(progress.folders)} folders`;
}

async function openDirectoryHandle(
  handle: FileSystemDirectoryHandle,
  requestAccess: boolean,
): Promise<boolean> {
  if (requestAccess) {
    const granted = await requestDirectoryPermission(handle);
    if (!granted) {
      loading.fail(`Access to "${handle.name}" was not granted.`);
      return false;
    }
  }

  loading.show('Opening workspace', `Scanning ${handle.name}…`);
  try {
    const nextProvider = new FsAccessProvider(handle);
    const nextWorkspace = await nextProvider.load((progress) => {
      loading.setDetail(workspaceScanDetail(progress));
    });

    applyWorkspace(nextWorkspace, nextProvider);
    await saveDirectoryHandle(handle);
    hud.setReopenFolder(handle.name, () => {
      void openDirectoryHandle(handle, true);
    });
    loading.hide();
    return true;
  } catch (error) {
    console.error(error);
    loading.fail(error instanceof Error ? error.message : 'Unknown error');
    return false;
  }
}

async function openFolder(): Promise<void> {
  try {
    const nextProvider = await FsAccessProvider.pick();
    if (!nextProvider) return;
    await openDirectoryHandle(nextProvider.directory, false);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      loading.hide();
      return;
    }
    console.error(error);
    loading.fail(error instanceof Error ? error.message : 'Unknown error');
  }
}

/** Reopens the last folder when the browser still grants access. */
async function bootStoredFolder(): Promise<void> {
  const handle = await loadDirectoryHandle();
  if (!handle) return;

  hud.setReopenFolder(handle.name, () => {
    void openDirectoryHandle(handle, true);
  });

  if ((await directoryPermission(handle)) === 'granted') {
    await openDirectoryHandle(handle, false);
  }
}

let refreshing = false;

/** Rescans the active folder, keeping the camera and selected file stable. */
async function refreshWorkspace(focusPath?: string): Promise<boolean> {
  const currentProvider = provider;
  if (refreshing || !(currentProvider instanceof FsAccessProvider)) return false;

  refreshing = true;
  const view: ApplyView = {
    camera: camera.state(),
    selectedPath:
      input.selectedId >= 0 ? (workspace.panels[input.selectedId]?.path ?? null) : null,
    focusPath,
    openPath: editor.openPanel?.path ?? null,
  };
  loading.show('Refreshing workspace', `Scanning ${currentProvider.name}…`);
  try {
    const nextWorkspace = await currentProvider.load((progress) => {
      loading.setDetail(workspaceScanDetail(progress));
    });
    if (provider !== currentProvider) {
      loading.hide();
      return false;
    }

    applyWorkspace(nextWorkspace, currentProvider, view);
    loading.hide();
    return true;
  } catch (error) {
    console.error(error);
    loading.fail(error instanceof Error ? error.message : 'Unknown error');
    return false;
  } finally {
    refreshing = false;
  }
}

function normalizeFilePath(raw: string): string | null {
  const path = raw
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/\/+/g, '/');
  if (!path || path.startsWith('/') || path.endsWith('/')) return null;
  const segments = path.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return null;
  return path;
}

function defaultNewFilePath(): string {
  const selected = input.selectedId >= 0 ? workspace.panels[input.selectedId] : null;
  if (!selected) return 'untitled.ts';
  const slash = selected.path.lastIndexOf('/');
  return slash < 0 ? 'untitled.ts' : `${selected.path.slice(0, slash + 1)}untitled.ts`;
}

async function createNewFile(): Promise<void> {
  const currentProvider = provider;
  if (!(currentProvider instanceof FsAccessProvider)) {
    window.alert('Open a folder before creating files.');
    return;
  }

  const raw = window.prompt('New file path', defaultNewFilePath());
  if (raw === null) return;
  const path = normalizeFilePath(raw);
  if (!path) {
    window.alert('Enter a relative path such as src/new-file.ts');
    return;
  }

  try {
    await currentProvider.createFile(path, '');
    await refreshWorkspace(path);
  } catch (error) {
    window.alert(error instanceof Error ? error.message : String(error));
  }
}

async function renameSelectedFile(): Promise<void> {
  const currentProvider = provider;
  if (!(currentProvider instanceof FsAccessProvider)) return;

  const panel = input.selectedId >= 0 ? workspace.panels[input.selectedId] : null;
  if (!panel) {
    window.alert('Select a file panel to rename.');
    return;
  }
  if (panel.dirty) {
    window.alert('Save this file before renaming it.');
    return;
  }

  const raw = window.prompt(`Rename ${panel.path}`, panel.path);
  if (raw === null) return;
  const path = normalizeFilePath(raw);
  if (!path || path === panel.path) return;

  if (editor.openPanel?.path === panel.path) editor.close();
  try {
    await currentProvider.renameFile(panel.path, path);
    editor.discardDraft(panel.path);
    await refreshWorkspace(path);
  } catch (error) {
    window.alert(error instanceof Error ? error.message : String(error));
  }
}

async function deleteSelectedFile(): Promise<void> {
  const currentProvider = provider;
  if (!(currentProvider instanceof FsAccessProvider)) return;

  const panel = input.selectedId >= 0 ? workspace.panels[input.selectedId] : null;
  if (!panel) {
    window.alert('Select a file panel to delete.');
    return;
  }

  const message = panel.dirty
    ? `Delete ${panel.path}? Unsaved changes will be lost.`
    : `Delete ${panel.path}?`;
  if (!window.confirm(message)) return;

  if (editor.openPanel?.path === panel.path) editor.close();
  editor.discardDraft(panel.path);
  try {
    await currentProvider.deleteFile(panel.path);
    await refreshWorkspace();
  } catch (error) {
    window.alert(error instanceof Error ? error.message : String(error));
  }
}

void bootStoredFolder();

window.addEventListener('resize', () => {
  if (renderer.resize()) {
    camera.resize(renderer.viewportWidth, renderer.viewportHeight);
  }
});

if (import.meta.env.DEV) {
  (window as unknown as { __spatial: unknown }).__spatial = {
    get workspace() {
      return workspace;
    },
    get spatial() {
      return spatial;
    },
    get provider() {
      return provider;
    },
    camera,
    renderer,
    input,
    hud,
    minimap,
    editor,
    tokens,
    quickOpen,
    search,
    openFolder,
    openDirectoryHandle,
    bootStoredFolder,
    applyWorkspace,
    refreshWorkspace,
    createNewFile,
    renameSelectedFile,
    deleteSelectedFile,
  };
}

canvas.addEventListener('webglcontextlost', (event) => {
  event.preventDefault();
  console.error('WebGL context lost');
});

const persistSession = (): void => {
  editor.flushDrafts();
  saveSession(workspace, camera.state(), input.selectedId);
};

window.addEventListener('pagehide', persistSession);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') persistSession();
});

let lastTime = performance.now();
let fps = 60;
let frameMs = 0;
let hudTimer = 0;
let sessionTimer = 0;
let watchTimer = 0;

function frame(now: number): void {
  const dt = Math.min(0.1, Math.max(0, (now - lastTime) / 1000));
  lastTime = now;

  if (dt > 0) {
    fps += (1 / dt - fps) * 0.08;
  }

  camera.update(dt);
  minimap.update(camera, input.selectedId);
  editor.update(camera);

  watchTimer += dt;
  if (watchTimer >= 1.5) {
    watchTimer = 0;
    if (document.visibilityState === 'visible') void editor.pollExternal();
  }

  const start = performance.now();
  const stats = renderer.render(camera, input.hoveredId, input.selectedId);
  const elapsed = performance.now() - start;
  frameMs += (elapsed - frameMs) * 0.1;

  sessionTimer += dt;
  if (sessionTimer >= 1) {
    sessionTimer = 0;
    persistSession();
  }

  hudTimer += dt;
  if (hudTimer >= 0.2) {
    hudTimer = 0;
    const selected = input.selectedId >= 0 ? workspace.panels[input.selectedId]?.path ?? null : null;
    const hovered = input.hoveredId >= 0 ? workspace.panels[input.hoveredId]?.path ?? null : null;
    hud.update({
      fps,
      frameMs,
      ...stats,
      zoom: camera.zoom,
      cameraX: camera.x,
      cameraY: camera.y,
      selected,
      hovered,
    });
  }

  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
