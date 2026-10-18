/**
 * Minimal MP4 demuxer for the editor's preview proxies and baked graphics — PURE (bytes in,
 * sample tables out), so it is unit-tested against real ffmpeg output.
 *
 * Scope: exactly what our own ffmpeg writes (H.264 `avc1` + AAC `mp4a`, `moov` before `mdat`
 * with +faststart — the parser also copes with moov at the end when given the whole file).
 * Supports stts/ctts (B-frames)/stss/stsz/stsc/stco/co64 and the edit list's media_time shift
 * (ffmpeg uses it for B-frame delay and AAC priming).
 */

export interface Mp4Track {
  id: number;
  kind: "video" | "audio" | "other";
  timescale: number;
  /** ticks the edit list skips at the start (B-frame delay / AAC priming) */
  editShift: number;
  codec: string;
  /** avcC payload (video) or AudioSpecificConfig (audio) */
  description: Uint8Array | null;
  width: number;
  height: number;
  sampleRate: number;
  channels: number;
  count: number;
  offsets: Float64Array;
  sizes: Uint32Array;
  dts: Float64Array;
  cts: Float64Array;
  /** 1 = sync (key) sample */
  keys: Uint8Array;
}

export interface Mp4Info {
  /** byte offset where the moov box ends (everything needed to plan decoding is below it) */
  moovEnd: number;
  tracks: Mp4Track[];
}

class Reader {
  constructor(
    readonly b: Uint8Array,
    readonly v = new DataView(b.buffer, b.byteOffset, b.byteLength),
  ) {}
  u8(o: number) {
    return this.b[o]!;
  }
  u16(o: number) {
    return this.v.getUint16(o);
  }
  u32(o: number) {
    return this.v.getUint32(o);
  }
  i32(o: number) {
    return this.v.getInt32(o);
  }
  u64(o: number) {
    return this.v.getUint32(o) * 4294967296 + this.v.getUint32(o + 4);
  }
  type(o: number) {
    return String.fromCharCode(this.b[o]!, this.b[o + 1]!, this.b[o + 2]!, this.b[o + 3]!);
  }
}

interface Box {
  type: string;
  start: number;
  /** payload start */
  data: number;
  end: number;
}

function boxes(r: Reader, start: number, end: number): Box[] {
  const out: Box[] = [];
  let o = start;
  while (o + 8 <= end) {
    let size = r.u32(o);
    const type = r.type(o + 4);
    let data = o + 8;
    if (size === 1) {
      if (o + 16 > end) break;
      size = r.u64(o + 8);
      data = o + 16;
    } else if (size === 0) {
      size = end - o;
    }
    if (size < 8) break;
    out.push({ type, start: o, data, end: Math.min(end, o + size) });
    o += size;
  }
  return out;
}

const child = (r: Reader, b: Box, type: string) => boxes(r, b.data, b.end).find((x) => x.type === type);

/**
 * Finds the top-level moov box in `bytes` (which may be a prefix of the file). Returns null
 * until the whole moov is present.
 */
export function findMoov(bytes: Uint8Array): { start: number; end: number } | null {
  const r = new Reader(bytes);
  let o = 0;
  while (o + 8 <= bytes.length) {
    let size = r.u32(o);
    const type = r.type(o + 4);
    if (size === 1) {
      if (o + 16 > bytes.length) return null;
      size = r.u64(o + 8);
    } else if (size === 0) {
      size = bytes.length - o;
    }
    if (size < 8) return null;
    if (type === "moov") return o + size <= bytes.length ? { start: o, end: o + size } : null;
    o += size;
  }
  return null;
}

function hex2(n: number) {
  return n.toString(16).padStart(2, "0");
}

function readDescriptorLen(r: Reader, o: number): { len: number; next: number } {
  let len = 0;
  let i = 0;
  for (; i < 4; i++) {
    const c = r.u8(o + i);
    len = (len << 7) | (c & 0x7f);
    if (!(c & 0x80)) break;
  }
  return { len, next: o + i + 1 };
}

/** AudioSpecificConfig from an esds box payload. */
function parseEsds(r: Reader, b: Box): Uint8Array | null {
  let o = b.data + 4; // fullbox
  if (r.u8(o) !== 0x03) return null;
  let d = readDescriptorLen(r, o + 1);
  o = d.next;
  o += 2; // ES_ID
  const flags = r.u8(o++);
  if (flags & 0x80) o += 2;
  if (flags & 0x40) o += 1 + r.u8(o);
  if (flags & 0x20) o += 2;
  if (r.u8(o) !== 0x04) return null;
  d = readDescriptorLen(r, o + 1);
  o = d.next + 13;
  if (r.u8(o) !== 0x05) return null;
  d = readDescriptorLen(r, o + 1);
  return r.b.slice(d.next, d.next + d.len);
}

