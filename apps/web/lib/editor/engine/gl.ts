import { vignetteAngle, temperatureGains, type ResolvedGrade } from "@chris/media/timeline";

/**
 * The compositor's single WebGL2 surface. One draw per frame:
 *   footage (clip crop → punch-in zoom → grade → vignette, the renderer's exact math)
 *   + baked motion graphics (colour over stacked alpha, straight alpha blend)
 * Texts and captions stay in the SVG overlay above (measured cheap; they carry the touch
 * targets) and are driven by the same clock tick.
 *
 * Grade = the renderer's filter chain as a fragment shader: linear contrast/brightness
 * (slope c, intercept 0.5(1−c)+b) → saturate matrix (sRGB luma weights, SVG/ffmpeg) →
 * temperature gains → cos⁴ vignette over the half-diagonal. Done on the GPU for free, instead
 * of an SVG filter over a <video> (which WebKit runs on the CPU).
 */

const VS = `#version 300 es
in vec2 a;
out vec2 p;
void main() {
  p = vec2(a.x * 0.5 + 0.5, 0.5 - a.y * 0.5);
  gl_Position = vec4(a, 0.0, 1.0);
}`;

const FS_VIDEO = `#version 300 es
precision highp float;
in vec2 p;
out vec4 o;
uniform sampler2D tex;
uniform vec4 rect;     // footage rect in canvas fractions: x, y, w, h
uniform vec4 uvRect;   // texture sub-rect (sprite tile) : x, y, w, h
uniform vec3 zoom;     // z, focal x, focal y
uniform vec2 lin;      // slope, intercept
uniform float sat;
uniform vec3 gains;
uniform float vigAngle;
uniform vec2 aspect;   // canvas w, h
uniform float hasTex;
void main() {
  vec2 f = zoom.yz;
  vec2 q = f + (p - f) / zoom.x;
  vec2 uv = (q - rect.xy) / rect.zw;
  vec3 c = vec3(0.0);
  if (hasTex > 0.5 && uv.x >= 0.0 && uv.y >= 0.0 && uv.x <= 1.0 && uv.y <= 1.0) {
    c = texture(tex, uvRect.xy + uv * uvRect.zw).rgb;
  }
  c = clamp(c * lin.x + lin.y, 0.0, 1.0);
  float s = sat;
  mat3 m = mat3(
    0.2126 + 0.7874 * s, 0.2126 - 0.2126 * s, 0.2126 - 0.2126 * s,
    0.7152 - 0.7152 * s, 0.7152 + 0.2848 * s, 0.7152 - 0.7152 * s,
    0.0722 - 0.0722 * s, 0.0722 - 0.0722 * s, 0.0722 + 0.9278 * s);
  c = clamp(m * c, 0.0, 1.0);
  c = clamp(c * gains, 0.0, 1.0);
  if (vigAngle > 0.0) {
    vec2 d = (p - 0.5) * aspect;
    float nd = min(1.0, length(d) / length(aspect * 0.5));
    float k = cos(vigAngle * nd);
    c *= k * k * k * k;
  }
  o = vec4(c, 1.0);
}`;

const FS_SPRITE = `#version 300 es
precision highp float;
in vec2 p;
out vec4 o;
uniform sampler2D tex;
void main() {
  vec3 c = texture(tex, vec2(p.x, p.y * 0.5)).rgb;
  // alpha was encoded as grey in the bottom half; the decoder's YUV→RGB already expanded it
  float a = clamp(texture(tex, vec2(p.x, 0.5 + p.y * 0.5)).r, 0.0, 1.0);
  o = vec4(c * a, a);
}`;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`shader: ${gl.getShaderInfoLog(s)}`);
  return s;
}

function program(gl: WebGL2RenderingContext, fs: string): WebGLProgram {
  const p = gl.createProgram()!;
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VS));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.bindAttribLocation(p, 0, "a");
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`link: ${gl.getProgramInfoLog(p)}`);
  return p;
}

export interface FootageDraw {
  /** footage rect in canvas fractions */
  rect: { x: number; y: number; w: number; h: number };
  uvRect: { x: number; y: number; w: number; h: number };
  zoom: { zoom: number; x: number; y: number };
  grade: ResolvedGrade;
}

export type TexSource = TexImageSource | VideoFrame;

