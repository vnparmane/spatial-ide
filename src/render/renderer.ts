import type { Camera } from '../scene/camera';
import { lodWithHysteresis, type Lod } from '../scene/lod';
import type { SpatialHash } from '../scene/spatial';
import type { TokenStore } from '../tokens/tokenStore';
import type { Diagnostic, TokenKind, TokenRun } from '../tokens/tokenTypes';
import { smoothstep } from '../util/math';
import type { Panel, Workspace } from '../workspace/types';
import { GlyphAtlas } from './atlas';
import { BackgroundPass } from './background';
import { PanelBatch } from './panelBatch';
import { TextBatch } from './textBatch';
import { panelBorder, panelFill, THEME, type Rgba } from './theme';

export interface RenderStats {
  visible: number;
  total: number;
  groups: number;
  drawCalls: number;
  instances: number;
  glyphs: number;
  lods: [number, number, number, number];
}

const MAX_LABELS = 260;
const MAX_DPR = 2;

interface GroupBadge {
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  color: Rgba;
  border: Rgba;
}

interface DiagnosticBadge {
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
}

type TokenPalette = Record<TokenKind, Rgba | null>;

/** Light token colors for dark panel fills. */
const TOKEN_ON_DARK: TokenPalette = {
  keyword: [0.55, 0.72, 1, 0.62],
  string: [0.55, 0.87, 0.62, 0.55],
  number: [0.98, 0.76, 0.4, 0.62],
  comment: [0.56, 0.63, 0.74, 0.34],
  type: [0.45, 0.85, 0.88, 0.55],
  property: [0.7, 0.82, 1, 0.52],
  identifier: [0.88, 0.92, 0.98, 0.44],
  plain: null,
};

/** Dark token colors for bright panel fills. */
const TOKEN_ON_LIGHT: TokenPalette = {
  keyword: [0.1, 0.22, 0.52, 0.66],
  string: [0.08, 0.38, 0.18, 0.62],
  number: [0.45, 0.24, 0.04, 0.66],
  comment: [0.24, 0.3, 0.38, 0.4],
  type: [0.04, 0.34, 0.4, 0.6],
  property: [0.12, 0.28, 0.55, 0.56],
  identifier: [0.04, 0.07, 0.11, 0.5],
  plain: null,
};

const TOKEN_COLUMNS = 92;
const TOKEN_LINE_STEP_PX = 5.4;
const TOKEN_HEADER_PX = 48;
const TOKEN_LINE_HEIGHT_PX = 2.1;
const MAX_TOKEN_QUADS_PER_PANEL = 520;

