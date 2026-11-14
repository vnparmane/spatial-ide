import { fitGroupBounds, fitWorkspaceBounds } from '../scene/arrangement';
import type { Camera } from '../scene/camera';
import { GROUP_HEADER } from '../scene/layout';
import type { SpatialHash } from '../scene/spatial';
import type { Group, Panel, Workspace } from '../workspace/types';

/** Screen-space distance before a press on a panel becomes a drag. */
const DRAG_THRESHOLD_PX = 3;
/** Screen-space distance before a press on empty canvas becomes a marquee. */
const MARQUEE_THRESHOLD_PX = 3;

interface DragState {
  pointerId: number;
  kind: 'panels' | 'group';
  startX: number;
  startY: number;
  moved: boolean;
  /** Frames that must be refitted while panels move. */
  groups: Group[];
  originPanels: { id: number; x: number; y: number }[];
  originGroupX: number;
  originGroupY: number;
  /** Collapses a multi-selection to this panel when the press ends without moving. */
  collapseTo: number | null;
}

interface MarqueeState {
  pointerId: number;
  startX: number;
  startY: number;
  additive: boolean;
  base: number[];
  basePrimary: number;
  moved: boolean;
}

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target.closest('.editor-shell')) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/**
 * Canvas input: wheel pan, ctrl/cmd+wheel zoom-to-cursor, space/middle drag pan,
 * click and marquee selection, panel/group dragging, and keyboard navigation.
 */
export class InputController {
  hoveredId = -1;
  hoveredGroupId = -1;
  /** Invoked when a panel is activated for editing (double-click). */
  onActivate: ((panel: Panel) => void) | null = null;
  /** Invoked on right-click with the panel under the cursor, if any. */
  onPanelContextMenu: ((panel: Panel | null, x: number, y: number) => void) | null = null;
  /** Invoked after a manual move commits, with the moved panel paths. */
  onLayoutCommit: ((paths: string[]) => void) | null = null;

  private readonly canvas: HTMLCanvasElement;
  private readonly marqueeEl: HTMLDivElement;
  private camera: Camera;
  private workspace: Workspace;
  private spatial: SpatialHash;

  /** Every selected panel. The primary selection is the anchor for commands. */
  private selection = new Set<number>();
  private primaryId = -1;

  private panning = false;
  private drag: DragState | null = null;
  private marquee: MarqueeState | null = null;
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

    this.marqueeEl = document.createElement('div');
    this.marqueeEl.className = 'marquee';
    this.marqueeEl.hidden = true;
    document.body.appendChild(this.marqueeEl);

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

  /** Primary selected panel, or -1. Kept for single-selection callers. */
  get selectedId(): number {
    if (this.primaryId >= 0 && this.selection.has(this.primaryId)) return this.primaryId;
    const first = this.selection.values().next();
    return first.done ? -1 : first.value;
  }

  set selectedId(id: number) {
    if (id >= 0 && this.workspace.panels[id]) this.selectOnly(id);
    else this.clearSelection();
  }

  /** All selected panel ids in ascending order. */
  get selectedIds(): number[] {
    return [...this.selection].sort((a, b) => a - b);
  }

  get selectionCount(): number {
    return this.selection.size;
  }

  selectOnly(id: number): void {
    if (id < 0 || !this.workspace.panels[id]) {
      this.clearSelection();
      return;
    }
    this.selection.clear();
    this.selection.add(id);
    this.primaryId = id;
  }

  selectMany(ids: readonly number[], additive = false): void {
    if (!additive) this.selection.clear();
    let primary = -1;
    for (const id of ids) {
      if (id < 0 || !this.workspace.panels[id]) continue;
      this.selection.add(id);
      primary = id;
    }
    if (primary >= 0) {
      this.primaryId = primary;
    } else if (!additive) {
      this.primaryId = -1;
    } else if (!this.selection.has(this.primaryId)) {
      this.primaryId = this.selectedId;
    }
  }

  /** Replaces the selection while preserving a specific primary panel. */
  setSelection(ids: readonly number[], primary: number): void {
    this.selection.clear();
    for (const id of ids) {
      if (id >= 0 && this.workspace.panels[id]) this.selection.add(id);
    }
    this.primaryId = this.selection.has(primary) ? primary : this.selectedId;
  }

