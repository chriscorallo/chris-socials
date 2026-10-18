"use client";

import { useEffect, useMemo, useState } from "react";
import { timelineCaptionWords, timelineDuration, type SfxSound, type TranscriptWord } from "@chris/media/timeline";
import { musicGainAt, musicTrackTime, speechRegions } from "../../../../lib/editor/music-mix";
import { sfxUrl } from "../../../../lib/editor/visuals";
import type { EditorDoc, EditorMusicAsset } from "../../../../lib/editor/types";
import type { PlaybackEngine } from "./playback";

/**
 * The preview's sound design: the music bed under the video's own audio (with a ducking
 * approximation — lib/editor/music-mix.ts) and the sound effects (visual entrances + free
 * SFX), slaved to the playback engine's clock. Deliberately small and iOS-safe:
 * - everything starts from the engine's play tap (`onPlayGesture`), the only moment iOS lets a
 *   page make sound; the AudioContext is created/resumed there too;
 * - music is ONE <audio> element; its gain goes through WebAudio when the file is same-origin
 *   (local storage) because iOS ignores `HTMLMediaElement.volume`. In blob mode the file is a
 *   cross-origin presigned URL, so the element's own volume is used (desktop honours it; on an
 *   iPhone the bed then plays at full level — the render mix is unaffected);
 * - SFX are tiny WAVs decoded once into AudioBuffers and fired when the playhead crosses them.
 * The render is the source of truth for the mix; this is for judging fit and timing.
 */

interface Hit {
  at: number;
  sound: SfxSound;
  gain: number;
}

export interface PreviewAudioConfig {
  music: EditorDoc["audio"]["music"];
  musicAsset: EditorMusicAsset | null;
  regions: Array<{ start: number; end: number }>;
  duration: number;
  hits: Hit[];
  sameOriginMusic: boolean;
}

/** Same constants as the renderer's mix (packages/media buildAudioMix). */
const SFX_HOUSE_GAIN = 0.5;
const VISUAL_SFX_VOLUME = 0.6;

type AudioCtx = AudioContext;

export class PreviewAudio {
  private cfg: PreviewAudioConfig | null = null;
  private ctx: AudioCtx | null = null;
  private el: HTMLAudioElement | null = null;
  private elUrl: string | null = null;
  private gain: GainNode | null = null;
  private routed = false;
  private buffers = new Map<SfxSound, AudioBuffer | "loading" | "failed">();
  private lastT = -1;
  private unsub: Array<() => void> = [];

  constructor(private engine: PlaybackEngine) {}

  /** Hooks into the engine; returns the detach (StrictMode-safe: attach/detach/attach). */
  attach(): () => void {
    this.unsub.push(this.engine.onPlayGesture(() => this.onPlay()));
    this.unsub.push(this.engine.subscribe(() => this.onTick()));
    return () => this.dispose();
  }

  setConfig(cfg: PreviewAudioConfig) {
    this.cfg = cfg;
    if (this.el && cfg.musicAsset?.url !== this.elUrl) this.dropMusic();
    if (this.engine.playing && cfg.music && cfg.musicAsset && !this.el) this.startMusic();
    this.onTick();
  }

  dispose() {
    for (const u of this.unsub) u();
    this.unsub = [];
    this.dropMusic();
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
  }

  private ensureCtx(): AudioCtx | null {
    if (this.ctx) return this.ctx;
    const Ctor = (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext) as typeof AudioContext | undefined;
    if (!Ctor) return null;
    try {
      this.ctx = new Ctor();
    } catch {
      this.ctx = null;
    }
    return this.ctx;
  }

  /** Inside the play tap: unlock audio, start the bed, warm the SFX buffers. */
  private onPlay() {
    const ctx = this.ensureCtx();
    if (ctx && ctx.state === "suspended") void ctx.resume().catch(() => undefined);
    this.lastT = this.engine.time;
    if (this.cfg?.music && this.cfg.musicAsset) this.startMusic();
    this.warmSfx();
  }

  private startMusic() {
    const cfg = this.cfg;
    if (!cfg?.music || !cfg.musicAsset) return;
    if (!this.el) {
      const el = new Audio();
      el.preload = "auto";
      if (cfg.sameOriginMusic) el.crossOrigin = "anonymous";
      el.src = cfg.musicAsset.url;
      this.el = el;
      this.elUrl = cfg.musicAsset.url;
      this.routed = false;
      const ctx = this.ctx;
      if (ctx && cfg.sameOriginMusic) {
        try {
          const src = ctx.createMediaElementSource(el);
          const g = ctx.createGain();
          src.connect(g).connect(ctx.destination);
          this.gain = g;
          this.routed = true;
        } catch {
          this.routed = false;
        }
      }
    }
    const tt = musicTrackTime(cfg.music, this.engine.time, cfg.musicAsset.duration);
    if (tt === null) return;
    this.applyGain();
    try {
      this.el.currentTime = tt;
    } catch {
      /* not seekable yet — the tick re-syncs */
    }
    void this.el.play().catch(() => undefined);
  }

  private dropMusic() {
    if (!this.el) return;
    this.el.pause();
    this.el.removeAttribute("src");
    this.el.load();
    try {
      this.gain?.disconnect();
    } catch {
      /* already gone */
    }
    this.el = null;
    this.elUrl = null;
    this.gain = null;
    this.routed = false;
  }

