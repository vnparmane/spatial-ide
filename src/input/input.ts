import type { Camera } from '../scene/camera';
import type { SpatialHash } from '../scene/spatial';
import type { Panel, Workspace } from '../workspace/types';

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target.closest('.editor-shell')) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/**
 * Canvas input: wheel pan, ctrl/cmd+wheel zoom-to-cursor, space/middle drag pan,
 * click selection, double-click camera flight, and keyboard navigation.
 */
export class InputController {
  hoveredId = -1;
  selectedId = -1;
  /** Invoked when a panel is activated for editing (double-click). */
  onActivate: ((panel: Panel) => void) | null = null;
  /** Invoked on right-click with the panel under the cursor, if any. */
  onPanelContextMenu: ((panel: Panel | null, x: number, y: number) => void) | null = null;

  private readonly canvas: HTMLCanvasElement;
  private camera: Camera;
  private workspace: Workspace;
  private spatial: SpatialHash;

  private panning = false;
  private spaceDown = false;
  private pointerId = -1;
  private lastX = 0;
  private lastY = 0;
  private lastTime = 0;
  private velocityX = 0;
  private velocityY = 0;

  constructor(
    canvas: HTMLCanvasElement,
    camera: Camera,
    workspace: Workspace,
    spatial: SpatialHash,
  ) {
    this.canvas = canvas;
    this.camera = camera;
    this.workspace = workspace;
    this.spatial = spatial;
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointercancel', this.onPointerUp);
    canvas.addEventListener('pointerleave', this.onPointerLeave);
    canvas.addEventListener('dblclick', this.onDoubleClick);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    canvas.addEventListener('contextmenu', this.onContextMenu);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
  }

  setWorkspace(workspace: Workspace, spatial: SpatialHash): void {
    this.workspace = workspace;
    this.spatial = spatial;
    this.hoveredId = -1;
    this.selectedId = -1;
    this.refreshCursor();
  }

  private localPoint(event: PointerEvent | WheelEvent | MouseEvent): [number, number] {
    const rect = this.canvas.getBoundingClientRect();
    return [event.clientX - rect.left, event.clientY - rect.top];
  }

  private pick(sx: number, sy: number): Panel | null {
    const [wx, wy] = this.camera.screenToWorld(sx, sy);
    const candidates = this.spatial.query(wx, wy, 1, 1);
    let best: Panel | null = null;
    for (const index of candidates) {
      const panel = this.workspace.panels[index];
      if (!panel) continue;
      if (
        wx >= panel.x &&
        wx <= panel.x + panel.w &&
        wy >= panel.y &&
        wy <= panel.y + panel.h &&
        (!best || panel.id > best.id)
      ) {
        best = panel;
      }
    }
    return best;
  }

  private updateHover(sx: number, sy: number): void {
    const panel = this.pick(sx, sy);
    this.hoveredId = panel ? panel.id : -1;
    this.refreshCursor();
  }

  private refreshCursor(): void {
    if (this.panning) {
      this.canvas.style.cursor = 'grabbing';
    } else if (this.spaceDown) {
      this.canvas.style.cursor = 'grab';
    } else if (this.hoveredId >= 0) {
      this.canvas.style.cursor = 'pointer';
    } else {
      this.canvas.style.cursor = 'default';
    }
  }

  private beginPan(event: PointerEvent, sx: number, sy: number): void {
    this.panning = true;
    this.pointerId = event.pointerId;
    this.lastX = sx;
    this.lastY = sy;
    this.lastTime = event.timeStamp || performance.now();
    this.velocityX = 0;
    this.velocityY = 0;
    this.canvas.setPointerCapture(event.pointerId);
    this.refreshCursor();
  }

  private onPointerDown = (event: PointerEvent): void => {
    const [sx, sy] = this.localPoint(event);

    if (event.button === 1 || (event.button === 0 && this.spaceDown)) {
      event.preventDefault();
      this.beginPan(event, sx, sy);
      return;
    }

    if (event.button !== 0) return;

    const panel = this.pick(sx, sy);
    if (panel) {
      this.selectedId = panel.id;
      this.refreshCursor();
    } else {
      this.selectedId = -1;
      this.beginPan(event, sx, sy);
    }
    event.preventDefault();
  };

