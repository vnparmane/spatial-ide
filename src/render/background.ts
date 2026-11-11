import type { Camera } from '../scene/camera';
import { THEME } from './theme';
import { createProgram, requireUniform } from './gl';

const VERTEX_SOURCE = `#version 300 es
precision highp float;

void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAGMENT_SOURCE = `#version 300 es
precision highp float;

uniform vec2 u_viewport;
uniform float u_dpr;
uniform vec2 u_camera;
uniform float u_zoom;
uniform float u_spacing;
uniform vec3 u_background;
uniform vec3 u_grid;

out vec4 outColor;

float gridMask(vec2 world, float spacing) {
  vec2 coord = world / spacing;
  vec2 delta = abs(fract(coord - 0.5) - 0.5) / fwidth(coord);
  return 1.0 - min(min(delta.x, delta.y), 1.0);
}

void main() {
  vec2 screen = gl_FragCoord.xy / u_dpr;
  vec2 world = (screen - u_viewport * 0.5) / u_zoom + u_camera;

  float minor = gridMask(world, u_spacing) * 0.45;
  float major = gridMask(world, u_spacing * 5.0) * 0.9;

  vec3 color = u_background;
  color = mix(color, u_grid, minor);
  color = mix(color, u_grid, major);

  vec2 uv = screen / u_viewport;
  float vignette = smoothstep(1.1, 0.2, length(uv - 0.5) * 1.5);
  color *= 0.72 + 0.28 * vignette;

  outColor = vec4(color, 1.0);
}`;

export class BackgroundPass {
  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly vao: WebGLVertexArrayObject;
  private readonly uViewport: WebGLUniformLocation;
  private readonly uDpr: WebGLUniformLocation;
  private readonly uCamera: WebGLUniformLocation;
  private readonly uZoom: WebGLUniformLocation;
  private readonly uSpacing: WebGLUniformLocation;
  private readonly uBackground: WebGLUniformLocation;
  private readonly uGrid: WebGLUniformLocation;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.program = createProgram(gl, VERTEX_SOURCE, FRAGMENT_SOURCE);
    const vao = gl.createVertexArray();
    if (!vao) throw new Error('Failed to create background VAO');
    this.vao = vao;

    this.uViewport = requireUniform(gl, this.program, 'u_viewport');
    this.uDpr = requireUniform(gl, this.program, 'u_dpr');
    this.uCamera = requireUniform(gl, this.program, 'u_camera');
    this.uZoom = requireUniform(gl, this.program, 'u_zoom');
    this.uSpacing = requireUniform(gl, this.program, 'u_spacing');
    this.uBackground = requireUniform(gl, this.program, 'u_background');
    this.uGrid = requireUniform(gl, this.program, 'u_grid');
  }

  draw(camera: Camera, viewportWidth: number, viewportHeight: number, dpr: number): void {
    let spacing = 100;
    while (spacing * camera.zoom < 48) spacing *= 10;
    while (spacing * camera.zoom > 480) spacing /= 10;

    const gl = this.gl;
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.uniform2f(this.uViewport, viewportWidth, viewportHeight);
    gl.uniform1f(this.uDpr, dpr);
    gl.uniform2f(this.uCamera, camera.x, camera.y);
    gl.uniform1f(this.uZoom, camera.zoom);
    gl.uniform1f(this.uSpacing, spacing);
    gl.uniform3f(this.uBackground, THEME.background[0], THEME.background[1], THEME.background[2]);
    gl.uniform3f(this.uGrid, THEME.grid[0], THEME.grid[1], THEME.grid[2]);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }
}
