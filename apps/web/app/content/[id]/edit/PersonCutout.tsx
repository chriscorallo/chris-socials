"use client";

import { useEffect, useRef } from "react";
import { cropGeometry } from "@chris/media/timeline";
import { useEditor } from "./context";

/**
 * Preview parity for BEHIND_SUBJECT graphics: Chris cut out of the current frame with his
 * person matte, drawn ABOVE the behind-graphics layer and under the front one — the renderer's
 * order (footage → behind graphics → person → front graphics → texts/captions).
 *
 * One WebGL canvas, two textures: the visible footage <video> from the playback pool (no extra
 * decoder for the picture) and ONE extra muted <video> for the matte (a third element, created
 * only while behind-subject graphics exist — the 2-element pool stays as it is, and a muted
 * element needs no gesture unlock on iOS). The shader applies the clip's crop and the punch-in
 * with the same geometry as the renderer (cropGeometry + zoom about the focal point) and the
 * renderer's matte edge curve, so the cut-out lines up with the picture underneath. The grade
 * is applied with the same SVG filter as the picture.
 *
 * Fails safe: no WebGL, a cross-origin (CORS-less) source that can't be uploaded as a texture,
 * or frames that take too long to draw → `onUnsupported`, and the editor shows behind-graphics
 * in front with a "depth shows in export" note.
 */

const VS = `attribute vec2 p; varying vec2 v; void main(){ v = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }`;
const FS = `precision mediump float;
varying vec2 v;
uniform sampler2D uVideo; uniform sampler2D uMatte;
uniform vec2 uSize; uniform vec2 uFocal; uniform float uZoom; uniform vec2 uOffset; uniform vec2 uScaled;
void main(){
  vec2 px = vec2(v.x, 1.0 - v.y) * uSize;
  vec2 pre = uFocal + (px - uFocal) / uZoom;
  vec2 uv = (pre + uOffset) / uScaled;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) { gl_FragColor = vec4(0.0); return; }
  float m = texture2D(uMatte, uv).r;
  float a = clamp((m - 0.588) * 1.6 + 0.588, 0.0, 1.0);
  vec3 c = texture2D(uVideo, uv).rgb;
  gl_FragColor = vec4(c * a, a);
}`;

function compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader");
  return s;
}

