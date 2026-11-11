import { clamp, smoothFactor } from '../util/math';
import type { Bounds } from '../workspace/types';

export interface CameraState {
  x: number;
  y: number;
  zoom: number;
}

/**
 * Camera stores the world point at the center of the viewport plus a scale.
 * Current values ease toward target values so zooming and camera flights feel
 * continuous; direct pans move both so dragging has no lag.
 */
export class Camera {
  x = 0;
  y = 0;
  zoom = 1;

  tx = 0;
  ty = 0;
  tzoom = 1;

  vw = 1;
  vh = 1;

  minZoom = 0.02;
  maxZoom = 8;
  timeConstant = 0.055;

  resize(width: number, height: number): void {
    this.vw = Math.max(1, width);
    this.vh = Math.max(1, height);
  }

  worldToScreen(wx: number, wy: number): [number, number] {
    return [(wx - this.x) * this.zoom + this.vw / 2, (wy - this.y) * this.zoom + this.vh / 2];
  }

  screenToWorld(sx: number, sy: number): [number, number] {
    return [(sx - this.vw / 2) / this.zoom + this.x, (sy - this.vh / 2) / this.zoom + this.y];
  }

  private targetScreenToWorld(sx: number, sy: number): [number, number] {
    return [(sx - this.vw / 2) / this.tzoom + this.tx, (sy - this.vh / 2) / this.tzoom + this.ty];
  }

  panByScreen(dx: number, dy: number): void {
    this.x -= dx / this.zoom;
    this.y -= dy / this.zoom;
    this.tx = this.x;
    this.ty = this.y;
  }

  /** Glides toward a world point without changing zoom. */
  centerOn(wx: number, wy: number): void {
    this.tx = wx;
    this.ty = wy;
  }

  glideByScreen(dx: number, dy: number): void {
    this.tx -= dx / this.zoom;
    this.ty -= dy / this.zoom;
  }

  zoomAt(sx: number, sy: number, factor: number): void {
    const [wx, wy] = this.targetScreenToWorld(sx, sy);
    const next = clamp(this.tzoom * factor, this.minZoom, this.maxZoom);
    if (next === this.tzoom) return;
    this.tzoom = next;
    this.tx = wx - (sx - this.vw / 2) / next;
    this.ty = wy - (sy - this.vh / 2) / next;
  }

  setZoomAt(sx: number, sy: number, zoom: number): void {
    const [wx, wy] = this.targetScreenToWorld(sx, sy);
    const next = clamp(zoom, this.minZoom, this.maxZoom);
    this.tzoom = next;
    this.tx = wx - (sx - this.vw / 2) / next;
    this.ty = wy - (sy - this.vh / 2) / next;
  }

  focusRect(rect: Bounds, padding = 96): void {
    const p = Math.min(padding, this.vw * 0.24, this.vh * 0.24);
    const availableW = Math.max(1, this.vw - p * 2);
    const availableH = Math.max(1, this.vh - p * 2);
    const zoom = clamp(
      Math.min(availableW / Math.max(1, rect.w), availableH / Math.max(1, rect.h)),
      this.minZoom,
      this.maxZoom,
    );
    this.tzoom = zoom;
    this.tx = rect.x + rect.w / 2;
    this.ty = rect.y + rect.h / 2;
  }

  update(dtSeconds: number): void {
    const k = smoothFactor(dtSeconds, this.timeConstant);
    this.x += (this.tx - this.x) * k;
    this.y += (this.ty - this.y) * k;

    const logZoom = Math.log(this.zoom);
    const logTarget = Math.log(this.tzoom);
    this.zoom = Math.exp(logZoom + (logTarget - logZoom) * k);

    if (Math.abs(this.tx - this.x) < 0.01) this.x = this.tx;
    if (Math.abs(this.ty - this.y) < 0.01) this.y = this.ty;
    if (Math.abs(this.zoom - this.tzoom) < 0.0001) this.zoom = this.tzoom;
  }

  snap(): void {
    this.x = this.tx;
    this.y = this.ty;
    this.zoom = this.tzoom;
  }

  isAnimating(): boolean {
    return (
      Math.abs(this.tx - this.x) > 0.01 ||
      Math.abs(this.ty - this.y) > 0.01 ||
      Math.abs(this.zoom - this.tzoom) > 0.0001
    );
  }

  state(): CameraState {
    return { x: this.x, y: this.y, zoom: this.zoom };
  }
}
