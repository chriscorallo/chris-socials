"use client";

import { useRef, useState } from "react";
import { upload } from "@vercel/blob/client";
import { SFX_SOUNDS, timelineDuration, type SfxSound, type TimelineSfx } from "@chris/media/timeline";
import { SFX_LABEL, addSfx, deleteSfx, setMusic, setSfxEnabled, updateMusic, updateSfx } from "../../../../lib/editor/visuals";
import { newId } from "../../../../lib/editor/timeline-ops";
import { formatTime } from "../../../../lib/editor/preview-math";
import { useEditor } from "./context";
import { listMusicAction } from "./actions";
import { registerBlobUpload } from "../actions";
import { NumField, Section, Slider, Toggle } from "./Inspector";
import { Icon } from "./icons";

/**
 * Sound design: the sound-effects switch, the free SFX kit (preview + add at the playhead), the
 * effects on the timeline, and the music bed (upload / pick / level / ducking / fades / start).
 * The touch shell's Sound sheet and the desktop inspector's Sound tab.
 */
export function SoundPanel() {
  const { doc, apply, state } = useEditor();
  const sel = state.selection;
  const selected = sel?.kind === "sfx" ? doc.sfx.find((s) => s.id === sel.id) : undefined;
  return (
    <>
      <Section title="Sound effects">
        <Toggle label="Sound effects on" checked={doc.audio.sfxEnabled} onChange={(on) => apply((d) => setSfxEnabled(d, on))} />
        <p className="text-[11.5px] leading-relaxed text-[var(--color-text-faint)]">
          {doc.audio.sfxEnabled
            ? "Graphics make their entrance sound, plus any effects you add. Tasteful and quiet — they're mixed under your voice."
            : "Off: no entrance sounds and no effects in the render."}
        </p>
      </Section>
      {selected && <SelectedSfx s={selected} />}
      <SfxLibrary />
      <PlacedSfx />
      <MusicSection />
    </>
  );
}

function SelectedSfx({ s }: { s: TimelineSfx }) {
  const { apply, audio, engine, doc } = useEditor();
  const D = timelineDuration(doc);
  return (
    <Section title="Selected effect">
      <div className="ed-chips">
        {SFX_SOUNDS.map((x) => (
          <button
            key={x}
            type="button"
            className="ed-chip-btn"
            aria-pressed={s.sound === x}
            onClick={() => {
              apply((d) => updateSfx(d, s.id, { sound: x }));
              void audio.audition(x, s.volume);
            }}
          >
            {SFX_LABEL[x]}
          </button>
        ))}
      </div>
      <Slider label="Volume" value={s.volume} min={0} max={1} format={(v) => `${Math.round(v * 100)}%`} resetTo={0.6} onChange={(volume) => apply((d) => updateSfx(d, s.id, { volume: Math.round(volume * 100) / 100 }), { coalesce: `sfxvol:${s.id}` })} />
      <div className="grid grid-cols-[1fr_auto] items-end gap-2">
        <NumField label="Plays at" value={s.at} min={0} max={D} onChange={(at) => apply((d) => updateSfx(d, s.id, { at }))} />
        <button type="button" className="ed-toolbtn !h-[38px]" onClick={() => apply((d) => updateSfx(d, s.id, { at: engine.time }))}>
          Move to playhead
        </button>
      </div>
      <button type="button" className="ed-toolbtn self-start !text-[var(--color-rose-400)]" onClick={() => apply((d) => deleteSfx(d, s.id), { select: null })}>
        <Icon name="trash" size={14} /> Remove effect
      </button>
    </Section>
  );
}