  private applyGain() {
    const cfg = this.cfg;
    if (!cfg?.music || !this.el) return;
    const g = musicGainAt(cfg.music, cfg.regions, this.engine.time, cfg.duration);
    if (this.routed && this.gain && this.ctx) {
      this.gain.gain.setTargetAtTime(g, this.ctx.currentTime, 0.03);
      this.el.volume = 1;
    } else {
      this.el.volume = g;
    }
  }

  private onTick() {
    const cfg = this.cfg;
    const t = this.engine.time;
    const playing = this.engine.playing;
    // ---- music
    if (this.el && this.el.muted !== this.engine.muted) this.el.muted = this.engine.muted;
    if (this.el) {
      if (!playing || !cfg?.music || !cfg.musicAsset) {
        if (!this.el.paused) this.el.pause();
      } else {
        const tt = musicTrackTime(cfg.music, t, cfg.musicAsset.duration);
        if (tt === null) {
          if (!this.el.paused) this.el.pause();
        } else {
          if (Math.abs(this.el.currentTime - tt) > 0.3 && this.el.readyState >= 1) this.el.currentTime = tt;
          if (this.el.paused) void this.el.play().catch(() => undefined);
          this.applyGain();
        }
      }
    }
    // ---- sound effects: fire the ones the playhead just crossed (not on seeks/jumps)
    if (playing && cfg && this.ctx && !this.engine.muted && this.lastT >= 0 && t >= this.lastT && t - this.lastT < 0.5) {
      for (const h of cfg.hits) if (h.at > this.lastT && h.at <= t) this.fire(h);
    }
    this.lastT = playing ? t : -1;
  }

  private warmSfx() {
    const cfg = this.cfg;
    if (!cfg || !this.ctx) return;
    for (const s of new Set(cfg.hits.map((h) => h.sound))) void this.load(s);
  }

  /** Decodes one SFX file (also used by the sound picker's preview button). */
  async load(sound: SfxSound): Promise<AudioBuffer | null> {
    const have = this.buffers.get(sound);
    if (have && have !== "loading" && have !== "failed") return have;
    if (have === "loading" || have === "failed") return null;
    const ctx = this.ensureCtx();
    if (!ctx) return null;
    this.buffers.set(sound, "loading");
    try {
      const res = await fetch(sfxUrl(sound));
      if (!res.ok) throw new Error(String(res.status));
      const buf = await ctx.decodeAudioData(await res.arrayBuffer());
      this.buffers.set(sound, buf);
      return buf;
    } catch {
      this.buffers.set(sound, "failed");
      return null;
    }
  }

  private fire(h: Hit) {
    const ctx = this.ctx;
    const buf = this.buffers.get(h.sound);
    if (!ctx || !buf || buf === "loading" || buf === "failed") return;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    g.gain.value = h.gain;
    src.connect(g).connect(ctx.destination);
    src.start();
  }

  /** Sound picker: play one effect now (call from a tap). */
  async audition(sound: SfxSound, volume = VISUAL_SFX_VOLUME) {
    const ctx = this.ensureCtx();
    if (!ctx) return;
    if (ctx.state === "suspended") await ctx.resume().catch(() => undefined);
    const buf = await this.load(sound);
    if (buf) this.fire({ at: 0, sound, gain: volume * SFX_HOUSE_GAIN * 2 });
  }
}

/** Builds the config from the doc and keeps the PreviewAudio in sync. */
export function usePreviewAudio(
  engine: PlaybackEngine,
  doc: EditorDoc,
  wordsByAsset: Record<string, TranscriptWord[] | null>,
  music: EditorMusicAsset[],
  sameOriginMusic: boolean,
): PreviewAudio {
  const [audio] = useState(() => new PreviewAudio(engine));
  useEffect(() => audio.attach(), [audio]);

  // Speech regions from what's actually heard (word timings through the cuts; hidden-word
  // caption edits don't change the audio, so they're ignored here).
  const { clips, captions } = doc;
  const words = useMemo(() => timelineCaptionWords({ clips, captions: { ...captions, wordEdits: {} } }, wordsByAsset), [clips, captions, wordsByAsset]);
  const regions = useMemo(() => speechRegions(words), [words]);
  const hits = useMemo<Hit[]>(() => {
    if (!doc.audio.sfxEnabled) return [];
    const out: Hit[] = doc.sfx.map((s) => ({ at: s.at, sound: s.sound, gain: s.volume * SFX_HOUSE_GAIN }));
    for (const v of doc.visuals) if (v.enterSfx) out.push({ at: v.start, sound: v.enterSfx, gain: VISUAL_SFX_VOLUME * SFX_HOUSE_GAIN });
    return out.sort((a, b) => a.at - b.at);
  }, [doc.sfx, doc.visuals, doc.audio.sfxEnabled]);
  const musicAsset = useMemo(() => music.find((m) => m.id === doc.audio.music?.musicAssetId) ?? null, [music, doc.audio.music]);
  const duration = timelineDuration(doc);

  useEffect(() => {
    audio.setConfig({ music: doc.audio.music, musicAsset, regions, duration, hits, sameOriginMusic });
  }, [audio, doc.audio.music, musicAsset, regions, duration, hits, sameOriginMusic]);
  return audio;
}