export class GlCompositor {
  readonly canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext;
  private pVideo: WebGLProgram;
  private pSprite: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private texFootage: WebGLTexture;
  private texPoster: WebGLTexture;
  private spriteTex = new Map<string, WebGLTexture>();
  private u: Record<string, WebGLUniformLocation | null> = {};
  footageReady = false;
  posterReady = false;
  lost = false;
  /** canvas size in CSS px (aspect for the vignette) */
  private cssW = 1;
  private cssH = 1;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const gl = canvas.getContext("webgl2", { alpha: false, antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: false, powerPreference: "high-performance" });
    if (!gl) throw new Error("WebGL2 unavailable");
    this.gl = gl;
    this.pVideo = program(gl, FS_VIDEO);
    this.pSprite = program(gl, FS_SPRITE);
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.texFootage = this.newTex();
    this.texPoster = this.newTex();
    for (const n of ["tex", "rect", "uvRect", "zoom", "lin", "sat", "gains", "vigAngle", "aspect", "hasTex"]) this.u[n] = gl.getUniformLocation(this.pVideo, n);
    this.u.spriteTex = gl.getUniformLocation(this.pSprite, "tex");
    canvas.addEventListener("webglcontextlost", (e) => {
      e.preventDefault();
      this.lost = true;
    });
  }

  private newTex(): WebGLTexture {
    const gl = this.gl;
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  resize(cssW: number, cssH: number, dpr: number) {
    this.cssW = Math.max(1, cssW);
    this.cssH = Math.max(1, cssH);
    const w = Math.max(1, Math.round(cssW * dpr));
    const h = Math.max(1, Math.round(cssH * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  private upload(tex: WebGLTexture, src: TexSource) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src as TexImageSource);
  }

  /** New decoded footage frame (caller closes the VideoFrame right after — this copies it). */
  setFootage(src: TexSource) {
    this.upload(this.texFootage, src);
    this.footageReady = true;
  }

  setPoster(src: TexSource) {
    this.upload(this.texPoster, src);
    this.posterReady = true;
  }

  setSprite(id: string, src: TexSource) {
    let t = this.spriteTex.get(id);
    if (!t) {
      t = this.newTex();
      this.spriteTex.set(id, t);
    }
    this.upload(t, src);
  }

  dropSprite(id: string) {
    const t = this.spriteTex.get(id);
    if (t) this.gl.deleteTexture(t);
    this.spriteTex.delete(id);
  }

  /**
   * Draws one frame. `usePoster`: the filmstrip tile stands in until the first decoded frame.
   * `sprites`: baked graphic ids to composite, in order.
   */
  draw(f: FootageDraw | null, usePoster: boolean, sprites: string[]) {
    if (this.lost) return;
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.disable(gl.BLEND);
    gl.useProgram(this.pVideo);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    const tex = usePoster ? this.texPoster : this.texFootage;
    const ready = usePoster ? this.posterReady : this.footageReady;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(this.u.tex!, 0);
    const r = f?.rect ?? { x: 0, y: 0, w: 1, h: 1 };
    const uv = usePoster && f ? f.uvRect : { x: 0, y: 0, w: 1, h: 1 };
    gl.uniform4f(this.u.rect!, r.x, r.y, r.w, r.h);
    gl.uniform4f(this.u.uvRect!, uv.x, uv.y, uv.w, uv.h);
    const z = f?.zoom ?? { zoom: 1, x: 0.5, y: 0.5 };
    gl.uniform3f(this.u.zoom!, z.zoom, z.x, z.y);
    const g = f?.grade ?? { brightness: 0, contrast: 1, saturation: 1, temperature: 0, vignette: 0 };
    gl.uniform2f(this.u.lin!, g.contrast, 0.5 * (1 - g.contrast) + g.brightness);
    gl.uniform1f(this.u.sat!, g.saturation);
    const tg = temperatureGains(g.temperature);
    gl.uniform3f(this.u.gains!, tg.r, tg.g, tg.b);
    gl.uniform1f(this.u.vigAngle!, g.vignette > 0 ? vignetteAngle(g.vignette) : 0);
    gl.uniform2f(this.u.aspect!, this.cssW, this.cssH);
    gl.uniform1f(this.u.hasTex!, ready && f ? 1 : 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    if (sprites.length) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(this.pSprite);
      gl.uniform1i(this.u.spriteTex!, 0);
      for (const id of sprites) {
        const t = this.spriteTex.get(id);
        if (!t) continue;
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
    }
  }

  /** JPEG of the current canvas (cover thumbnails) — the canvas is same-origin pixels. */
  snapshot(width: number): string | null {
    try {
      const c = document.createElement("canvas");
      c.width = width;
      c.height = Math.round((width * this.canvas.height) / this.canvas.width);
      const ctx = c.getContext("2d");
      if (!ctx) return null;
      ctx.drawImage(this.canvas, 0, 0, c.width, c.height);
      return c.toDataURL("image/jpeg", 0.75);
    } catch {
      return null;
    }
  }

  dispose() {
    const gl = this.gl;
    for (const t of this.spriteTex.values()) gl.deleteTexture(t);
    gl.deleteTexture(this.texFootage);
    gl.deleteTexture(this.texPoster);
    gl.deleteProgram(this.pVideo);
    gl.deleteProgram(this.pSprite);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}