export class Renderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly gl: WebGL2RenderingContext;
  private workspace: Workspace;
  private spatial: SpatialHash;

  private readonly background: BackgroundPass;
  private readonly panelBatch: PanelBatch;
  private readonly textBatch: TextBatch;
  private readonly atlas: GlyphAtlas;
  private readonly tokens: TokenStore | null;

  private readonly visible: Panel[] = [];
  private lodState: Uint8Array;
  private cssWidth = 1;
  private cssHeight = 1;
  private dpr = 1;

  constructor(
    canvas: HTMLCanvasElement,
    workspace: Workspace,
    spatial: SpatialHash,
    tokens: TokenStore | null = null,
  ) {
    this.canvas = canvas;
    this.workspace = workspace;
    this.spatial = spatial;
    this.tokens = tokens;

    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error('WebGL2 is required to run Spatial IDE');
    this.gl = gl;

    this.background = new BackgroundPass(gl);
    this.panelBatch = new PanelBatch(gl);
    this.textBatch = new TextBatch(gl);
    this.atlas = new GlyphAtlas(gl);
    this.lodState = new Uint8Array(workspace.panels.length);

    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    this.resize();
  }

  resize(): boolean {
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    const width = Math.max(1, window.innerWidth);
    const height = Math.max(1, window.innerHeight);
    const pixelWidth = Math.floor(width * dpr);
    const pixelHeight = Math.floor(height * dpr);

    const changed =
      this.canvas.width !== pixelWidth ||
      this.canvas.height !== pixelHeight ||
      this.cssWidth !== width ||
      this.cssHeight !== height;

    this.cssWidth = width;
    this.cssHeight = height;
    this.dpr = dpr;

    if (this.canvas.width !== pixelWidth) this.canvas.width = pixelWidth;
    if (this.canvas.height !== pixelHeight) this.canvas.height = pixelHeight;
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.gl.viewport(0, 0, pixelWidth, pixelHeight);

    return changed;
  }

  get viewportWidth(): number {
    return this.cssWidth;
  }

  get viewportHeight(): number {
    return this.cssHeight;
  }

  setWorkspace(workspace: Workspace, spatial: SpatialHash): void {
    this.workspace = workspace;
    this.spatial = spatial;
    this.lodState = new Uint8Array(workspace.panels.length);
    this.visible.length = 0;
  }

  /** Swaps in a rebuilt spatial hash without clearing LOD hysteresis. */
  setSpatial(spatial: SpatialHash): void {
    this.spatial = spatial;
  }

  render(camera: Camera, hoveredId: number, selectedId: number): RenderStats {
    const gl = this.gl;
    const vw = this.cssWidth;
    const vh = this.cssHeight;

    gl.clearColor(THEME.background[0], THEME.background[1], THEME.background[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    this.background.draw(camera, vw, vh, this.dpr);

    const [worldX, worldY] = camera.screenToWorld(0, 0);
    const worldW = vw / camera.zoom;
    const worldH = vh / camera.zoom;

    this.panelBatch.begin();
    const badges: GroupBadge[] = [];
    const diagnosticBadges: DiagnosticBadge[] = [];
    const badgeCharW = this.atlas.advance * (11 / this.atlas.fontPx);

    // Group frames sit behind their panels and provide spatial anchoring.
    for (const group of this.workspace.groups) {
      const [sx, sy] = camera.worldToScreen(group.x, group.y);
      const sw = group.w * camera.zoom;
      const sh = group.h * camera.zoom;
      if (sx + sw < -24 || sy + sh < -24 || sx > vw + 24 || sy > vh + 24) continue;

      const base = group.color;
      const fill: Rgba = [
        (base[0] / 255) * 0.16 + 0.012,
        (base[1] / 255) * 0.16 + 0.016,
        (base[2] / 255) * 0.16 + 0.022,
        0.62,
      ];
      const border: Rgba = [
        (base[0] / 255) * 0.62,
        (base[1] / 255) * 0.62,
        (base[2] / 255) * 0.62,
        0.38,
      ];
      this.panelBatch.add(group.x, group.y, group.w, group.h, fill, border, 1, 12);

      // Screen-space group badge, drawn on top of panels below.
      if (sw >= 180) {
        const maxTextW = Math.max(20, sw - 30);
        const textW = Math.min(group.path.length * badgeCharW, maxTextW);
        const badgeW = textW + 14;
        const badgeH = 18;
        const bx = sx + 8;
        const by = sy + 2;
        if (bx + badgeW > 0 && by + badgeH > 0 && bx < vw && by < vh) {
          badges.push({
            x: bx,
            y: by,
            w: badgeW,
            h: badgeH,
            text: group.path,
            color: [
              Math.min(1, (base[0] / 255) * 0.7 + 0.3),
              Math.min(1, (base[1] / 255) * 0.7 + 0.3),
              Math.min(1, (base[2] / 255) * 0.7 + 0.3),
              0.95,
            ],
            border: [
              (base[0] / 255) * 0.7,
              (base[1] / 255) * 0.7,
              (base[2] / 255) * 0.7,
              0.45,
            ],
          });
        }
      }
    }

    const candidates = this.spatial.query(worldX, worldY, worldW, worldH);
    this.visible.length = 0;
    const lods: [number, number, number, number] = [0, 0, 0, 0];

    for (const index of candidates) {
      const panel = this.workspace.panels[index];
      if (!panel) continue;
      if (
        panel.x + panel.w < worldX ||
        panel.x > worldX + worldW ||
        panel.y + panel.h < worldY ||
        panel.y > worldY + worldH
      ) {
        continue;
      }

      const screenW = panel.w * camera.zoom;
      const screenH = panel.h * camera.zoom;
      if (screenW < 1 || screenH < 1) continue;

      this.visible.push(panel);
      const lod = lodWithHysteresis((this.lodState[index] ?? 0) as Lod, screenW);
      this.lodState[index] = lod;
      lods[lod] += 1;

      this.panelBatch.add(
        panel.x,
        panel.y,
        panel.w,
        panel.h,
        panelFill(panel, lod),
        panelBorder(panel, lod),
        lod === 0 ? 1 : 1.5,
        lod === 0 ? 4 : 7,
      );

      if (lod >= 1) {
        if (lod >= 2) {
          this.tokens?.request(panel);
          const runs = this.tokens?.get(panel.path) ?? null;
          if (runs && runs.length > 0) {
            this.addTokenRuns(panel, runs, screenH, camera);
          } else {
            this.addCodeSilhouette(panel, lod, screenH, camera);
          }

          const diagnostics = this.tokens?.getDiagnostics(panel.path) ?? null;
          if (diagnostics && diagnostics.length > 0) {
            this.addDiagnosticUnderlines(panel, diagnostics, screenH, camera);

            const [badgeX, badgeY] = camera.worldToScreen(panel.x + panel.w, panel.y);
            const text = diagnostics.length > 99 ? '99+' : String(diagnostics.length);
            const badgeW = 9 + text.length * 6.2;
            const badgeH = 16;
            const bx = badgeX - badgeW - 8;
            const by = badgeY + 7;
            if (bx + badgeW > 0 && by + badgeH > 0 && bx < vw && by < vh) {
              diagnosticBadges.push({ x: bx, y: by, w: badgeW, h: badgeH, text });
            }
          }
          continue;
        }
        this.addCodeSilhouette(panel, lod, screenH, camera);
      }
    }

    const ringExpand = 2.5 / camera.zoom;
    const hovered = hoveredId >= 0 ? this.workspace.panels[hoveredId] : undefined;
    const selected = selectedId >= 0 ? this.workspace.panels[selectedId] : undefined;

    if (hovered) {
      this.addRing(hovered, ringExpand, THEME.hover, 1.5, 0.8);
    }
    if (selected) {
      this.addRing(selected, ringExpand, THEME.selection, 2, 1);
    }

    const badgeFill: Rgba = [0.014, 0.021, 0.033, 0.88];
    for (const badge of badges) {
      const wx = (badge.x - vw / 2) / camera.zoom + camera.x;
      const wy = (badge.y - vh / 2) / camera.zoom + camera.y;
      this.panelBatch.add(
        wx,
        wy,
        badge.w / camera.zoom,
        badge.h / camera.zoom,
        badgeFill,
        badge.border,
        1,
        5,
      );
    }

    const errorBadgeFill: Rgba = [0.66, 0.14, 0.13, 0.94];
    const errorBadgeBorder: Rgba = [1, 0.44, 0.4, 0.9];
    for (const badge of diagnosticBadges) {
      const wx = (badge.x - vw / 2) / camera.zoom + camera.x;
      const wy = (badge.y - vh / 2) / camera.zoom + camera.y;
      this.panelBatch.add(
        wx,
        wy,
        badge.w / camera.zoom,
        badge.h / camera.zoom,
        errorBadgeFill,
        errorBadgeBorder,
        1,
        5,
      );
    }

    const worldInstances = this.panelBatch.flush(camera, vw, vh);
    let drawCalls = 2; // background + world batch

    this.textBatch.begin();

    for (const badge of badges) {
      this.textBatch.addString(
        this.atlas,
        badge.text,
        badge.x + 7,
        badge.y + 3,
        11,
        badge.color,
        badge.w - 14,
      );
    }

    for (const badge of diagnosticBadges) {
      this.textBatch.addString(
        this.atlas,
        badge.text,
        badge.x + 4.5,
        badge.y + 2.5,
        10.5,
        [1, 0.91, 0.89, 1],
        badge.w - 8,
      );
    }

    let labeled = 0;
    for (const panel of this.visible) {
      if (labeled >= MAX_LABELS) break;
      const screenW = panel.w * camera.zoom;
      if (screenW < 64) continue;
      const lod = (this.lodState[panel.id] ?? 0) as Lod;
      if (lod < 1) continue;

      const [sx, sy] = camera.worldToScreen(panel.x, panel.y);
      const screenH = panel.h * camera.zoom;
      if (sx + screenW < 0 || sy + screenH < 0 || sx > vw || sy > vh) continue;

      const alpha = smoothstep(64, 112, screenW) * 0.96;
      const displayPx = lod >= 2 ? 14 : 12;
      const fill = panelFill(panel, lod);
      const luminance = 0.2126 * fill[0] + 0.7152 * fill[1] + 0.0722 * fill[2];
      const lightText = luminance <= 0.48;
      const color: Rgba = lightText
        ? [THEME.text[0], THEME.text[1], THEME.text[2], alpha]
        : [0.045, 0.06, 0.09, alpha];
      this.textBatch.addString(
        this.atlas,
        panel.name,
        sx + 9,
        sy + 7,
        displayPx,
        color,
        screenW - 18,
      );

      if (lod >= 2 && screenW > 190) {
        const muted: Rgba = lightText
          ? [THEME.textMuted[0], THEME.textMuted[1], THEME.textMuted[2], alpha * 0.62]
          : [0.09, 0.11, 0.15, alpha * 0.7];
        this.textBatch.addString(
          this.atlas,
          panel.path,
          sx + 9,
          sy + 8 + displayPx * 1.6,
          10.5,
          muted,
          screenW - 18,
        );
      }
      labeled += 1;
    }

    const glyphs = this.textBatch.flush(vw, vh, this.atlas);
    if (glyphs > 0) drawCalls += 1;

    return {
      visible: this.visible.length,
      total: this.workspace.panels.length,
      groups: this.workspace.groups.length,
      drawCalls,
      instances: worldInstances,
      glyphs,
      lods,
    };
  }

  /**
   * Real tree-sitter token runs. Columns are mapped onto a fixed 92-column
   * grid so the silhouette reads like code without measuring every line.
   */
  private addTokenRuns(
    panel: Panel,
    runs: readonly TokenRun[],
    screenH: number,
    camera: Camera,
  ): void {
    const zoom = camera.zoom;
    const maxLines = Math.floor(
      (screenH - TOKEN_HEADER_PX - 6) / TOKEN_LINE_STEP_PX,
    );
    if (maxLines <= 0) return;

    const fill = panelFill(panel, 2);
    const luminance = 0.2126 * fill[0] + 0.7152 * fill[1] + 0.0722 * fill[2];
    const palette = luminance <= 0.48 ? TOKEN_ON_DARK : TOKEN_ON_LIGHT;
    const charWidth = (panel.w * 0.92) / TOKEN_COLUMNS;
    const baseX = panel.x + panel.w * 0.04;
    const lineHeight = TOKEN_LINE_HEIGHT_PX / zoom;
    const transparent: Rgba = [0, 0, 0, 0];
    let drawn = 0;

    for (const run of runs) {
      if (run.line >= maxLines || drawn >= MAX_TOKEN_QUADS_PER_PANEL) break;
      const color = palette[run.kind];
      if (!color) continue;

      const start = Math.max(0, Math.min(TOKEN_COLUMNS, run.start));
      const end = Math.max(start, Math.min(TOKEN_COLUMNS, run.end));
      if (end <= start) continue;

      const y = panel.y + (TOKEN_HEADER_PX + run.line * TOKEN_LINE_STEP_PX) / zoom;
      this.panelBatch.add(
        baseX + start * charWidth,
        y,
        (end - start) * charWidth,
        lineHeight,
        color,
        transparent,
        0,
        0,
      );
      drawn += 1;
    }
  }

  /**
   * Red underlines under tree-sitter error ranges, aligned to the token grid.
   */
  private addDiagnosticUnderlines(
    panel: Panel,
    diagnostics: readonly Diagnostic[],
    screenH: number,
    camera: Camera,
  ): void {
    const maxLines = Math.floor(
      (screenH - TOKEN_HEADER_PX - 6) / TOKEN_LINE_STEP_PX,
    );
    if (maxLines <= 0) return;

    const zoom = camera.zoom;
    const charWidth = (panel.w * 0.92) / TOKEN_COLUMNS;
    const baseX = panel.x + panel.w * 0.04;
    const lineHeight = 1.7 / zoom;
    const transparent: Rgba = [0, 0, 0, 0];
    const color: Rgba = [1, 0.32, 0.28, 0.95];

    for (const diagnostic of diagnostics) {
      if (diagnostic.line >= maxLines) continue;
      const start = Math.max(0, Math.min(TOKEN_COLUMNS, diagnostic.start));
      const end = Math.max(start + 1, Math.min(TOKEN_COLUMNS, diagnostic.end));
      if (end <= start) continue;

      const lineY =
        panel.y +
        (TOKEN_HEADER_PX + diagnostic.line * TOKEN_LINE_STEP_PX) / zoom;
      const y =
        panel.y +
        (TOKEN_HEADER_PX +
          diagnostic.line * TOKEN_LINE_STEP_PX +
          TOKEN_LINE_STEP_PX -
          2.2) /
          zoom;

      // Margin tick makes the error line readable even when the token run
      // above it happens to be a similar warm color.
      this.panelBatch.add(
        panel.x + panel.w * 0.014,
        lineY,
        2.5 / zoom,
        4.2 / zoom,
        color,
        transparent,
        0,
        0,
      );
      this.panelBatch.add(
        baseX + start * charWidth,
        y,
        (end - start) * charWidth,
        lineHeight,
        color,
        transparent,
        0,
        0,
      );
    }
  }

  /**
   * Fallback silhouette used before tokens arrive and for languages without a
   * tree-sitter grammar. The geometry matches the token renderer's grid.
   */
  private addCodeSilhouette(
    panel: Panel,
    lod: Lod,
    screenH: number,
    camera: Camera,
  ): void {
    if (lod === 0) return;
    const zoom = camera.zoom;
    const lineHeightPx = lod >= 2 ? 2.2 : 1.6;
    const stepPx = lod >= 2 ? 5.4 : 4.2;
    const headerPx = lod >= 2 ? 48 : 24;
    const maxLines = Math.min(180, Math.floor((screenH - headerPx - 6) / stepPx));
    if (maxLines <= 0) return;

    const fill = panelFill(panel, lod);
    const luminance = 0.2126 * fill[0] + 0.7152 * fill[1] + 0.0722 * fill[2];
    const base: Rgba =
      luminance > 0.48 ? [0.035, 0.05, 0.08, 0.34] : [0.9, 0.94, 1, 0.2];
    const changed: Rgba | null =
      panel.git === 'modified'
        ? [0.98, 0.72, 0.26, 0.55]
        : panel.git === 'added'
          ? [0.36, 0.86, 0.55, 0.5]
          : panel.git === 'deleted'
            ? [0.98, 0.4, 0.4, 0.5]
            : null;
    const transparent: Rgba = [0, 0, 0, 0];

    for (let line = 0; line < maxLines; line += 1) {
      const seed = (panel.id * 2654435761 + line * 40503) >>> 0;
      const indent = (seed % 11) * 0.02;
      const widthFraction = 0.16 + ((seed >>> 4) % 76) / 100;
      const width = Math.min(0.96 - indent - 0.035, widthFraction);
      if (width <= 0.05) continue;
      const x = panel.x + (0.035 + indent) * panel.w;
      const y = panel.y + (headerPx + line * stepPx) / zoom;
      const color = changed && seed % 23 === 0 ? changed : base;
      this.panelBatch.add(
        x,
        y,
        width * panel.w,
        lineHeightPx / zoom,
        color,
        transparent,
        0,
        0,
      );
    }
  }

  private addRing(
    panel: Panel,
    expand: number,
    color: readonly [number, number, number],
    widthPx: number,
    alpha: number,
  ): void {
    const transparent: Rgba = [0, 0, 0, 0];
    const border: Rgba = [color[0], color[1], color[2], alpha];
    this.panelBatch.add(
      panel.x - expand,
      panel.y - expand,
      panel.w + expand * 2,
      panel.h + expand * 2,
      transparent,
      border,
      widthPx,
      9,
    );
  }
}