function parseTrak(r: Reader, trak: Box): Mp4Track | null {
  const tkhd = child(r, trak, "tkhd");
  const mdia = child(r, trak, "mdia");
  if (!tkhd || !mdia) return null;
  const id = r.u8(tkhd.data) === 1 ? r.u32(tkhd.data + 4 + 16) : r.u32(tkhd.data + 4 + 8);
  const mdhd = child(r, mdia, "mdhd");
  const hdlr = child(r, mdia, "hdlr");
  const minf = child(r, mdia, "minf");
  const stbl = minf && child(r, minf, "stbl");
  if (!mdhd || !hdlr || !stbl) return null;
  const timescale = r.u8(mdhd.data) === 1 ? r.u32(mdhd.data + 4 + 16) : r.u32(mdhd.data + 4 + 8);
  const handler = r.type(hdlr.data + 8);
  const kind = handler === "vide" ? "video" : handler === "soun" ? "audio" : "other";

  // edit list: first non-empty entry's media_time
  let editShift = 0;
  const edts = child(r, trak, "edts");
  const elst = edts && child(r, edts, "elst");
  if (elst) {
    const v = r.u8(elst.data);
    const n = r.u32(elst.data + 4);
    let o = elst.data + 8;
    for (let i = 0; i < n; i++) {
      const mediaTime = v === 1 ? r.u64(o + 8) : r.i32(o + 4);
      o += v === 1 ? 20 : 12;
      if (mediaTime >= 0 && mediaTime < 2 ** 52) {
        editShift = mediaTime;
        break;
      }
    }
  }

  // sample description
  const stsd = child(r, stbl, "stsd");
  let codec = "";
  let description: Uint8Array | null = null;
  let width = 0;
  let height = 0;
  let sampleRate = 0;
  let channels = 0;
  if (stsd) {
    const entry = boxes(r, stsd.data + 8, stsd.end)[0];
    if (entry) {
      if (kind === "video") {
        width = r.u16(entry.data + 24);
        height = r.u16(entry.data + 26);
        const kids = boxes(r, entry.data + 78, entry.end);
        const avcC = kids.find((k) => k.type === "avcC");
        if (avcC) {
          description = r.b.slice(avcC.data, avcC.end);
          codec = `avc1.${hex2(r.u8(avcC.data + 1))}${hex2(r.u8(avcC.data + 2))}${hex2(r.u8(avcC.data + 3))}`;
        } else {
          codec = entry.type;
        }
      } else if (kind === "audio") {
        channels = r.u16(entry.data + 16);
        sampleRate = r.u32(entry.data + 24) >>> 16;
        const kids = boxes(r, entry.data + 28, entry.end);
        const esds = kids.find((k) => k.type === "esds");
        description = esds ? parseEsds(r, esds) : null;
        let ot = 2;
        if (description && description.length) ot = description[0]! >> 3;
        codec = entry.type === "mp4a" ? `mp4a.40.${ot}` : entry.type;
      }
    }
  }

  // sizes
  const stsz = child(r, stbl, "stsz");
  if (!stsz) return null;
  const fixed = r.u32(stsz.data + 4);
  const count = r.u32(stsz.data + 8);
  const sizes = new Uint32Array(count);
  for (let i = 0; i < count; i++) sizes[i] = fixed || r.u32(stsz.data + 12 + i * 4);

  // chunk offsets
  const stco = child(r, stbl, "stco");
  const co64 = child(r, stbl, "co64");
  const chunkOffsets: number[] = [];
  if (stco) {
    const n = r.u32(stco.data + 4);
    for (let i = 0; i < n; i++) chunkOffsets.push(r.u32(stco.data + 8 + i * 4));
  } else if (co64) {
    const n = r.u32(co64.data + 4);
    for (let i = 0; i < n; i++) chunkOffsets.push(r.u64(co64.data + 8 + i * 8));
  }
  const stsc = child(r, stbl, "stsc");
  const runs: Array<{ first: number; per: number }> = [];
  if (stsc) {
    const n = r.u32(stsc.data + 4);
    for (let i = 0; i < n; i++) runs.push({ first: r.u32(stsc.data + 8 + i * 12), per: r.u32(stsc.data + 12 + i * 12) });
  }
  const offsets = new Float64Array(count);
  let s = 0;
  for (let c = 0; c < chunkOffsets.length && s < count; c++) {
    let per = 1;
    for (const run of runs) if (run.first <= c + 1) per = run.per;
    let o = chunkOffsets[c]!;
    for (let k = 0; k < per && s < count; k++) {
      offsets[s] = o;
      o += sizes[s]!;
      s++;
    }
  }

  // timing
  const dts = new Float64Array(count);
  const cts = new Float64Array(count);
  const stts = child(r, stbl, "stts");
  if (stts) {
    const n = r.u32(stts.data + 4);
    let i = 0;
    let t = 0;
    for (let e = 0; e < n; e++) {
      const c = r.u32(stts.data + 8 + e * 8);
      const d = r.u32(stts.data + 12 + e * 8);
      for (let k = 0; k < c && i < count; k++) {
        dts[i++] = t;
        t += d;
      }
    }
  }
  cts.set(dts);
  const ctts = child(r, stbl, "ctts");
  if (ctts) {
    const v = r.u8(ctts.data);
    const n = r.u32(ctts.data + 4);
    let i = 0;
    for (let e = 0; e < n; e++) {
      const c = r.u32(ctts.data + 8 + e * 8);
      const off = v === 1 ? r.i32(ctts.data + 12 + e * 8) : r.u32(ctts.data + 12 + e * 8);
      for (let k = 0; k < c && i < count; k++, i++) cts[i] = dts[i]! + off;
    }
  }
  const keys = new Uint8Array(count);
  const stss = child(r, stbl, "stss");
  if (stss) {
    const n = r.u32(stss.data + 4);
    for (let e = 0; e < n; e++) {
      const k = r.u32(stss.data + 8 + e * 4) - 1;
      if (k >= 0 && k < count) keys[k] = 1;
    }
  } else keys.fill(1);

  return { id, kind, timescale, editShift, codec, description, width, height, sampleRate, channels, count, offsets, sizes, dts, cts, keys };
}

