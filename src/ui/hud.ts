import { formatInt } from '../util/math';

export interface HudStats {
  fps: number;
  frameMs: number;
  visible: number;
  total: number;
  groups: number;
  drawCalls: number;
  instances: number;
  glyphs: number;
  zoom: number;
  cameraX: number;
  cameraY: number;
  lods: [number, number, number, number];
  selected: string | null;
  selectedCount: number;
  hovered: string | null;
}

const TEMPLATE = `
  <div class="hud hud-stats">
    <div class="brand">
      <span class="brand-mark"></span>
      <span>SPATIAL IDE</span>
      <span class="brand-phase">phase 0</span>
    </div>
    <div class="stat-grid">
      <div class="stat"><span>fps</span><b data-k="fps">—</b></div>
      <div class="stat"><span>frame</span><b data-k="frame">—</b></div>
      <div class="stat"><span>visible</span><b data-k="visible">—</b></div>
      <div class="stat"><span>draws</span><b data-k="draws">—</b></div>
      <div class="stat"><span>quads</span><b data-k="quads">—</b></div>
      <div class="stat"><span>glyphs</span><b data-k="glyphs">—</b></div>
      <div class="stat"><span>zoom</span><b data-k="zoom">—</b></div>
      <div class="stat"><span>camera</span><b data-k="camera">—</b></div>
    </div>
    <div class="lod-block">
      <div class="lod-row"><i class="dot l0"></i><span>L0 dot</span><b data-k="l0">0</b></div>
      <div class="lod-row"><i class="dot l1"></i><span>L1 overview</span><b data-k="l1">0</b></div>
      <div class="lod-row"><i class="dot l2"></i><span>L2 inspect</span><b data-k="l2">0</b></div>
      <div class="lod-row"><i class="dot l3"></i><span>L3 edit</span><b data-k="l3">0</b></div>
    </div>
    <div class="path" data-k="path">no selection</div>
  </div>

  <div class="hud hud-legend">
    <div class="legend-title">LEGEND</div>
    <div class="legend-row"><i class="swatch ts"></i><span>TypeScript</span></div>
    <div class="legend-row"><i class="swatch tsx"></i><span>TSX</span></div>
    <div class="legend-row"><i class="swatch rust"></i><span>Rust</span></div>
    <div class="legend-row"><i class="swatch css"></i><span>CSS</span></div>
    <div class="legend-row"><i class="swatch md"></i><span>Markdown</span></div>
    <div class="legend-sep"></div>
    <div class="legend-row"><i class="swatch git-mod"></i><span>modified</span></div>
    <div class="legend-row"><i class="swatch git-add"></i><span>added</span></div>
    <div class="legend-row"><i class="swatch git-del"></i><span>deleted</span></div>
    <div class="legend-row"><i class="swatch git-dirty"></i><span>unsaved</span></div>
  </div>

  <div class="hud hud-hints">
    <span><kbd>wheel</kbd> pan</span>
    <span><kbd>ctrl</kbd>+<kbd>wheel</kbd> zoom</span>
    <span><kbd>space</kbd>+<kbd>drag</kbd> pan</span>
    <span><kbd>dbl-click</kbd> edit</span>
    <span><kbd>drag</kbd> move</span>
    <span><kbd>shift</kbd>+<kbd>click</kbd>/<kbd>drag</kbd> multi</span>
    <span><kbd>right-click</kbd> menu</span>
    <span><kbd>n</kbd> new file</span>
    <span><kbd>F2</kbd> rename</span>
    <span><kbd>del</kbd> delete</span>
    <span><kbd>ctrl</kbd>+<kbd>shift</kbd>+<kbd>f</kbd> search</span>
    <span><kbd>ctrl</kbd>+<kbd>shift</kbd>+<kbd>p</kbd> commands</span>
    <span><kbd>ctrl</kbd>+<kbd>p</kbd> go to file</span>
    <span><kbd>ctrl</kbd>+<kbd>s</kbd> save</span>
    <span><kbd>0</kbd> fit</span>
    <span><kbd>1</kbd> 100%</span>
    <span><kbd>esc</kbd> close</span>
  </div>
`;

export interface HudActions {
  onOpenFolder: () => void;
  onNewFile: () => void;
  onRefresh: () => void;
}

export interface Hud {
  update(stats: HudStats): void;
  setWorkspace(name: string, fileCount: number, groupCount: number): void;
  setReopenFolder(name: string | null, onReopen: (() => void) | null): void;
  setFileActionsEnabled(enabled: boolean): void;
}