export function PersonCutout({ w, h, behindWindows, gradeOn, onUnsupported }: { w: number; h: number; behindWindows: Array<{ start: number; end: number }>; gradeOn: boolean; onUnsupported: (why: string) => void }) {
  const { engine, doc, assetMap } = useEditor();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const matteRef = useRef<HTMLVideoElement>(null);
  const latest = useRef({ doc, assetMap, behindWindows, onUnsupported });
  useEffect(() => {
    latest.current = { doc, assetMap, behindWindows, onUnsupported };
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    const matte = matteRef.current;
    if (!canvas || !matte) return;
    const gl = canvas.getContext("webgl", { premultipliedAlpha: true, alpha: true, antialias: false });
    if (!gl) {
      latest.current.onUnsupported("no-webgl");
      return;
    }
    let prog: WebGLProgram;
    try {
      prog = gl.createProgram()!;
      gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VS));
      gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FS));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error("link");
    } catch {
      latest.current.onUnsupported("shader");
      return;
    }
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "p");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const tex = [gl.createTexture()!, gl.createTexture()!];
    tex.forEach((t, i) => {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    });
    gl.uniform1i(gl.getUniformLocation(prog, "uVideo"), 0);
    gl.uniform1i(gl.getUniformLocation(prog, "uMatte"), 1);
    const U = (n: string) => gl.getUniformLocation(prog, n);
    const uSize = U("uSize");
    const uFocal = U("uFocal");
    const uZoom = U("uZoom");
    const uOffset = U("uOffset");
    const uScaled = U("uScaled");

    let raf = 0;
    let slowFrames = 0;
    let frames = 0;
    let cleared = true;
    const clear = () => {
      if (cleared) return;
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      cleared = true;
    };
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const { doc: d, assetMap: am, behindWindows: wins } = latest.current;
      const t = engine.time;
      if (!wins.some((x) => t >= x.start - 0.05 && t < x.end + 0.05)) {
        if (!matte.paused) matte.pause();
        clear();
        return;
      }
      const act = engine.activeFrame();
      const clip = act ? d.clips[act.clipIndex] : undefined;
      const asset = clip ? am.get(clip.mediaAssetId) : undefined;
      if (!act || !clip || !asset?.matteUrl) {
        clear();
        return;
      }
      // Keep the matte element on the same take/time as the footage element.
      if (matte.dataset.src !== asset.matteUrl) {
        matte.dataset.src = asset.matteUrl;
        matte.src = asset.matteUrl;
        return;
      }
      const footage = act.el;
      const target = footage.currentTime;
      if (engine.playing) {
        if (matte.paused) void matte.play().catch(() => undefined);
        if (Math.abs(matte.currentTime - target) > 0.12) matte.currentTime = target;
        else matte.playbackRate = matte.currentTime < target - 0.02 ? 1.05 : matte.currentTime > target + 0.02 ? 0.95 : 1;
      } else {
        if (!matte.paused) matte.pause();
        if (Math.abs(matte.currentTime - target) > 0.01 && !matte.seeking) matte.currentTime = target;
      }
      if (footage.readyState < 2 || matte.readyState < 2 || !footage.videoWidth) return;
      const t0 = performance.now();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const W = Math.round(w * dpr);
      const H = Math.round(h * dpr);
      if (canvas.width !== W || canvas.height !== H) {
        canvas.width = W;
        canvas.height = H;
      }
      gl.viewport(0, 0, W, H);
      try {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, tex[0]!);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, footage);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, tex[1]!);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, matte);
      } catch {
        // Cross-origin footage without CORS (presigned blob URLs) can't be read back.
        latest.current.onUnsupported("cross-origin");
        cancelAnimationFrame(raf);
        return;
      }
      const g = cropGeometry({ width: footage.videoWidth, height: footage.videoHeight }, { width: W, height: H }, clip.crop);
      gl.uniform2f(uSize, W, H);
      gl.uniform2f(uFocal, act.zoom.x * W, act.zoom.y * H);
      gl.uniform1f(uZoom, act.zoom.zoom);
      gl.uniform2f(uOffset, g.offsetX, g.offsetY);
      gl.uniform2f(uScaled, g.scaledWidth, g.scaledHeight);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      cleared = false;
      // Too slow for this device → the editor falls back to front-in-preview.
      const dt = performance.now() - t0;
      frames++;
      if (dt > 14) slowFrames++;
      if (frames >= 45 && slowFrames / frames > 0.5) {
        latest.current.onUnsupported("slow");
        cancelAnimationFrame(raf);
      }
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      // The canvas (and its WebGL context) survives a resize — free this run's GPU objects so a
      // long session (sheets opening, full screen) doesn't pile up programs and textures.
      tex.forEach((t) => gl.deleteTexture(t));
      gl.deleteBuffer(buf);
      for (const s of gl.getAttachedShaders(prog) ?? []) gl.deleteShader(s);
      gl.deleteProgram(prog);
      matte.pause();
      matte.removeAttribute("src");
      matte.load();
    };
  }, [engine, w, h]);

  return (
    <div className="ed-layer pointer-events-none z-[1]" style={{ filter: gradeOn ? "url(#ed-grade)" : undefined }} aria-hidden>
      <canvas ref={canvasRef} style={{ width: w, height: h, display: "block" }} data-testid="person-cutout" />
      <video ref={matteRef} muted playsInline preload="auto" crossOrigin="anonymous" disablePictureInPicture disableRemotePlayback style={{ position: "absolute", width: 2, height: 2, opacity: 0, left: 0, top: 0 }} />
    </div>
  );
}