  toggleSelection(id: number): void {
    if (id < 0 || !this.workspace.panels[id]) return;
    if (this.selection.has(id)) {
      this.selection.delete(id);
      if (this.primaryId === id) this.primaryId = this.selectedId;
    } else {
      this.selection.add(id);
      this.primaryId = id;
    }
  }

  clearSelection(): void {
    this.selection.clear();
    this.primaryId = -1;
  }

  setWorkspace(workspace: Workspace, spatial: SpatialHash): void {
    this.workspace = workspace;
    this.spatial = spatial;
    this.hoveredId = -1;
    this.hoveredGroupId = -1;
    this.clearSelection();
    this.drag = null;
    this.marquee = null;
    this.marqueeEl.hidden = true;
    this.panning = false;
    this.pointerId = -1;
    this.refreshCursor();
  }

  /** Swaps in a rebuilt spatial hash without disturbing selection or hover. */
  setSpatial(spatial: SpatialHash): void {
    this.spatial = spatial;
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

  /** Returns the topmost group whose header strip contains the point. */
  private pickGroupHeader(sx: number, sy: number): Group | null {
    const [wx, wy] = this.camera.screenToWorld(sx, sy);
    for (let index = this.workspace.groups.length - 1; index >= 0; index -= 1) {
      const group = this.workspace.groups[index];
      if (
        wx >= group.x &&
        wx <= group.x + group.w &&
        wy >= group.y &&
        wy <= group.y + GROUP_HEADER
      ) {
        return group;
      }
    }
    return null;
  }

  private updateHover(sx: number, sy: number): void {
    const panel = this.pick(sx, sy);
    this.hoveredId = panel ? panel.id : -1;
    this.hoveredGroupId = panel ? -1 : (this.pickGroupHeader(sx, sy)?.id ?? -1);
    this.refreshCursor();
  }

  private refreshCursor(): void {
    if (this.marquee) {
      this.canvas.style.cursor = 'crosshair';
    } else if (this.panning || (this.drag?.moved ?? false)) {
      this.canvas.style.cursor = 'grabbing';
    } else if (this.spaceDown) {
      this.canvas.style.cursor = 'grab';
    } else if (this.hoveredId >= 0 || this.hoveredGroupId >= 0) {
      this.canvas.style.cursor = 'grab';
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

  private capturePointer(pointerId: number): void {
    this.pointerId = pointerId;
    try {
      this.canvas.setPointerCapture(pointerId);
    } catch {
      // Synthetic pointers cannot always be captured.
    }
  }

  private beginPanelDrag(
    event: PointerEvent,
    sx: number,
    sy: number,
    panel: Panel,
    collapseTo: number | null,
  ): void {
    const ids = this.selection.has(panel.id) ? this.selectedIds : [panel.id];
    const panels = ids
      .map((id) => this.workspace.panels[id])
      .filter((candidate): candidate is Panel => Boolean(candidate));

    const groups: Group[] = [];
    for (const member of panels) {
      const group = this.workspace.groups.find((candidate) => candidate.id === member.groupId);
      if (group && !groups.includes(group)) groups.push(group);
    }
    if (groups.length === 0) return;

    this.drag = {
      pointerId: event.pointerId,
      kind: 'panels',
      startX: sx,
      startY: sy,
      moved: false,
      groups,
      originPanels: panels.map((member) => ({ id: member.id, x: member.x, y: member.y })),
      originGroupX: 0,
      originGroupY: 0,
      collapseTo,
    };
    this.capturePointer(event.pointerId);
    this.refreshCursor();
  }

  private beginGroupDrag(
    event: PointerEvent,
    sx: number,
    sy: number,
    group: Group,
  ): void {
    const panels = group.panelIds
      .map((id) => this.workspace.panels[id])
      .filter((candidate): candidate is Panel => Boolean(candidate));

    this.drag = {
      pointerId: event.pointerId,
      kind: 'group',
      startX: sx,
      startY: sy,
      moved: false,
      groups: [group],
      originPanels: panels.map((member) => ({ id: member.id, x: member.x, y: member.y })),
      originGroupX: group.x,
      originGroupY: group.y,
      collapseTo: null,
    };
    this.capturePointer(event.pointerId);
    this.refreshCursor();
  }

  private beginMarquee(
    event: PointerEvent,
    sx: number,
    sy: number,
    additive: boolean,
  ): void {
    this.marquee = {
      pointerId: event.pointerId,
      startX: sx,
      startY: sy,
      additive,
      base: this.selectedIds,
      basePrimary: this.selectedId,
      moved: false,
    };
    this.capturePointer(event.pointerId);
    this.marqueeEl.hidden = true;
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

    const additive = event.shiftKey || event.ctrlKey || event.metaKey;
    const panel = this.pick(sx, sy);

    if (panel) {
      if (additive) {
        this.toggleSelection(panel.id);
        if (this.selection.has(panel.id)) this.beginPanelDrag(event, sx, sy, panel, null);
      } else {
        const collapseTo =
          this.selection.has(panel.id) && this.selection.size > 1 ? panel.id : null;
        if (!this.selection.has(panel.id)) this.selectOnly(panel.id);
        this.beginPanelDrag(event, sx, sy, panel, collapseTo);
      }
      this.refreshCursor();
      event.preventDefault();
      return;
    }

    const group = this.pickGroupHeader(sx, sy);
    if (group) {
      this.clearSelection();
      this.beginGroupDrag(event, sx, sy, group);
      event.preventDefault();
      return;
    }

    if (event.shiftKey) {
      this.beginMarquee(event, sx, sy, event.ctrlKey || event.metaKey);
    } else {
      this.clearSelection();
      this.beginPan(event, sx, sy);
    }
    event.preventDefault();
  };

  private updateDrag(sx: number, sy: number): void {
    const drag = this.drag;
    if (!drag) return;

    if (!drag.moved) {
      if (Math.hypot(sx - drag.startX, sy - drag.startY) < DRAG_THRESHOLD_PX) return;
      drag.moved = true;
    }

    const dx = (sx - drag.startX) / this.camera.zoom;
    const dy = (sy - drag.startY) / this.camera.zoom;

    for (const origin of drag.originPanels) {
      const panel = this.workspace.panels[origin.id];
      if (!panel) continue;
      panel.x = origin.x + dx;
      panel.y = origin.y + dy;
    }

    if (drag.kind === 'group') {
      const group = drag.groups[0];
      group.x = drag.originGroupX + dx;
      group.y = drag.originGroupY + dy;
    } else {
      for (const group of drag.groups) {
        fitGroupBounds(group, this.workspace.panels);
      }
    }

    this.workspace.bounds = fitWorkspaceBounds(this.workspace.groups);
    this.refreshCursor();
  }

  private updateMarquee(sx: number, sy: number): void {
    const marquee = this.marquee;
    if (!marquee) return;

    if (!marquee.moved) {
      if (Math.hypot(sx - marquee.startX, sy - marquee.startY) < MARQUEE_THRESHOLD_PX) return;
      marquee.moved = true;
    }

    const left = Math.min(marquee.startX, sx);
    const top = Math.min(marquee.startY, sy);
    const width = Math.abs(sx - marquee.startX);
    const height = Math.abs(sy - marquee.startY);

    const rect = this.canvas.getBoundingClientRect();
    this.marqueeEl.hidden = false;
    this.marqueeEl.style.left = `${rect.left + left}px`;
    this.marqueeEl.style.top = `${rect.top + top}px`;
    this.marqueeEl.style.width = `${width}px`;
    this.marqueeEl.style.height = `${height}px`;

    const [worldAX, worldAY] = this.camera.screenToWorld(left, top);
    const [worldBX, worldBY] = this.camera.screenToWorld(left + width, top + height);
    const world = {
      x: Math.min(worldAX, worldBX),
      y: Math.min(worldAY, worldBY),
      w: Math.abs(worldBX - worldAX),
      h: Math.abs(worldBY - worldAY),
    };

    const hits: number[] = [];
    for (const index of this.spatial.query(world.x, world.y, world.w, world.h)) {
      const panel = this.workspace.panels[index];
      if (!panel) continue;
      if (panel.x + panel.w < world.x || panel.x > world.x + world.w) continue;
      if (panel.y + panel.h < world.y || panel.y > world.y + world.h) continue;
      hits.push(panel.id);
    }
    hits.sort((a, b) => a - b);

    const next = marquee.additive
      ? new Set<number>([...marquee.base, ...hits])
      : new Set<number>(hits);

    let same = next.size === this.selection.size;
    if (same) {
      for (const id of next) {
        if (!this.selection.has(id)) {
          same = false;
          break;
        }
      }
    }
    if (!same) this.selection = next;

    if (hits.length > 0) {
      this.primaryId = hits[hits.length - 1];
    } else if (!this.selection.has(this.primaryId)) {
      this.primaryId = this.selectedId;
    }
  }

  private cancelMarquee(restore: boolean): void {
    const marquee = this.marquee;
    if (!marquee) return;
    this.marquee = null;
    this.marqueeEl.hidden = true;
    if (this.canvas.hasPointerCapture(marquee.pointerId)) {
      this.canvas.releasePointerCapture(marquee.pointerId);
    }
    if (this.pointerId === marquee.pointerId) this.pointerId = -1;
    if (restore) this.setSelection(marquee.base, marquee.basePrimary);
    this.refreshCursor();
  }

  private onPointerMove = (event: PointerEvent): void => {
    const [sx, sy] = this.localPoint(event);

    if (this.drag && event.pointerId === this.drag.pointerId) {
      this.updateDrag(sx, sy);
      return;
    }

    if (this.marquee && event.pointerId === this.marquee.pointerId) {
      this.updateMarquee(sx, sy);
      return;
    }

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
    if (this.drag && event.pointerId === this.drag.pointerId) {
      const drag = this.drag;
      this.drag = null;
      this.pointerId = -1;
      if (this.canvas.hasPointerCapture(event.pointerId)) {
        this.canvas.releasePointerCapture(event.pointerId);
      }

      if (drag.moved) {
        const paths: string[] = [];
        for (const origin of drag.originPanels) {
          const panel = this.workspace.panels[origin.id];
          if (panel) paths.push(panel.path);
        }
        this.onLayoutCommit?.(paths);
      } else if (drag.collapseTo !== null) {
        this.selectOnly(drag.collapseTo);
      }

      const [sx, sy] = this.localPoint(event);
      this.updateHover(sx, sy);
      this.refreshCursor();
      return;
    }

    if (this.marquee && event.pointerId === this.marquee.pointerId) {
      const marquee = this.marquee;
      this.marquee = null;
      this.marqueeEl.hidden = true;
      this.pointerId = -1;
      if (this.canvas.hasPointerCapture(event.pointerId)) {
        this.canvas.releasePointerCapture(event.pointerId);
      }
      if (!marquee.moved && !marquee.additive) this.clearSelection();

      const [sx, sy] = this.localPoint(event);
      this.updateHover(sx, sy);
      this.refreshCursor();
      return;
    }

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
    if (this.panning || this.drag || this.marquee) return;
    this.hoveredId = -1;
    this.hoveredGroupId = -1;
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
    this.selectOnly(panel.id);
    this.onActivate?.(panel);
  };

  private onContextMenu = (event: MouseEvent): void => {
    event.preventDefault();
    const [sx, sy] = this.localPoint(event);
    const panel = this.pick(sx, sy);
    if (panel && !this.selection.has(panel.id)) this.selectOnly(panel.id);
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
        if (this.marquee) {
          this.cancelMarquee(true);
        } else {
          this.clearSelection();
        }
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

    if (this.drag) {
      const drag = this.drag;
      this.drag = null;
      if (drag.moved) {
        const paths: string[] = [];
        for (const origin of drag.originPanels) {
          const panel = this.workspace.panels[origin.id];
          if (panel) paths.push(panel.path);
        }
        this.onLayoutCommit?.(paths);
      }
    }

    this.cancelMarquee(true);
    this.refreshCursor();
  };
}
