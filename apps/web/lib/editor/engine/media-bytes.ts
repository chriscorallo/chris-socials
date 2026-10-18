import { parseMp4, type Mp4Info } from "./mp4";

/**
 * Progressive download of one preview file (proxy or baked graphic) into memory, with the MP4
 * index parsed as soon as the `moov` box has arrived (proxies are +faststart, so that's the
 * first ~60 KB). The engine asks `has(offset, size)` before decoding a sample — playback can
 * start after the first second or two of bytes, like a streaming player.
 *
 * Re-opens are instant: finished files are kept in the Cache API (the newest CACHE_KEEP files).
 *
 * Production storage is a private Vercel Blob store: /api/media redirects to a presigned URL on
 * another origin. If that origin refuses a CORS read, the file is fetched through the app
 * instead (`?stream=1` — /api/media streams it same-origin). Which path ran is reported in
 * telemetry (`mediaPath`).
 */

export const MEDIA_CACHE = "chris-ed-media-v1";
export const CACHE_KEEP = 8;

type Listener = () => void;

export class MediaBytes {
  readonly url: string;
  bytes: Uint8Array = new Uint8Array(0);
  loaded = 0;
  total = 0;
  done = false;
  error: string | null = null;
  info: Mp4Info | null = null;
  /** "cache" | "direct" | "stream" */
  path: string | null = null;
  startedAt = performance.now();
  firstByteMs: number | null = null;
  doneMs: number | null = null;
  private listeners = new Set<Listener>();
  private abortCtl = new AbortController();

  constructor(url: string) {
    this.url = url;
    void this.load();
  }

  onChange(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    for (const l of this.listeners) {
      try {
        l();
      } catch {
        /* a listener failing must not stop the download */
      }
    }
  }

  has(offset: number, size: number): boolean {
    return offset + size <= this.loaded;
  }

  slice(offset: number, size: number): Uint8Array {
    return this.bytes.subarray(offset, offset + size);
  }

  abort() {
    this.abortCtl.abort();
  }

  private grow(need: number) {
    if (need <= this.bytes.length) return;
    const next = new Uint8Array(Math.max(need, Math.floor(this.bytes.length * 1.5), 1 << 20));
    next.set(this.bytes.subarray(0, this.loaded));
    this.bytes = next;
  }

  private tryIndex() {
    if (!this.info && this.loaded >= 16) {
      try {
        this.info = parseMp4(this.bytes.subarray(0, this.loaded));
      } catch {
        this.info = null;
      }
    }
  }

  private async load() {
    // 1) Cache API (instant re-open)
    try {
      if (typeof caches !== "undefined") {
        const cache = await caches.open(MEDIA_CACHE);
        const hit = await cache.match(this.url);
        if (hit) {
          const buf = new Uint8Array(await hit.arrayBuffer());
          this.bytes = buf;
          this.loaded = this.total = buf.length;
          this.done = true;
          this.path = "cache";
          this.firstByteMs = this.doneMs = Math.round(performance.now() - this.startedAt);
          this.tryIndex();
          this.emit();
          return;
        }
      }
    } catch {
      /* private mode / quota — fall through to the network */
    }
    // 2) network: direct (follows the redirect), then same-origin stream
    const get = async (url: string): Promise<Response | string> => {
      try {
        const r = await fetch(url, { credentials: "same-origin", signal: this.abortCtl.signal });
        return r.ok ? r : `HTTP ${r.status}`;
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    };
    let res = await get(this.url);
    this.path = "direct";
    if (typeof res === "string") {
      if (this.abortCtl.signal.aborted) return;
      const first = res;
      res = await get(this.url + (this.url.includes("?") ? "&" : "?") + "stream=1");
      this.path = "stream";
      if (typeof res === "string") {
        this.error = `${first} / ${res}`;
        this.emit();
        return;
      }
    }
    this.total = Number(res.headers.get("content-length")) || 0;
    if (this.total) this.grow(this.total);
    try {
      const reader = res.body!.getReader();
      let lastEmit = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (this.firstByteMs === null) this.firstByteMs = Math.round(performance.now() - this.startedAt);
        this.grow(this.loaded + value.length);
        this.bytes.set(value, this.loaded);
        this.loaded += value.length;
        this.tryIndex();
        const now = performance.now();
        if (now - lastEmit > 50) {
          lastEmit = now;
          this.emit();
        }
      }
    } catch (err) {
      if (this.abortCtl.signal.aborted) return;
      this.error = err instanceof Error ? err.message : String(err);
      this.emit();
      return;
    }
    if (this.bytes.length !== this.loaded) this.bytes = this.bytes.slice(0, this.loaded);
    this.total = this.loaded;
    this.done = true;
    this.doneMs = Math.round(performance.now() - this.startedAt);
    this.tryIndex();
    this.emit();
    void this.store();
  }

  private async store() {
    try {
      if (typeof caches === "undefined") return;
      const cache = await caches.open(MEDIA_CACHE);
      await cache.put(this.url, new Response(this.bytes.slice(0), { headers: { "Content-Type": "video/mp4", "X-Stored": String(Date.now()) } }));
      const keys = await cache.keys();
      if (keys.length > CACHE_KEEP) {
        // oldest first (insertion order)
        for (const k of keys.slice(0, keys.length - CACHE_KEEP)) await cache.delete(k);
      }
    } catch {
      /* quota exceeded etc. — the next open just downloads again */
    }
  }
}

/** One MediaBytes per URL for the editor session (proxies are shared by every clip of a take). */
const pool = new Map<string, MediaBytes>();

export function mediaBytes(url: string): MediaBytes {
  let m = pool.get(url);
  if (!m || m.error) {
    m = new MediaBytes(url);
    pool.set(url, m);
  }
  return m;
}

export function releaseMediaBytes(url: string) {
  const m = pool.get(url);
  if (m) {
    m.abort();
    pool.delete(url);
  }
}
