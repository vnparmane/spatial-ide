import type { GlyphAtlas } from './atlas';
import type { Rgba } from './theme';
import { createProgram, requireUniform } from './gl';

const MAX_INSTANCES = 20000;
const FLOATS_PER_INSTANCE = 12;

const VERTEX_SOURCE = `#version 300 es
precision highp float;

layout(location = 0) in vec2 a_pos;
layout(location = 1) in vec4 a_rect;
layout(location = 2) in vec4 a_uv;
layout(location = 3) in vec4 a_color;

uniform vec2 u_viewport;

out vec2 v_uv;
out vec4 v_color;

void main() {
  vec2 screen = a_rect.xy + a_pos * a_rect.zw;
  vec2 clip = (screen / u_viewport) * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  v_uv = mix(a_uv.xy, a_uv.zw, a_pos);
  v_color = a_color;
}`;

const FRAGMENT_SOURCE = `#version 300 es
precision highp float;

uniform sampler2D u_atlas;

in vec2 v_uv;
in vec4 v_color;
out vec4 outColor;

void main() {
  float alpha = texture(u_atlas, v_uv).a;
  outColor = vec4(v_color.rgb, v_color.a * alpha);
}`;

/**
 * Screen-space glyph quads. Labels are drawn at a constant size regardless of
 * camera zoom, which is what keeps file names legible while zooming out.
 */
export class TextBatch {
  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly vao: WebGLVertexArrayObject;
  private readonly instanceBuffer: WebGLBuffer;
  private readonly data = new Float32Array(MAX_INSTANCES * FLOATS_PER_INSTANCE);
  private readonly max: number;
  private count = 0;

  private readonly uViewport: WebGLUniformLocation;
  private readonly uAtlas: WebGLUniformLocation;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.max = MAX_INSTANCES;
    this.program = createProgram(gl, VERTEX_SOURCE, FRAGMENT_SOURCE);

    const quad = gl.createBuffer();
    if (!quad) throw new Error('Failed to create text quad buffer');
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]),
      gl.STATIC_DRAW,
    );

    const instanceBuffer = gl.createBuffer();
    if (!instanceBuffer) throw new Error('Failed to create text instance buffer');
    this.instanceBuffer = instanceBuffer;

    const vao = gl.createVertexArray();
    if (!vao) throw new Error('Failed to create text VAO');
    this.vao = vao;
    gl.bindVertexArray(vao);

    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.data.byteLength, gl.DYNAMIC_DRAW);
    const stride = FLOATS_PER_INSTANCE * 4;
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, stride, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, stride, 16);
    gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 4, gl.FLOAT, false, stride, 32);
    gl.vertexAttribDivisor(3, 1);

    gl.bindVertexArray(null);

    this.uViewport = requireUniform(gl, this.program, 'u_viewport');
    this.uAtlas = requireUniform(gl, this.program, 'u_atlas');
  }

  begin(): void {
    this.count = 0;
  }

  private addGlyph(
    x: number,
    y: number,
    w: number,
    h: number,
    u0: number,
    v0: number,
    u1: number,
    v1: number,
    color: Rgba,
  ): void {
    if (this.count >= this.max) return;
    const offset = this.count * FLOATS_PER_INSTANCE;
    const data = this.data;
    data[offset] = x;
    data[offset + 1] = y;
    data[offset + 2] = w;
    data[offset + 3] = h;
    data[offset + 4] = u0;
    data[offset + 5] = v0;
    data[offset + 6] = u1;
    data[offset + 7] = v1;
    data[offset + 8] = color[0];
    data[offset + 9] = color[1];
    data[offset + 10] = color[2];
    data[offset + 11] = color[3];
    this.count += 1;
  }

  /** Draws a string at a constant screen size. Returns the drawn width. */
  addString(
    atlas: GlyphAtlas,
    text: string,
    x: number,
    y: number,
    displayPx: number,
    color: Rgba,
    maxWidth = Number.POSITIVE_INFINITY,
  ): number {
    const scale = displayPx / atlas.fontPx;
    const charW = atlas.advance * scale;
    const charH = atlas.cellH * scale;
    if (charW <= 0 || charH <= 0) return 0;

    const maxChars = Math.floor(maxWidth / charW);
    let value = text;
    if (value.length > maxChars) {
      value = maxChars <= 1 ? '…' : `${value.slice(0, maxChars - 1)}…`;
    }

    for (let i = 0; i < value.length; i += 1) {
      const char = value[i];
      if (!char) continue;
      const glyph = atlas.glyph(char);
      if (!glyph) continue;
      this.addGlyph(
        x + i * charW,
        y,
        charW,
        charH,
        glyph.u0,
        glyph.v0,
        glyph.u1,
        glyph.v1,
        color,
      );
    }

    return value.length * charW;
  }

  flush(viewportWidth: number, viewportHeight: number, atlas: GlyphAtlas): number {
    if (this.count === 0) return 0;
    const gl = this.gl;
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    gl.bufferSubData(
      gl.ARRAY_BUFFER,
      0,
      this.data.subarray(0, this.count * FLOATS_PER_INSTANCE),
    );
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, atlas.texture);
    gl.uniform1i(this.uAtlas, 0);
    gl.uniform2f(this.uViewport, viewportWidth, viewportHeight);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.count);
    gl.bindVertexArray(null);
    return this.count;
  }
}
