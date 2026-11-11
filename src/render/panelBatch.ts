import type { Camera } from '../scene/camera';
import type { Rgba } from './theme';
import { createProgram, requireUniform } from './gl';

const MAX_INSTANCES = 32768;
const FLOATS_PER_INSTANCE = 14;

const VERTEX_SOURCE = `#version 300 es
precision highp float;

layout(location = 0) in vec2 a_pos;
layout(location = 1) in vec4 a_rect;
layout(location = 2) in vec4 a_fill;
layout(location = 3) in vec4 a_border;
layout(location = 4) in vec2 a_params;

uniform vec2 u_viewport;
uniform vec2 u_camera;
uniform float u_zoom;

out vec2 v_uv;
out vec2 v_size;
flat out vec4 v_fill;
flat out vec4 v_border;
flat out vec2 v_params;

void main() {
  vec2 world = a_rect.xy + a_pos * a_rect.zw;
  vec2 screen = (world - u_camera) * u_zoom + u_viewport * 0.5;
  vec2 clip = (screen / u_viewport) * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  v_uv = a_pos;
  v_size = a_rect.zw * u_zoom;
  v_fill = a_fill;
  v_border = a_border;
  v_params = a_params;
}`;

const FRAGMENT_SOURCE = `#version 300 es
precision highp float;

in vec2 v_uv;
in vec2 v_size;
flat in vec4 v_fill;
flat in vec4 v_border;
flat in vec2 v_params;

out vec4 outColor;

float sdRoundRect(vec2 p, vec2 halfSize, float radius) {
  vec2 q = abs(p) - halfSize + radius;
  return length(max(q, vec2(0.0))) + min(max(q.x, q.y), 0.0) - radius;
}

void main() {
  vec2 p = (v_uv - 0.5) * v_size;
  float radius = min(v_params.y, min(v_size.x, v_size.y) * 0.5);
  float distanceToEdge = sdRoundRect(p, v_size * 0.5, radius);
  float coverage = 1.0 - smoothstep(-0.75, 0.75, distanceToEdge);
  if (coverage <= 0.001) discard;

  float border = 1.0 - smoothstep(v_params.x - 0.75, v_params.x + 0.75, -distanceToEdge);
  vec3 color = mix(v_fill.rgb, v_border.rgb, border);
  float alpha = mix(v_fill.a, v_border.a, border) * coverage;
  outColor = vec4(color, alpha);
}`;

/**
 * Instanced rounded-rect batch used for panels, group frames, and rings.
 * All geometry lives in world space; border width and corner radius are
 * expressed in screen pixels so edges stay crisp at every zoom level.
 */
export class PanelBatch {
  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly vao: WebGLVertexArrayObject;
  private readonly instanceBuffer: WebGLBuffer;
  private readonly data = new Float32Array(MAX_INSTANCES * FLOATS_PER_INSTANCE);
  private readonly max: number;
  private count = 0;

  private readonly uViewport: WebGLUniformLocation;
  private readonly uCamera: WebGLUniformLocation;
  private readonly uZoom: WebGLUniformLocation;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.max = MAX_INSTANCES;
    this.program = createProgram(gl, VERTEX_SOURCE, FRAGMENT_SOURCE);

    const quad = gl.createBuffer();
    if (!quad) throw new Error('Failed to create quad buffer');
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]),
      gl.STATIC_DRAW,
    );

    const instanceBuffer = gl.createBuffer();
    if (!instanceBuffer) throw new Error('Failed to create instance buffer');
    this.instanceBuffer = instanceBuffer;

    const vao = gl.createVertexArray();
    if (!vao) throw new Error('Failed to create panel VAO');
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
    gl.enableVertexAttribArray(4);
    gl.vertexAttribPointer(4, 2, gl.FLOAT, false, stride, 48);
    gl.vertexAttribDivisor(4, 1);

    gl.bindVertexArray(null);

    this.uViewport = requireUniform(gl, this.program, 'u_viewport');
    this.uCamera = requireUniform(gl, this.program, 'u_camera');
    this.uZoom = requireUniform(gl, this.program, 'u_zoom');
  }

  begin(): void {
    this.count = 0;
  }

  add(
    x: number,
    y: number,
    w: number,
    h: number,
    fill: Rgba,
    border: Rgba,
    borderWidthPx: number,
    radiusPx: number,
  ): void {
    if (this.count >= this.max) return;
    const offset = this.count * FLOATS_PER_INSTANCE;
    const data = this.data;
    data[offset] = x;
    data[offset + 1] = y;
    data[offset + 2] = w;
    data[offset + 3] = h;
    data[offset + 4] = fill[0];
    data[offset + 5] = fill[1];
    data[offset + 6] = fill[2];
    data[offset + 7] = fill[3];
    data[offset + 8] = border[0];
    data[offset + 9] = border[1];
    data[offset + 10] = border[2];
    data[offset + 11] = border[3];
    data[offset + 12] = borderWidthPx;
    data[offset + 13] = radiusPx;
    this.count += 1;
  }

  flush(camera: Camera, viewportWidth: number, viewportHeight: number): number {
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
    gl.uniform2f(this.uViewport, viewportWidth, viewportHeight);
    gl.uniform2f(this.uCamera, camera.x, camera.y);
    gl.uniform1f(this.uZoom, camera.zoom);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.count);
    gl.bindVertexArray(null);
    return this.count;
  }
}
