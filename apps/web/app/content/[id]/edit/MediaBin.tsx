"use client";

import { useRef } from "react";
import { insertClip, insertionIndexAt, newId } from "../../../../lib/editor/timeline-ops";
import { formatTime } from "../../../../lib/editor/preview-math";
import type { EditorAsset } from "../../../../lib/editor/types";
import { useEditor } from "./context";
import { Icon } from "./icons";

export const TAKE_DRAG_MIME = "application/x-chris-take";

/** Left panel: every raw take for this video. Hover to scrub, click "Add" or drag onto the timeline. */
export function MediaBin() {
  const { assets, doc } = useEditor();
  const used = new Set(doc.clips.map((c) => c.mediaAssetId));
  return (
    <aside className="ed-side ed-side-left" aria-label="Media">
      <div className="ed-side-head">
        <div>
          <p className="ed-eyebrow">Media</p>
          <p className="text-[12px] text-[var(--color-text-faint)]">
            {assets.length} take{assets.length === 1 ? "" : "s"}
          </p>
        </div>
      </div>
      <div className="ed-scroll flex flex-col gap-3 p-3">
        {assets.length === 0 && <p className="p-2 text-[12px] text-[var(--color-text-faint)]">No raw takes uploaded for this video.</p>}
        {assets.map((a, i) => (
          <TakeCard key={a.id} asset={a} index={i} inUse={used.has(a.id)} />
        ))}
        <p className="px-1 pt-1 text-[11px] leading-relaxed text-[var(--color-text-faint)]">
          Hover a take to scrub it. Drag it onto the timeline, or press Add to drop it in at the playhead.
        </p>
      </div>
    </aside>
  );
}

function TakeCard({ asset, index, inUse }: { asset: EditorAsset; index: number; inUse: boolean }) {
  const { apply, engine, toast, doc } = useEditor();
  const videoRef = useRef<HTMLVideoElement>(null);
  const snippet = asset.transcript?.trim() || (asset.words?.length ? asset.words.map((w) => w.word).join(" ") : "");

  const add = () => {
    const id = newId("clip");
    const index = insertionIndexAt(doc, engine.time);
    apply((d) => insertClip(d, index, { mediaAssetId: asset.id, sourceStart: 0, sourceEnd: asset.duration || 5 }, id).doc, {
      select: { kind: "clip", id },
    });
    toast(`Added “${asset.name}” — trim it on the timeline`);
  };

  return (
    <div
      className="ed-take"
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(TAKE_DRAG_MIME, asset.id);
        e.dataTransfer.effectAllowed = "copy";
      }}
      style={{ ["--take" as string]: asset.color }}
    >
      <div
        className="ed-take-thumb"
        onPointerMove={(e) => {
          const v = videoRef.current;
          if (!v || !asset.duration) return;
          const r = e.currentTarget.getBoundingClientRect();
          v.currentTime = Math.max(0, Math.min(asset.duration - 0.05, ((e.clientX - r.left) / r.width) * asset.duration));
        }}
        onPointerLeave={() => {
          const v = videoRef.current;
          if (v) v.currentTime = Math.min(0.5, asset.duration / 2);
        }}
      >
        <video ref={videoRef} src={`${asset.url}#t=${Math.min(0.5, asset.duration / 2 || 0)}`} preload="metadata" muted playsInline />
        <span className="absolute left-2 top-2 h-2 w-2 rounded-full" style={{ background: asset.color, boxShadow: `0 0 0 2px rgba(0,0,0,.5)` }} />
        <span className="absolute bottom-2 left-2 rounded-md bg-black/60 px-1.5 py-0.5 text-[10.5px] tabular-nums text-white/90">
          {formatTime(asset.duration, true)}
        </span>
        <button type="button" className="ed-take-add" onClick={add} aria-label={`Add ${asset.name} to the timeline`}>
          <Icon name="plus" size={13} /> Add
        </button>
      </div>
      <div className="px-2.5 pb-2.5 pt-2">
        <div className="flex items-center justify-between gap-2">
          <p className="truncate text-[12.5px] font-medium">{asset.name || `Take ${index + 1}`}</p>
          {inUse && <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-faint)]">In edit</span>}
        </div>
        {snippet && <p className="mt-1 line-clamp-2 text-[11.5px] leading-snug text-[var(--color-text-faint)]">“{snippet}”</p>}
        {asset.width && asset.height && (
          <p className="mt-1 text-[10.5px] text-[var(--color-text-faint)]">
            {asset.width}×{asset.height}
          </p>
        )}
      </div>
    </div>
  );
}
