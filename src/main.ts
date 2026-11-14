import './style.css';
import { SemanticStore } from './diagnostics/semanticStore';
import { DraftStore } from './editor/draftStore';
import { EditorOverlay, type EditorFocus } from './editor/editorOverlay';
import { InputController, isEditableTarget } from './input/input';
import { fitGroupBounds, fitWorkspaceBounds } from './scene/arrangement';
import { Camera } from './scene/camera';
import { layoutWorkspace } from './scene/layout';
import { SpatialHash } from './scene/spatial';
import { Renderer } from './render/renderer';
import {
  clearPanelPositions,
  loadPanelPositions,
  savePanelPositions,
} from './session/layoutStore';
import { loadSession, saveSession } from './session/session';
import { TokenStore } from './tokens/tokenStore';
import { createCommandPalette } from './ui/commandPalette';
import { createContextMenu, type ContextMenuEntry } from './ui/contextMenu';
import { createHud } from './ui/hud';
import { createLoadingOverlay } from './ui/loading';
import { createMinimap } from './ui/minimap';
import { createQuickOpen } from './ui/quickOpen';
import { createSearch } from './ui/search';
import { formatInt } from './util/math';
import { watchDirectory, type DirectoryWatcher } from './workspace/dirWatcher';
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
import type { Bounds, Panel, Workspace } from './workspace/types';

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

/**
 * Restores manually arranged panel positions for this folder, then refits the
 * directory frames and workspace bounds around them.
 */
function applySavedLayout(target: Workspace): void {
  const positions = loadPanelPositions(target.rootPath);
  if (!positions) return;

  let applied = 0;
  for (const panel of target.panels) {
    const position = positions[panel.path];
    if (!position) continue;
    panel.x = position.x;
    panel.y = position.y;
    applied += 1;
  }
  if (applied === 0) return;

  for (const group of target.groups) fitGroupBounds(group, target.panels);
  target.bounds = fitWorkspaceBounds(target.groups);
}

let workspace = createMockWorkspace();
applySavedLayout(workspace);
let spatial = buildSpatial(workspace);
let provider: WorkspaceProvider = new MockProvider(workspace);
let storedHandle: FileSystemDirectoryHandle | null = null;
let watchedProvider: FsAccessProvider | null = null;
let dirWatcher: DirectoryWatcher | null = null;
let syncTimer: number | null = null;