function SfxLibrary() {
  const { apply, audio, engine, toast } = useEditor();
  const [playing, setPlaying] = useState<SfxSound | null>(null);
  return (
    <Section title="Add an effect at the playhead">
      <ul className="ed-sfx-list">
        {SFX_SOUNDS.map((s) => (
          <li key={s}>
            <button
              type="button"
              className="ed-sfx-play"
              aria-label={`Preview ${SFX_LABEL[s]}`}
              aria-pressed={playing === s}
              onClick={() => {
                setPlaying(s);
                void audio.audition(s).finally(() => setTimeout(() => setPlaying((p) => (p === s ? null : p)), 600));
              }}
            >
              <Icon name="play" size={13} />
            </button>
            <span className="flex-1">{SFX_LABEL[s]}</span>
            <button
              type="button"
              className="ed-toolbtn"
              onClick={() => {
                const id = newId("sfx");
                const at = engine.time;
                apply((d) => addSfx(d, at, s, id).doc, { select: { kind: "sfx", id } });
                toast(`${SFX_LABEL[s]} added at ${at.toFixed(1)}s.`);
              }}
            >
              <Icon name="plus" size={13} /> Add
            </button>
          </li>
        ))}
      </ul>
      <p className="text-[11px] text-[var(--color-text-faint)]">Original sounds made for this app — no licensing to worry about.</p>
    </Section>
  );
}