  private onPointerMove = (event: PointerEvent): void => {
    const [sx, sy] = this.localPoint(event);

    if (this.panning) {
      const now = event.timeStamp || performance.now();
      const dx = sx - this.lastX;
      const dy = sy - this.lastY;
      const dt = Math.max(1, now - this.lastTime);
      this.velocityX = (dx / dt) * 1000;
      this.velocityY = (dy / dt) * 1000;
      this.camera.panByScreen(dx, dy);
      this.lastX = sx;
      this.lastY = sy;
      this.lastTime = now;
      return;
    }

    this.updateHover(sx, sy);
  };

  private onPointerUp = (event: PointerEvent): void => {
    if (!this.panning || event.pointerId !== this.pointerId) return;

    this.panning = false;
    this.pointerId = -1;
    if (this.canvas.hasPointerCapture(event.pointerId)) {
      this.canvas.releasePointerCapture(event.pointerId);
    }

    if (Math.abs(this.velocityX) > 80 || Math.abs(this.velocityY) > 80) {
      this.camera.glideByScreen(this.velocityX * 0.1, this.velocityY * 0.1);
    }
    this.velocityX = 0;
    this.velocityY = 0;

    const [sx, sy] = this.localPoint(event);
    this.updateHover(sx, sy);
  };

  private onPointerLeave = (): void => {
    if (this.panning) return;
    this.hoveredId = -1;
    this.refreshCursor();
  };

  private onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    const [sx, sy] = this.localPoint(event);
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 100 : 1;
    const dx = event.deltaX * unit;
    const dy = event.deltaY * unit;

    if (event.ctrlKey || event.metaKey) {
      this.camera.zoomAt(sx, sy, Math.exp(-dy * 0.0018));
    } else if (event.shiftKey) {
      this.camera.panByScreen(-dy, 0);
    } else {
      this.camera.panByScreen(-dx, -dy);
    }

    this.updateHover(sx, sy);
  };

  private onDoubleClick = (event: MouseEvent): void => {
    const [sx, sy] = this.localPoint(event);
    const panel = this.pick(sx, sy);
    if (!panel) return;
    this.selectedId = panel.id;
    this.onActivate?.(panel);
  };

  private onContextMenu = (event: MouseEvent): void => {
    event.preventDefault();
    const [sx, sy] = this.localPoint(event);
    const panel = this.pick(sx, sy);
    if (panel) this.selectedId = panel.id;
    this.onPanelContextMenu?.(panel, event.clientX, event.clientY);
  };

  private onKeyDown = (event: KeyboardEvent): void => {
    if (isEditableTarget(event.target)) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;

    if (event.code === 'Space') {
      if (!this.spaceDown) {
        this.spaceDown = true;
        this.refreshCursor();
      }
      event.preventDefault();
      return;
    }

    const step = 90;
    switch (event.key) {
      case 'ArrowLeft':
        this.camera.glideByScreen(step, 0);
        event.preventDefault();
        break;
      case 'ArrowRight':
        this.camera.glideByScreen(-step, 0);
        event.preventDefault();
        break;
      case 'ArrowUp':
        this.camera.glideByScreen(0, step);
        event.preventDefault();
        break;
      case 'ArrowDown':
        this.camera.glideByScreen(0, -step);
        event.preventDefault();
        break;
      case '+':
      case '=':
        this.camera.zoomAt(this.camera.vw / 2, this.camera.vh / 2, 1.2);
        event.preventDefault();
        break;
      case '-':
      case '_':
        this.camera.zoomAt(this.camera.vw / 2, this.camera.vh / 2, 1 / 1.2);
        event.preventDefault();
        break;
      case '0':
      case 'f':
      case 'F':
        this.camera.focusRect(this.workspace.bounds, 72);
        event.preventDefault();
        break;
      case '1':
        this.camera.setZoomAt(this.camera.vw / 2, this.camera.vh / 2, 1);
        event.preventDefault();
        break;
      case 'Escape':
        this.selectedId = -1;
        this.hoveredId = -1;
        this.refreshCursor();
        break;
      default:
        break;
    }
  };

  private onKeyUp = (event: KeyboardEvent): void => {
    if (isEditableTarget(event.target)) return;
    if (event.code !== 'Space') return;
    this.spaceDown = false;
    this.refreshCursor();
  };

  private onBlur = (): void => {
    this.spaceDown = false;
    this.panning = false;
    this.pointerId = -1;
    this.refreshCursor();
  };
}