const camera = new Camera();
const tokens = new TokenStore((path) => provider.readText(path));
const semantics = new SemanticStore((path) => provider.readText(path));
semantics.onDiagnostics((path, diagnostics) => tokens.setSemantic(path, diagnostics));
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
    semantics.update(panel.path, panel.language, content);
    const status = await provider.gitStatus?.(path, content);
    if (status) panel.git = status;
  },
  stat: (path) => provider.stat?.(path) ?? Promise.resolve(undefined),
  getDiagnostics: (path) => tokens.getDiagnostics(path),
  onDocSettled: (panel, text) => {
    tokens.set(panel.path, panel.language, text);
    semantics.update(panel.path, panel.language, text);
  },
  onDirtyChange: () => {},
  onContentReplaced: (panel, text) => {
    tokens.set(panel.path, panel.language, text);
    semantics.update(panel.path, panel.language, text);
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

const commandPalette = createCommandPalette({
  getCommands: () => {
    const isFs = provider instanceof FsAccessProvider;
    const selectionCount = input.selectionCount;
    const hasSelection = selectionCount > 0;
    const singleSelection = selectionCount === 1;
    const handle = storedHandle;
    return [
      {
        id: 'open-folder',
        title: 'Open folder…',
        detail: 'Choose a folder from disk',
        run: openFolder,
      },
      ...(handle
        ? [
            {
              id: 'reopen-folder',
              title: `Reopen ${handle.name}`,
              detail: 'Request access to the last folder',
              run: () => {
                void openDirectoryHandle(handle, true);
              },
            },
          ]
        : []),
      {
        id: 'refresh',
        title: 'Refresh workspace',
        detail: 'Rescan the open folder',
        enabled: () => isFs,
        run: () => {
          void refreshWorkspace();
        },
      },
      {
        id: 'new-file',
        title: 'New file…',
        shortcut: 'n',
        enabled: () => isFs,
        run: createNewFile,
      },
      {
        id: 'rename-file',
        title: 'Rename selected file…',
        shortcut: 'F2',
        enabled: () => isFs && singleSelection,
        run: renameSelectedFile,
      },
      {
        id: 'delete-file',
        title: selectionCount > 1 ? `Delete ${selectionCount} selected files` : 'Delete selected file',
        shortcut: 'del',
        enabled: () => isFs && hasSelection,
        run: deleteSelectedFile,
      },
      {
        id: 'go-to-file',
        title: 'Go to file…',
        shortcut: 'ctrl+p',
        run: () => quickOpen.open(),
      },
      {
        id: 'search',
        title: 'Search in files…',
        shortcut: 'ctrl+shift+f',
        run: () => search.open(),
      },
      {
        id: 'save',
        title: 'Save file',
        shortcut: 'ctrl+s',
        enabled: () => editor.isOpen,
        run: () => {
          void editor.save();
        },
      },
      {
        id: 'close-editor',
        title: 'Close editor',
        shortcut: 'esc',
        enabled: () => editor.isOpen,
        run: () => editor.close(),
      },
      {
        id: 'fit',
        title: 'Fit workspace',
        shortcut: '0',
        run: () => camera.focusRect(workspace.bounds, 72),
      },
      {
        id: 'reset-layout',
        title: 'Reset panel layout',
        detail: 'Restore the automatic directory grid',
        run: resetLayout,
      },
      {
        id: 'zoom-100',
        title: 'Zoom to 100%',
        shortcut: '1',
        run: () => camera.setZoomAt(camera.vw / 2, camera.vh / 2, 1),
      },
      {
        id: 'center-selection',
        title: 'Center on selection',
        enabled: () => hasSelection,
        run: focusSelection,
      },
      {
        id: 'clear-selection',
        title: 'Clear selection',
        shortcut: 'esc',
        enabled: () => hasSelection,
        run: () => input.clearSelection(),
      },
    ];
  },
});

const panelMenu = createContextMenu();

/** World rect spanning every selected panel, or null when nothing is selected. */
function selectionBounds(): Bounds | null {
  const ids = input.selectedIds;
  if (ids.length === 0) return null;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const id of ids) {
    const panel = workspace.panels[id];
    if (!panel) continue;
    minX = Math.min(minX, panel.x);
    minY = Math.min(minY, panel.y);
    maxX = Math.max(maxX, panel.x + panel.w);
    maxY = Math.max(maxY, panel.y + panel.h);
  }
  if (minX === Infinity) return null;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function focusSelection(): void {
  const bounds = selectionBounds();
  if (bounds) camera.focusRect(bounds, 72);
}

/** Camera flight plus editor mount, shared by double-click and quick-open. */
function activatePanel(panel: Panel, focus?: EditorFocus): void {
  input.selectOnly(panel.id);
  camera.focusRect(panel, 72);

  // Guarantee the panel crosses the edit LOD even when it is short or narrow.
  const editWidth = Math.min(900, camera.vw * 0.86);
  const editZoom = Math.min(camera.maxZoom, editWidth / panel.w);
  if (camera.tzoom < editZoom) camera.tzoom = editZoom;

  void editor.open(panel, camera, focus);
}

input.onActivate = activatePanel;

/**
 * Commits a manual move: rebuilds the picking hash, refits world bounds,
 * refreshes the overview, and persists the new positions.
 */
input.onLayoutCommit = (paths) => {
  spatial = buildSpatial(workspace);
  renderer.setSpatial(spatial);
  input.setSpatial(spatial);
  workspace.bounds = fitWorkspaceBounds(workspace.groups);
  minimap.setWorkspace(workspace);
  savePanelPositions(workspace, paths);
};

/** Restores the automatic directory grid and forgets the saved arrangement. */
function resetLayout(): void {
  clearPanelPositions(workspace.rootPath);
  workspace.bounds = layoutWorkspace(workspace.panels, workspace.groups);
  spatial = buildSpatial(workspace);
  renderer.setSpatial(spatial);
  input.setSpatial(spatial);
  minimap.setWorkspace(workspace);
  camera.focusRect(workspace.bounds, 72);
}

function copyText(text: string): void {
  void navigator.clipboard.writeText(text).catch((error) => {
    console.warn('Could not copy to clipboard', error);
  });
}

input.onPanelContextMenu = (panel, x, y) => {
  if (!panel) return;
  if (!input.selectedIds.includes(panel.id)) input.selectOnly(panel.id);
  quickOpen.close();
  search.close();
  commandPalette.close();

  const isFs = provider instanceof FsAccessProvider;
  const isOpen = editor.openPanel?.path === panel.path;
  const selectionCount = input.selectionCount;
  const entries: ContextMenuEntry[] = [
    {
      label: 'Open in editor',
      shortcut: '↵',
      run: () => activatePanel(panel),
    },
    {
      label: selectionCount > 1 ? `Center on ${selectionCount} panels` : 'Center on panel',
      run: () => (selectionCount > 1 ? focusSelection() : camera.focusRect(panel, 72)),
    },
    { separator: true },
    {
      label: 'New file here…',
      shortcut: 'n',
      disabled: !isFs,
      run: () => createNewFile(panel.path),
    },
    {
      label: 'Rename…',
      shortcut: 'F2',
      disabled: !isFs || selectionCount !== 1,
      run: renameSelectedFile,
    },
    {
      label: selectionCount > 1 ? `Delete ${selectionCount} files` : 'Delete',
      shortcut: 'Del',
      disabled: !isFs,
      danger: true,
      run: deleteSelectedFile,
    },
    { separator: true },
    {
      label: 'Copy path',
      run: () => copyText(panel.path),
    },
    {
      label: 'Copy file name',
      run: () => copyText(panel.name),
    },
    { separator: true },
    {
      label: 'Refresh workspace',
      disabled: !isFs,
      run: () => {
        void refreshWorkspace();
      },
    },
    {
      label: 'Reset panel layout',
      run: resetLayout,
    },
  ];
  if (isOpen) {
    entries.push({ label: 'Close editor', shortcut: 'esc', run: () => editor.close() });
  }
  panelMenu.open(entries, x, y);
};

window.addEventListener(
  'keydown',
  (event) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
    if (event.key.toLowerCase() !== 'p') return;
    event.preventDefault();
    search.close();
    commandPalette.close();
    panelMenu.close();
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
    quickOpen.close();
    commandPalette.close();
    panelMenu.close();
    if (search.isOpen) search.close();
    else search.open();
  },
  { capture: true },
);