function PlacedSfx() {
  const { doc, focus, state } = useEditor();
  if (!doc.sfx.length) return null;
  const sel = state.selection;
  return (
    <Section title={`On the timeline (${doc.sfx.length})`}>
      <ul className="flex flex-col gap-1">
        {doc.sfx.map((s) => (
          <li key={s.id}>
            <button type="button" className="ed-card ed-vis-row" aria-pressed={sel?.kind === "sfx" && sel.id === s.id} onClick={() => focus({ kind: "sfx", id: s.id })}>
              <Icon name="volume" size={14} />
              <span className="flex-1 text-left">{SFX_LABEL[s.sound]}</span>
              <span className="text-[11px] tabular-nums text-[var(--color-text-faint)]">{formatTime(s.at, true).slice(0, -1)}</span>
            </button>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function safeName(name: string): string {
  const base = name.replace(/^.*[\\/]/, "").replace(/[^\w.-]+/g, "_").replace(/^\.+/, "");
  return (base || "music").slice(-120);
}

function uploadLocal(contentItemId: string, file: File, onProgress: (pct: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const params = new URLSearchParams({ contentItemId, filename: file.name, kind: "MUSIC" });
    xhr.open("PUT", `/api/upload?${params}`);
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      let message = `Upload failed (${xhr.status})`;
      try {
        message = JSON.parse(xhr.responseText).error ?? message;
      } catch {
        // non-JSON error body
      }
      reject(new Error(message));
    };
    xhr.onerror = () => reject(new Error("Network error during upload"));
    xhr.send(file);
  });
}

function MusicSection() {
  const { doc, apply, music, setMusic: setMusicList, itemId, storageMode, toast, touch } = useEditor();
  const m = doc.audio.music;
  const inputRef = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const current = music.find((x) => x.id === m?.musicAssetId);
  const D = timelineDuration(doc);

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    if (file.type && !file.type.startsWith("audio/")) {
      setError("That's not an audio file — pick an MP3, M4A, WAV or AAC.");
      return;
    }
    setProgress(0);
    try {
      if (storageMode === "local") {
        await uploadLocal(itemId, file, setProgress);
      } else {
        const storageKey = `music/${itemId}/${Date.now()}-${safeName(file.name)}`;
        await upload(storageKey, file, {
          access: "private",
          handleUploadUrl: "/api/blob-upload",
          contentType: file.type || undefined,
          onUploadProgress: ({ percentage }) => setProgress(Math.round(percentage)),
        });
        const r = await registerBlobUpload({ contentItemId: itemId, storageKey, originalFilename: file.name, mimeType: file.type || "audio/mpeg", sizeBytes: file.size, kind: "MUSIC" });
        if ("error" in r) throw new Error(r.error);
      }
      const list = await listMusicAction(itemId);
      setMusicList(list);
      const newest = list[0];
      if (newest && !m) apply((d) => setMusic(d, newest.id));
      toast("Music added.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setProgress(null);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  return (
    <Section title="Music">
      <p className="ed-rights-note">
        <Icon name="music" size={13} /> Use music you have the rights to — platforms mute or take down videos with unlicensed tracks.
      </p>
      <div className="flex flex-col gap-1">
        <button type="button" className="ed-card ed-vis-row" aria-pressed={!m} onClick={() => apply((d) => setMusic(d, null))}>
          <Icon name="mute" size={14} />
          <span className="flex-1 text-left">No music</span>
        </button>
        {music.map((a) => (
          <button key={a.id} type="button" className="ed-card ed-vis-row" aria-pressed={m?.musicAssetId === a.id} onClick={() => apply((d) => setMusic(d, a.id))}>
            <Icon name="music" size={14} />
            <span className="min-w-0 flex-1 truncate text-left">{a.name}</span>
            <span className="text-[11px] tabular-nums text-[var(--color-text-faint)]">{formatTime(a.duration)}</span>
          </button>
        ))}
      </div>
      <label className={`btn btn-ghost !py-2 !text-[13px] ${progress !== null ? "pointer-events-none opacity-60" : "cursor-pointer"}`}>
        <input ref={inputRef} type="file" accept="audio/*" className="sr-only" onChange={(e) => void onFile(e.target.files?.[0])} disabled={progress !== null} />
        <Icon name="upload" size={14} /> {progress !== null ? `Uploading… ${progress}%` : "Upload a track"}
      </label>
      {error && (
        <p className="ed-ai-error" role="alert">
          <Icon name="warn" size={14} /> <span>{error}</span>
        </p>
      )}
      {m && (
        <>
          <Slider label="Music level (under your voice)" value={m.levelDb} min={-40} max={0} step={1} format={(v) => `${Math.round(v)} dB`} resetTo={-18} onChange={(levelDb) => apply((d) => updateMusic(d, { levelDb: Math.round(levelDb) }), { coalesce: "music:level" })} />
          <Slider label="Duck while you talk" value={m.duckDb} min={0} max={30} step={1} format={(v) => (v === 0 ? "Off" : `−${Math.round(v)} dB`)} resetTo={10} onChange={(duckDb) => apply((d) => updateMusic(d, { duckDb: Math.round(duckDb) }), { coalesce: "music:duck" })} />
          <Slider label="Fade in" value={m.fadeInSeconds} min={0} max={5} step={0.1} format={(v) => `${v.toFixed(1)}s`} resetTo={0.6} onChange={(fadeInSeconds) => apply((d) => updateMusic(d, { fadeInSeconds: Math.round(fadeInSeconds * 10) / 10 }), { coalesce: "music:fi" })} />
          <Slider label="Fade out" value={m.fadeOutSeconds} min={0} max={8} step={0.1} format={(v) => `${v.toFixed(1)}s`} resetTo={1.5} onChange={(fadeOutSeconds) => apply((d) => updateMusic(d, { fadeOutSeconds: Math.round(fadeOutSeconds * 10) / 10 }), { coalesce: "music:fo" })} />
          <NumField
            label="Start the track at"
            value={m.trackStart}
            min={0}
            max={Math.max(0, (current?.duration ?? 0) - 1)}
            onChange={(trackStart) => apply((d) => updateMusic(d, { trackStart: Math.round(trackStart * 10) / 10 }))}
          />
          {current && current.duration > 0 && current.duration - m.trackStart < D && (
            <p className="text-[11px] text-[var(--color-text-faint)]">The track ends {(D - (current.duration - m.trackStart)).toFixed(1)}s before the video does.</p>
          )}
          <p className="text-[11px] leading-relaxed text-[var(--color-text-faint)]">
            The preview approximates the mix{touch && storageMode === "blob" ? " (on iPhone it plays the music at full level)" : ""}; the render levels the track to your voice and ducks it word by word.
          </p>
        </>
      )}
    </Section>
  );
}
