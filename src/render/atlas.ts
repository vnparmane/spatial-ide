export interface Glyph {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  cellW: number;
  cellH: number;
  advance: number;
}

/**
 * Monospace ASCII atlas rasterized once at 2x the label size.
 * Labels are drawn at a constant screen size, so one atlas covers phase 0.
 */
export class GlyphAtlas {
  readonly texture: WebGLTexture;
  readonly glyphs = new Map<string, Glyph>();
  readonly fontPx: number;
  readonly cellW: number;
  readonly cellH: number;
  readonly advance: number;

  constructor(gl: WebGL2RenderingContext, fontPx = 28) {
    this.fontPx = fontPx;
    const font = `500 ${fontPx}px "Cascadia Mono", Consolas, "Courier New", monospace`;

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas unavailable for glyph atlas');

    ctx.font = font;
    this.advance = ctx.measureText('M').width;
    this.cellW = Math.ceil(this.advance);
    this.cellH = Math.ceil(fontPx * 1.4);

    const chars: string[] = [];
    for (let code = 32; code <= 126; code += 1) chars.push(String.fromCharCode(code));
    chars.push('…');

    const atlasWidth = 1024;
    const columns = Math.max(1, Math.floor(atlasWidth / this.cellW));
    const rows = Math.ceil(chars.length / columns);
    canvas.width = atlasWidth;
    canvas.height = rows * this.cellH;

    // Resizing resets the 2D context, so restore all state after setting size.
    ctx.font = font;
    ctx.fillStyle = '#ffffff';
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';

    chars.forEach((char, index) => {
      const column = index % columns;
      const row = Math.floor(index / columns);
      const x = column * this.cellW;
      const y = row * this.cellH;
      ctx.fillText(char, x, y + fontPx * 0.96);
      this.glyphs.set(char, {
        u0: x / canvas.width,
        v0: y / canvas.height,
        u1: (x + this.advance) / canvas.width,
        v1: (y + this.cellH) / canvas.height,
        cellW: this.cellW,
        cellH: this.cellH,
        advance: this.advance,
      });
    });

    const texture = gl.createTexture();
    if (!texture) throw new Error('Failed to create glyph texture');
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.texture = texture;
  }

  glyph(char: string): Glyph | undefined {
    return this.glyphs.get(char) ?? this.glyphs.get('?');
  }
}
