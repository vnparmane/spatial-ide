import type { Camera } from '../scene/camera';
import { clamp } from '../util/math';
import { LANGUAGE_COLOR, type Workspace } from '../workspace/types';

const MAX_DPR = 2;
const PAD = 7;

const TEMPLATE = `
  <div class="hud hud-minimap">
    <div class="minimap-head">
      <span>OVERVIEW</span>
      <span class="minimap-hint">drag to pan</span>
    </div>
    <canvas class="minimap-canvas" data-m="canvas"></canvas>
  </div>
`;

export interface Minimap {
  update(camera: Camera, selectedId: number): void;
  setWorkspace(workspace: Workspace): void;
}

/**
 * Workspace overview. The static panel map is rendered once into an offscreen
 * canvas per workspace, so each frame only blits it and strokes the viewport.
 */
export function createMinimap(
  workspace: Workspace,
  onNavigate: (worldX: number, worldY: number) => void,
): Minimap {
  const container = document.createElement('div');
  container.innerHTML = TEMPLATE;
  document.body.appendChild(container);

  const canvas = container.querySelector<HTMLCanvasElement>('[data-m="canvas"]');
  const context = canvas?.getContext('2d') ?? null;
  if (!canvas || !context) throw new Error('Failed to create minimap');

  const staticCanvas = document.createElement('canvas');
  const staticContext = staticCanvas.getContext('2d');
  if (!staticContext) throw new Error('Failed to create minimap layer');

  let current = workspace;
  let width = 0;
  let height = 0;
  let dpr = 1;
  let scale = 1;
  let offsetX = PAD;
  let offsetY = PAD;
  let dragging = false;
  let lastViewport = '';
  let lastSelected = -2;

  const layoutTransform = (): void => {
    const innerW = Math.max(1, width - PAD * 2);
    const innerH = Math.max(1, height - PAD * 2);
    const bounds = current.bounds;
    scale = Math.min(innerW / Math.max(1, bounds.w), innerH / Math.max(1, bounds.h));
    offsetX = PAD + (innerW - bounds.w * scale) / 2;
    offsetY = PAD + (innerH - bounds.h * scale) / 2;
  };

  const worldToMapX = (wx: number): number => offsetX + (wx - current.bounds.x) * scale;
  const worldToMapY = (wy: number): number => offsetY + (wy - current.bounds.y) * scale;

  const renderStatic = (): void => {
    layoutTransform();
    staticContext.setTransform(dpr, 0, 0, dpr, 0, 0);
    staticContext.clearRect(0, 0, width, height);
    staticContext.fillStyle = 'rgba(5, 8, 13, 0.7)';
    staticContext.fillRect(0, 0, width, height);

    const bounds = current.bounds;
    const mapW = bounds.w * scale;
    const mapH = bounds.h * scale;

    // Directory frames.
    staticContext.lineWidth = 0.75;
    for (const group of current.groups) {
      const gx = worldToMapX(group.x);
      const gy = worldToMapY(group.y);
      const gw = Math.max(1, group.w * scale);
      const gh = Math.max(1, group.h * scale);
      staticContext.fillStyle = 'rgba(110, 168, 254, 0.035)';
      staticContext.fillRect(gx, gy, gw, gh);
      staticContext.strokeStyle = 'rgba(110, 168, 254, 0.13)';
      staticContext.strokeRect(gx + 0.5, gy + 0.5, Math.max(0, gw - 1), Math.max(0, gh - 1));
    }

    // Panel density, tinted by language.
    for (const panel of current.panels) {
      const [r, g, b] = LANGUAGE_COLOR[panel.language];
      const px = worldToMapX(panel.x);
      const py = worldToMapY(panel.y);
      const pw = Math.max(0.8, panel.w * scale);
      const ph = Math.max(0.8, panel.h * scale);
      staticContext.fillStyle = `rgba(${r}, ${g}, ${b}, 0.62)`;
      staticContext.fillRect(px, py, pw, ph);
    }

    staticContext.strokeStyle = 'rgba(120, 145, 180, 0.18)';
    staticContext.lineWidth = 1;
    staticContext.strokeRect(
      worldToMapX(bounds.x) + 0.5,
      worldToMapY(bounds.y) + 0.5,
      Math.max(0, mapW - 1),
      Math.max(0, mapH - 1),
    );

    lastViewport = '';
    lastSelected = -2;
  };

  const resize = (): void => {
    const rect = canvas.getBoundingClientRect();
    const nextWidth = Math.max(1, Math.round(rect.width));
    const nextHeight = Math.max(1, Math.round(rect.height));
    const nextDpr = Math.min(MAX_DPR, window.devicePixelRatio || 1);
    if (nextWidth === width && nextHeight === height && nextDpr === dpr) return;

    width = nextWidth;
    height = nextHeight;
    dpr = nextDpr;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    staticCanvas.width = canvas.width;
    staticCanvas.height = canvas.height;
    renderStatic();
  };

  const navigate = (event: PointerEvent): void => {
    const rect = canvas.getBoundingClientRect();
    const mx = event.clientX - rect.left;
    const my = event.clientY - rect.top;
    const bounds = current.bounds;
    const wx = bounds.x + (mx - offsetX) / scale;
    const wy = bounds.y + (my - offsetY) / scale;
    onNavigate(
      clamp(wx, bounds.x, bounds.x + bounds.w),
      clamp(wy, bounds.y, bounds.y + bounds.h),
    );
  };

  canvas.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    dragging = true;
    navigate(event);
    try {
      canvas.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic pointers cannot always be captured.
    }
    event.preventDefault();
  });

  canvas.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    navigate(event);
  });

  const endDrag = (event: PointerEvent): void => {
    if (!dragging) return;
    dragging = false;
    if (canvas.hasPointerCapture(event.pointerId)) {
      canvas.releasePointerCapture(event.pointerId);
    }
  };

  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  const observer = new ResizeObserver(() => resize());
  observer.observe(canvas);

  return {
    setWorkspace(nextWorkspace: Workspace): void {
      current = nextWorkspace;
      width = 0;
      resize();
    },

    update(camera: Camera, selectedId: number): void {
      if (width === 0) resize();
      if (width === 0) return;

      const viewX = camera.x - camera.vw / (2 * camera.zoom);
      const viewY = camera.y - camera.vh / (2 * camera.zoom);
      const viewW = camera.vw / camera.zoom;
      const viewH = camera.vh / camera.zoom;
      const key = `${viewX.toFixed(1)}:${viewY.toFixed(1)}:${viewW.toFixed(1)}:${viewH.toFixed(1)}`;
      if (key === lastViewport && selectedId === lastSelected) return;
      lastViewport = key;
      lastSelected = selectedId;

      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(staticCanvas, 0, 0);
      context.setTransform(dpr, 0, 0, dpr, 0, 0);

      const selected = selectedId >= 0 ? current.panels[selectedId] : undefined;
      if (selected) {
        const sx = worldToMapX(selected.x);
        const sy = worldToMapY(selected.y);
        const sw = Math.max(1.5, selected.w * scale);
        const sh = Math.max(1.5, selected.h * scale);
        context.fillStyle = 'rgba(255, 255, 255, 0.9)';
        context.fillRect(sx, sy, sw, sh);
      }

      // Clamp the viewport to the map so zoomed-out views read as a border.
      const mapX = worldToMapX(current.bounds.x);
      const mapY = worldToMapY(current.bounds.y);
      const mapW = current.bounds.w * scale;
      const mapH = current.bounds.h * scale;
      const mx = clamp(worldToMapX(viewX), mapX, mapX + mapW);
      const my = clamp(worldToMapY(viewY), mapY, mapY + mapH);
      const mx2 = clamp(worldToMapX(viewX + viewW), mapX, mapX + mapW);
      const my2 = clamp(worldToMapY(viewY + viewH), mapY, mapY + mapH);
      const mw = Math.max(1, mx2 - mx);
      const mh = Math.max(1, my2 - my);

      context.fillStyle = 'rgba(110, 168, 254, 0.12)';
      context.fillRect(mx, my, mw, mh);
      context.strokeStyle = 'rgba(150, 195, 255, 0.92)';
      context.lineWidth = 1;
      context.strokeRect(mx + 0.5, my + 0.5, Math.max(0, mw - 1), Math.max(0, mh - 1));
    },
  };
}