/** Parses the moov box (bytes must contain it whole — see findMoov). */
export function parseMp4(bytes: Uint8Array): Mp4Info | null {
  const m = findMoov(bytes);
  if (!m) return null;
  const r = new Reader(bytes);
  const moov: Box = { type: "moov", start: m.start, data: m.start + 8, end: m.end };
  const tracks = boxes(r, moov.data, moov.end)
    .filter((b) => b.type === "trak")
    .map((t) => parseTrak(r, t))
    .filter((t): t is Mp4Track => !!t);
  return { moovEnd: m.end, tracks };
}

// ---------------------------------------------------------------------------------------
// Timing helpers on a parsed video track
// ---------------------------------------------------------------------------------------

/** Presentation time (s) of sample i. */
export function samplePts(t: Mp4Track, i: number): number {
  return (t.cts[i]! - t.editShift) / t.timescale;
}

export interface FrameIndex {
  /** sample indices in presentation order */
  order: Int32Array;
  /** presentation times (s), ascending, aligned with `order` */
  pts: Float64Array;
  /** decode index → nearest key sample at or before it (decode order) */
  keyBefore: Int32Array;
  /** typical frame duration (s) */
  frameDur: number;
}

export function buildFrameIndex(t: Mp4Track): FrameIndex {
  const n = t.count;
  const idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => t.cts[a]! - t.cts[b]!);
  const order = Int32Array.from(idx);
  const pts = Float64Array.from(idx.map((i) => samplePts(t, i)));
  const keyBefore = new Int32Array(n);
  let k = 0;
  for (let i = 0; i < n; i++) {
    if (t.keys[i]) k = i;
    keyBefore[i] = k;
  }
  const frameDur = n > 1 ? (pts[n - 1]! - pts[0]!) / (n - 1) : 1 / 30;
  return { order, pts, keyBefore, frameDur };
}

/** Presentation-order position of the frame showing at time s (last pts ≤ s), clamped. */
export function frameAt(fi: FrameIndex, s: number): number {
  const p = fi.pts;
  let lo = 0;
  let hi = p.length - 1;
  if (hi < 0) return -1;
  if (s <= p[0]!) return 0;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (p[mid]! <= s + 1e-6) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Decode-order sample range that must be fed to output the frames shown over source span
 * [a, b): from the key sample at or before the first frame through the last decode index any
 * of those frames needs (with B-frames a frame may decode after later-presented ones).
 */
export function decodeRange(t: Mp4Track, fi: FrameIndex, a: number, b: number): { from: number; to: number } {
  const p0 = frameAt(fi, a);
  const p1 = Math.max(p0, frameAt(fi, Math.max(a, b - 1e-6)));
  let maxDecode = 0;
  let minDecode = Infinity;
  for (let p = p0; p <= p1; p++) {
    const d = fi.order[p]!;
    if (d > maxDecode) maxDecode = d;
    if (d < minDecode) minDecode = d;
  }
  return { from: fi.keyBefore[minDecode === Infinity ? 0 : minDecode]!, to: Math.min(t.count - 1, maxDecode) };
}