window.addEventListener(
  'keydown',
  (event) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    if (!event.shiftKey || event.key.toLowerCase() !== 'p') return;
    event.preventDefault();
    quickOpen.close();
    search.close();
    panelMenu.close();
    if (commandPalette.isOpen) commandPalette.close();
    else commandPalette.open();
  },
  { capture: true },
);

// File operations only fire from the canvas, never while typing or searching.
window.addEventListener('keydown', (event) => {
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
  if (quickOpen.isOpen || commandPalette.isOpen || panelMenu.isOpen || isEditableTarget(event.target)) return;
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
  selectedPaths: string[];
  primaryPath?: string | null;
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
  semantics.reset();
  provider = nextProvider;
  syncDirectoryWatcher();
  structureSyncAt = 0;
  workspace = nextWorkspace;
  applySavedLayout(workspace);
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

  const selectedIds = view.selectedPaths
    .map((path) => workspace.panels.find((panel) => panel.path === path)?.id ?? -1)
    .filter((id) => id >= 0);
  const primaryId = view.primaryPath
    ? (workspace.panels.find((panel) => panel.path === view.primaryPath)?.id ?? -1)
    : (selectedIds[selectedIds.length - 1] ?? -1);
  input.setSelection(selectedIds, primaryId);

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
    storedHandle = handle;
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
  storedHandle = handle;

  hud.setReopenFolder(handle.name, () => {
    void openDirectoryHandle(handle, true);
  });

  if ((await directoryPermission(handle)) === 'granted') {
    await openDirectoryHandle(handle, false);
  }
}

let refreshing = false;

interface RefreshOptions {
  /** Background sync skips the blocking overlay and fails quietly. */
  quiet?: boolean;
}

/** Rescans the active folder, keeping the camera and selected file stable. */
async function refreshWorkspace(
  focusPath?: string,
  options: RefreshOptions = {},
): Promise<boolean> {
  const currentProvider = provider;
  if (refreshing || !(currentProvider instanceof FsAccessProvider)) return false;

  refreshing = true;
  const view: ApplyView = {
    camera: camera.state(),
    selectedPaths: input.selectedIds
      .map((id) => workspace.panels[id]?.path)
      .filter((path): path is string => Boolean(path)),
    primaryPath:
      input.selectedId >= 0 ? (workspace.panels[input.selectedId]?.path ?? null) : null,
    focusPath,
    openPath: editor.openPanel?.path ?? null,
  };
  if (!options.quiet) {
    loading.show('Refreshing workspace', `Scanning ${currentProvider.name}…`);
  }
  try {
    const nextWorkspace = await currentProvider.load((progress) => {
      if (!options.quiet) loading.setDetail(workspaceScanDetail(progress));
    });
    if (provider !== currentProvider) {
      if (!options.quiet) loading.hide();
      return false;
    }

    applyWorkspace(nextWorkspace, currentProvider, view);
    if (!options.quiet) loading.hide();
    return true;
  } catch (error) {
    if (options.quiet) return false;
    console.error(error);
    loading.fail(error instanceof Error ? error.message : 'Unknown error');
    return false;
  } finally {
    refreshing = false;
  }
}

let structureSyncAt = 0;
let structureSyncing = false;

function scheduleWorkspaceSync(): void {
  if (syncTimer !== null) window.clearTimeout(syncTimer);
  syncTimer = window.setTimeout(() => {
    syncTimer = null;
    void syncWorkspaceStructure();
  }, 250);
}

/** Attaches a directory observer to the active real folder, if supported. */
function syncDirectoryWatcher(): void {
  const currentProvider = provider;
  if (currentProvider === watchedProvider) return;

  dirWatcher?.dispose();
  dirWatcher = null;
  watchedProvider = null;

  if (!(currentProvider instanceof FsAccessProvider)) return;
  watchedProvider = currentProvider;
  dirWatcher = watchDirectory(currentProvider.directory, scheduleWorkspaceSync);
}

/** Quietly syncs panels when the folder changes on disk. */
async function syncWorkspaceStructure(force = false): Promise<void> {
  const currentProvider = provider;
  if (!(currentProvider instanceof FsAccessProvider)) return;
  if (document.visibilityState !== 'visible') return;
  if (structureSyncing || refreshing || loading.isOpen) return;

  const now = performance.now();
  if (!force && now - structureSyncAt < 1200) return;
  structureSyncAt = now;
  structureSyncing = true;
  try {
    const change = await currentProvider.detectChanges();
    if (!change || provider !== currentProvider) return;

    const openPath = editor.openPanel?.path ?? null;
    const onlyOpenFile =
      openPath !== null &&
      change.added.length === 0 &&
      change.removed.length === 0 &&
      change.modified.length > 0 &&
      change.modified.every((path) => path === openPath);

    if (onlyOpenFile && (await currentProvider.acceptFileChange(openPath))) {
      return;
    }

    await refreshWorkspace(undefined, { quiet: true });
  } catch (error) {
    console.warn('Workspace live sync failed', error);
  } finally {
    structureSyncing = false;
  }
}

window.addEventListener('focus', () => {
  void syncWorkspaceStructure(true);
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void syncWorkspaceStructure(true);
});

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

function defaultNewFilePath(basePath?: string): string {
  const selected = basePath
    ? (workspace.panels.find((panel) => panel.path === basePath) ?? null)
    : input.selectedId >= 0
      ? workspace.panels[input.selectedId]
      : null;
  if (!selected) return 'untitled.ts';
  const slash = selected.path.lastIndexOf('/');
  return slash < 0 ? 'untitled.ts' : `${selected.path.slice(0, slash + 1)}untitled.ts`;
}

async function createNewFile(basePath?: string): Promise<void> {
  const currentProvider = provider;
  if (!(currentProvider instanceof FsAccessProvider)) {
    window.alert('Open a folder before creating files.');
    return;
  }

  const raw = window.prompt('New file path', defaultNewFilePath(basePath));
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

  if (input.selectionCount !== 1) {
    window.alert('Select a single file to rename.');
    return;
  }
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

  const panels = input.selectedIds
    .map((id) => workspace.panels[id])
    .filter((panel): panel is Panel => Boolean(panel));
  if (panels.length === 0) {
    window.alert('Select a file panel to delete.');
    return;
  }

  const dirtyCount = panels.filter((panel) => panel.dirty).length;
  let message: string;
  if (panels.length === 1) {
    message = panels[0].dirty
      ? `Delete ${panels[0].path}? Unsaved changes will be lost.`
      : `Delete ${panels[0].path}?`;
  } else {
    const preview = panels.slice(0, 4).map((panel) => panel.path).join('\n');
    const more = panels.length > 4 ? `\n…and ${panels.length - 4} more` : '';
    const dirty =
      dirtyCount > 0
        ? `\n\nUnsaved changes in ${dirtyCount} file${dirtyCount === 1 ? '' : 's'} will be lost.`
        : '';
    message = `Delete ${panels.length} files?\n\n${preview}${more}${dirty}`;
  }
  if (!window.confirm(message)) return;

  const openPath = editor.openPanel?.path ?? null;
  if (openPath && panels.some((panel) => panel.path === openPath)) editor.close();

  const failures: string[] = [];
  for (const panel of panels) {
    editor.discardDraft(panel.path);
    try {
      await currentProvider.deleteFile(panel.path);
    } catch (error) {
      failures.push(
        `${panel.path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  await refreshWorkspace();
  if (failures.length > 0) {
    window.alert(`Could not delete:\n${failures.join('\n')}`);
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
    get dirWatcher() {
      return dirWatcher;
    },
    syncWorkspaceStructure,
    camera,
    renderer,
    input,
    hud,
    minimap,
    editor,
    tokens,
    semantics,
    quickOpen,
    search,
    commandPalette,
    panelMenu,
    openFolder,
    openDirectoryHandle,
    bootStoredFolder,
    applyWorkspace,
    refreshWorkspace,
    resetLayout,
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
let structureWatchTimer = 0;

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

  structureWatchTimer += dt;
  const structureInterval = workspace.panels.length > 1500 ? 4 : 1.5;
  if (!dirWatcher?.active && structureWatchTimer >= structureInterval) {
    structureWatchTimer = 0;
    if (document.visibilityState === 'visible') void syncWorkspaceStructure();
  }

  const start = performance.now();
  const stats = renderer.render(
    camera,
    input.hoveredId,
    input.selectedIds,
    input.selectedId,
  );
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
      selectedCount: input.selectionCount,
      hovered,
    });
  }

  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