function formatCompact(value: number): string {
  const absolute = Math.abs(value);
  if (absolute >= 10000) return `${(value / 1000).toFixed(1)}k`;
  return Math.round(value).toLocaleString('en-US');
}

export function createHud(
  workspaceName: string,
  fileCount: number,
  groupCount: number,
  actions: HudActions,
): Hud {
  document.body.insertAdjacentHTML('beforeend', TEMPLATE);

  const values = new Map<string, HTMLElement>();
  for (const element of document.querySelectorAll<HTMLElement>('[data-k]')) {
    const key = element.dataset.k;
    if (key) values.set(key, element);
  }

  const chip = document.createElement('div');
  chip.className = 'hud hud-chip';
  chip.innerHTML = `
    <span class="chip-name" data-chip="name">${workspaceName}</span>
    <span class="chip-meta" data-chip="meta">${formatInt(fileCount)} files · ${groupCount} groups</span>
    <button class="chip-button chip-reopen" type="button" data-action="reopen" hidden>Reopen</button>
    <button class="chip-button chip-action" type="button" data-action="new-file" disabled>New file</button>
    <button class="chip-button chip-action" type="button" data-action="refresh" disabled>Refresh</button>
    <button class="chip-button" type="button" data-action="open-folder">Open folder</button>
  `;
  document.body.appendChild(chip);

  chip.querySelector<HTMLButtonElement>('[data-action="open-folder"]')?.addEventListener(
    'click',
    actions.onOpenFolder,
  );

  const newFileButton = chip.querySelector<HTMLButtonElement>('[data-action="new-file"]');
  const refreshButton = chip.querySelector<HTMLButtonElement>('[data-action="refresh"]');
  newFileButton?.addEventListener('click', actions.onNewFile);
  refreshButton?.addEventListener('click', actions.onRefresh);

  const reopenButton = chip.querySelector<HTMLButtonElement>('[data-action="reopen"]');
  let reopenHandler: (() => void) | null = null;
  reopenButton?.addEventListener('click', () => reopenHandler?.());

  const chipName = chip.querySelector<HTMLElement>('[data-chip="name"]');
  const chipMeta = chip.querySelector<HTMLElement>('[data-chip="meta"]');

  let lastPath = '';

  const set = (key: string, value: string): void => {
    const element = values.get(key);
    if (element && element.textContent !== value) element.textContent = value;
  };

  return {
    update(stats: HudStats): void {
      set('fps', stats.fps.toFixed(0));
      set('frame', `${stats.frameMs.toFixed(2)} ms`);
      set('visible', `${formatInt(stats.visible)} / ${formatInt(stats.total)}`);
      set('draws', String(stats.drawCalls));
      set('quads', formatInt(stats.instances));
      set('glyphs', formatInt(stats.glyphs));
      set('zoom', `${(stats.zoom * 100).toFixed(stats.zoom < 0.1 ? 1 : 0)}%`);
      set('camera', `${formatCompact(stats.cameraX)}, ${formatCompact(stats.cameraY)}`);
      set('l0', formatInt(stats.lods[0]));
      set('l1', formatInt(stats.lods[1]));
      set('l2', formatInt(stats.lods[2]));
      set('l3', formatInt(stats.lods[3]));

      const path =
        stats.selectedCount > 1
          ? `${stats.selectedCount} panels selected`
          : (stats.selected ?? stats.hovered ?? 'no selection');
      if (path !== lastPath) {
        lastPath = path;
        set('path', path);
        const element = values.get('path');
        if (element) {
          element.classList.toggle(
            'is-hover',
            stats.selectedCount === 0 && Boolean(stats.hovered),
          );
        }
      }
    },

    setWorkspace(name: string, nextFileCount: number, nextGroupCount: number): void {
      if (chipName) chipName.textContent = name;
      if (chipMeta) {
        chipMeta.textContent = `${formatInt(nextFileCount)} files · ${nextGroupCount} groups`;
      }
    },

    setReopenFolder(name: string | null, onReopen: (() => void) | null): void {
      reopenHandler = onReopen;
      if (!reopenButton) return;
      reopenButton.hidden = !name || !onReopen;
      if (name) {
        reopenButton.textContent = `Reopen ${name}`;
        reopenButton.title = `Reopen ${name}`;
      }
    },

    setFileActionsEnabled(enabled: boolean): void {
      if (newFileButton) newFileButton.disabled = !enabled;
      if (refreshButton) refreshButton.disabled = !enabled;
    },
  };
}
