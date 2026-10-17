"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  CAPTION_PRESETS,
  FONT_REGISTRY,
  GRADE_PRESETS,
  GRADE_PRESET_VALUES,
  clipDuration,
  clipStartTimes,
  locateOutputTime,
  timelineCaptionWords,
  timelineDuration,
  type TimelineCaptions,
  type TimelineClip,
  type TimelineText,
  type TimelineZoom,
} from "@chris/media/timeline";
import {
  updateClip,
  updateText,
  updateZoom,
  updateCaptions,
  setWordEdit,
  applyGradePreset,
  updateGrade,
  setCover,
  switchClipSource,
  trimClip,
  deleteText,
  deleteZoom,
} from "../../../../lib/editor/timeline-ops";
import { gradeCss, hexToRgba, joinHexAlpha, splitHexAlpha, formatTime, strokePx } from "../../../../lib/editor/preview-math";
import { PLATFORM_IDS, PLATFORM_PROFILES } from "../../../../lib/editor/platform-profiles";
import type { EditorDoc } from "../../../../lib/editor/types";
import { useEditor, type InspectorTab } from "./context";
import { fontFamilyCss } from "./Preview";
import { useFilmstrip, frameAt } from "./filmstrip";
import { Icon } from "./icons";

const SWATCHES = ["#FFFFFF", "#000000", "#FFD54A", "#F3C46A", "#FF5F5F", "#6EE7B0", "#5AA9FF", "#B3A2FF"];

export function Inspector() {
  const { state, ui, setUi } = useEditor();
  const sel = state.selection;
  const selLabel = sel?.kind === "clip" ? "Clip" : sel?.kind === "text" ? "Text" : sel?.kind === "zoom" ? "Zoom" : "Selection";
  const tabs: Array<[InspectorTab, string]> = [
    ["selection", selLabel],
    ["captions", "Captions"],
    ["look", "Look"],
    ["cover", "Cover"],
  ];
  return (
    <aside className="ed-side ed-side-right" aria-label="Inspector">
      <div className="ed-tabs" role="tablist">
        {tabs.map(([id, label]) => (
          <button key={id} type="button" role="tab" className="ed-tab" aria-selected={ui.tab === id} onClick={() => setUi({ tab: id })}>
            {label}
          </button>
        ))}
      </div>
      <div className="ed-scroll">
        {ui.tab === "selection" && <SelectionPanel />}
        {ui.tab === "captions" && <CaptionsPanel />}
        {ui.tab === "look" && <LookPanel />}
        {ui.tab === "cover" && <CoverPanel />}
      </div>
    </aside>
  );
}

function SelectionPanel() {
  const { state, doc } = useEditor();
  const sel = state.selection;
  if (sel?.kind === "clip") {
    const clip = doc.clips.find((c) => c.id === sel.id);
    if (clip) return <ClipPanel clip={clip} />;
  }
  if (sel?.kind === "text") {
    const t = doc.texts.find((x) => x.id === sel.id);
    if (t) return <TextPanel t={t} />;
  }
  if (sel?.kind === "zoom") {
    const z = doc.zooms.find((x) => x.id === sel.id);
    if (z) return <ZoomPanel z={z} />;
  }
  return (
    <div className="flex flex-col items-center gap-3 px-8 py-14 text-center">
      <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-white/[0.05] text-[var(--color-text-faint)]">
        <Icon name="hand" size={20} />
      </div>
      <p className="text-[13px] font-medium">Select something to edit it</p>
      <p className="text-[12px] leading-relaxed text-[var(--color-text-faint)]">
        Click a clip, text or zoom on the timeline — or click text right on the video. Use the Look tab to color the whole video.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------------------

function Section({ title, children, right }: { title?: string; children: ReactNode; right?: ReactNode }) {
  return (
    <div className="ed-section">
      {(title || right) && (
        <div className="mb-3 flex items-center justify-between">
          {title && <p className="ed-eyebrow">{title}</p>}
          {right}
        </div>
      )}
      <div className="flex flex-col gap-3">{children}</div>
    </div>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step = 0.01,
  format = (v) => v.toFixed(2),
  onChange,
  resetTo,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  format?: (v: number) => string;
  onChange: (v: number, final: boolean) => void;
  resetTo?: number;
}) {
  const { commit } = useEditor();
  const fill = ((value - min) / (max - min)) * 100;
  return (
    <div>
      <div className="mb-0.5 flex items-center justify-between">
        <span className="text-[11.5px] text-[var(--color-text-muted)]">{label}</span>
        <button
          type="button"
          className="rounded px-1 text-[11.5px] tabular-nums text-[var(--color-text)] hover:bg-white/[0.06]"
          title={resetTo !== undefined ? "Reset" : undefined}
          onClick={() => resetTo !== undefined && onChange(resetTo, true)}
        >
          {format(value)}
        </button>
      </div>
      <input
        type="range"
        className="ed-range"
        min={min}
        max={max}
        step={step}
        value={value}
        style={{ ["--fill" as string]: `${fill}%` }}
        onChange={(e) => onChange(Number(e.target.value), false)}
        onPointerUp={commit}
        onKeyUp={commit}
        onDoubleClick={() => resetTo !== undefined && onChange(resetTo, true)}
        aria-label={label}
      />
    </div>
  );
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3">
      <span className="text-[12.5px]">{label}</span>
      <button type="button" role="switch" aria-checked={checked} aria-label={label} className="ed-toggle" onClick={() => onChange(!checked)} />
    </label>
  );
}

function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: Array<[T, ReactNode]>; onChange: (v: T) => void; label: string }) {
  return (
    <div className="ed-seg w-full" role="group" aria-label={label}>
      {options.map(([v, l]) => (
        <button key={v} type="button" className="flex-1" aria-pressed={value === v} onClick={() => onChange(v)}>
          {l}
        </button>
      ))}
    </div>
  );
}

function ColorRow({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  const rgb = value.slice(0, 7).toUpperCase();
  return (
    <div>
      <span className="ed-label">{label}</span>
      <div className="flex flex-wrap items-center gap-1.5">
        {SWATCHES.map((c) => (
          <button key={c} type="button" className="ed-swatch" style={{ background: c }} aria-pressed={rgb === c} aria-label={`${label} ${c}`} onClick={() => onChange(c)} />
        ))}
        <label className="ed-swatch relative cursor-pointer overflow-hidden" title="Custom color" style={{ background: "conic-gradient(red, yellow, lime, cyan, blue, magenta, red)" }}>
          <input type="color" value={rgb.toLowerCase()} onChange={(e) => onChange(e.target.value.toUpperCase())} className="absolute inset-0 cursor-pointer opacity-0" aria-label={`Custom ${label}`} />
        </label>
      </div>
    </div>
  );
}

function NumField({ label, value, onChange, step = 0.1, min, max, suffix = "s" }: { label: string; value: number; onChange: (v: number) => void; step?: number; min?: number; max?: number; suffix?: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? value.toFixed(2);
  const commitDraft = () => {
    if (draft === null) return;
    const n = Number(draft);
    setDraft(null);
    if (Number.isFinite(n)) onChange(Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n)));
  };
  return (
    <label className="block">
      <span className="ed-label">{label}</span>
      <div className="relative">
        <input
          className="ed-input pr-6"
          inputMode="decimal"
          value={shown}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitDraft}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitDraft();
            if (e.key === "ArrowUp" || e.key === "ArrowDown") {
              e.preventDefault();
              onChange(Math.min(max ?? Infinity, Math.max(min ?? -Infinity, value + (e.key === "ArrowUp" ? step : -step))));
            }
          }}
          aria-label={label}
        />
        <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[11px] text-[var(--color-text-faint)]">{suffix}</span>
      </div>
    </label>
  );
}

function FontPicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  return (
    <div>
      <span className="ed-label">Font</span>
      <div className="flex flex-col gap-1">
        {FONT_REGISTRY.map((f) => (
          <button
            key={f.id}
            type="button"
            className="ed-card flex items-center justify-between px-3 py-2"
            aria-pressed={value === f.id}
            onClick={() => onChange(f.id)}
            style={{ fontFamily: fontFamilyCss(f.id) }}
          >
            <span className="text-[15px]">{f.label}</span>
            <span className="text-[13px] text-[var(--color-text-faint)]">Aa</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** Plate / outline row: on/off + color (+ opacity for plates). */
function OptionalColor({
  label,
  value,
  defaultColor,
  withOpacity,
  onChange,
}: {
  label: string;
  value: string | null;
  defaultColor: string;
  withOpacity?: boolean;
  onChange: (v: string | null, final: boolean) => void;
}) {
  const on = value != null;
  const { rgb, alpha } = splitHexAlpha(value ?? defaultColor);
  return (
    <div className="flex flex-col gap-2.5">
      <Toggle label={label} checked={on} onChange={(v) => onChange(v ? defaultColor : null, true)} />
      {on && (
        <>
          <ColorRow label={`${label} color`} value={rgb} onChange={(c) => onChange(withOpacity ? joinHexAlpha(c, alpha) : c, true)} />
          {withOpacity && (
            <Slider label="Opacity" value={alpha} min={0.1} max={1} step={0.01} format={(v) => `${Math.round(v * 100)}%`} onChange={(v, f) => onChange(joinHexAlpha(rgb, v), f)} />
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------
// Clip
// ---------------------------------------------------------------------------------------

function ClipPanel({ clip }: { clip: TimelineClip }) {
  const { apply, assets, assetMap, ui, setUi, engine, doc } = useEditor();
  const asset = assetMap.get(clip.mediaAssetId);
  const dur = asset?.duration || undefined;
  const set = (patch: Partial<TimelineClip>, key?: string) => apply((d) => updateClip(d, clip.id, patch), key ? { coalesce: `${key}:${clip.id}` } : undefined);
  const crop = clip.crop;
  const idx = doc.clips.findIndex((c) => c.id === clip.id);
  const start = clipStartTimes(doc)[idx] ?? 0;
  return (
    <>
      <Section title="Take">
        <div className="flex flex-col gap-1">
          {assets.map((a) => (
            <button
              key={a.id}
              type="button"
              className="ed-card flex items-center gap-2 px-2.5 py-2 text-[12.5px]"
              aria-pressed={a.id === clip.mediaAssetId}
              onClick={() => a.id !== clip.mediaAssetId && apply((d) => switchClipSource(d, clip.id, a.id, a.duration))}
            >
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: a.color }} />
              <span className="flex-1 truncate">{a.name}</span>
              <span className="text-[11px] tabular-nums text-[var(--color-text-faint)]">{formatTime(a.duration)}</span>
            </button>
          ))}
        </div>
      </Section>
      <Section title="Trim" right={<span className="text-[11.5px] tabular-nums text-[var(--color-text-muted)]">{clipDuration(clip).toFixed(2)}s long</span>}>
        <div className="grid grid-cols-2 gap-2">
          <NumField label="Starts at (in take)" value={clip.sourceStart} min={0} max={clip.sourceEnd - 0.1} onChange={(v) => apply((d) => trimClip(d, clip.id, "start", v, dur))} />
          <NumField label="Ends at (in take)" value={clip.sourceEnd} min={clip.sourceStart + 0.1} max={dur} onChange={(v) => apply((d) => trimClip(d, clip.id, "end", v, dur))} />
        </div>
        <p className="text-[11px] leading-relaxed text-[var(--color-text-faint)]">Or drag the clip&apos;s edges on the timeline — the picture follows as you trim.</p>
      </Section>
      <Section
        title="Framing"
        right={
          <button type="button" className="text-[11.5px] text-[var(--color-text-faint)] hover:text-[var(--color-text)]" onClick={() => set({ crop: { zoom: 1, panX: 0, panY: 0 } })}>
            Reset
          </button>
        }
      >
        <button
          type="button"
          className={`btn ${ui.reframe ? "btn-primary" : "btn-ghost"} !py-1.5 !text-[12.5px]`}
          onClick={() => {
            const loc = locateOutputTime(doc, engine.time);
            if (loc?.clipIndex !== idx) engine.seek(start + 0.01);
            setUi({ reframe: !ui.reframe });
          }}
        >
          <Icon name="crop" size={14} /> {ui.reframe ? "Done reframing" : "Reframe on the video"}
        </button>
        <Slider label="Zoom" value={crop.zoom} min={1} max={4} format={(v) => `${v.toFixed(2)}×`} resetTo={1} onChange={(v) => set({ crop: { ...crop, zoom: v } }, "cz")} />
        <Slider label="Left ↔ right" value={crop.panX} min={-1} max={1} format={(v) => (v === 0 ? "Center" : v.toFixed(2))} resetTo={0} onChange={(v) => set({ crop: { ...crop, panX: v } }, "cx")} />
        <Slider label="Up ↕ down" value={crop.panY} min={-1} max={1} format={(v) => (v === 0 ? "Center" : v.toFixed(2))} resetTo={0} onChange={(v) => set({ crop: { ...crop, panY: v } }, "cy")} />
      </Section>
      <Section title="Sound">
        <Slider
          label="Volume"
          value={clip.volume}
          min={0}
          max={2}
          format={(v) => (v === 0 ? "Muted" : `${Math.round(v * 100)}%`)}
          resetTo={1}
          onChange={(v) => set({ volume: Math.round(v * 100) / 100 }, "vol")}
        />
        {clip.volume > 1 && <p className="text-[11px] text-[var(--color-text-faint)]">The preview plays at 100%; the boost is applied in the final render.</p>}
      </Section>
    </>
  );
}

// ---------------------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------------------

const TEXT_LOOKS: Array<{ id: TimelineText["preset"]; label: string; patch: Partial<TimelineText> }> = [
  { id: "HEADLINE", label: "Headline", patch: { preset: "HEADLINE", fontId: "inter-display-extrabold", fontSize: 72, color: "#FFFFFF", backgroundColor: "#000000B3", strokeColor: null } },
  { id: "NUMBER_CALLOUT", label: "Big number", patch: { preset: "NUMBER_CALLOUT", fontId: "inter-display-extrabold", fontSize: 150, color: "#FFD54A", backgroundColor: null, strokeColor: "#000000" } },
  { id: "LOWER_THIRD", label: "Lower third", patch: { preset: "LOWER_THIRD", fontId: "inter-semibold", fontSize: 48, color: "#FFFFFF", backgroundColor: "#000000B3", strokeColor: null } },
  { id: "CAPTION", label: "Subtitle", patch: { preset: "CAPTION", fontId: "inter-semibold", fontSize: 56, color: "#FFFFFF", backgroundColor: null, strokeColor: "#000000" } },
];

function TextPanel({ t }: { t: TimelineText }) {
  const { apply, doc } = useEditor();
  const D = timelineDuration(doc);
  const set = (patch: Partial<TimelineText>, key?: string) => apply((d) => updateText(d, t.id, patch), key ? { coalesce: `${key}:${t.id}` } : undefined);
  return (
    <>
      <Section title="Text">
        <textarea className="ed-input" rows={3} value={t.text} maxLength={500} onChange={(e) => e.target.value.trim() && set({ text: e.target.value }, "txt")} aria-label="Text content" />
        <div className="grid grid-cols-2 gap-1.5">
          {TEXT_LOOKS.map((l) => (
            <button key={l.id} type="button" className="ed-card px-2 py-1.5 text-[12px]" aria-pressed={t.preset === l.id} onClick={() => set(l.patch)}>
              {l.label}
            </button>
          ))}
        </div>
      </Section>
      <Section title="Style">
        <FontPicker value={t.fontId} onChange={(fontId) => set({ fontId, preset: "CUSTOM" })} />
        <Slider label="Size" value={t.fontSize} min={12} max={400} step={1} format={(v) => `${Math.round(v)}px`} onChange={(v) => set({ fontSize: Math.round(v) }, "fs")} />
        <ColorRow label="Color" value={t.color} onChange={(color) => set({ color })} />
        <OptionalColor label="Background plate" value={t.backgroundColor} defaultColor="#000000B3" withOpacity onChange={(v, f) => set({ backgroundColor: v }, f ? undefined : "bg")} />
        <OptionalColor label="Outline" value={t.strokeColor} defaultColor="#000000" onChange={(v) => set({ strokeColor: v })} />
        <div className="grid grid-cols-[1fr_auto] items-center gap-3">
          <Seg
            label="Alignment"
            value={t.align}
            options={[
              ["left", "Left"],
              ["center", "Center"],
              ["right", "Right"],
            ]}
            onChange={(align) => set({ align })}
          />
          <button type="button" className="ed-toolbtn !px-2" aria-pressed={t.uppercase} onClick={() => set({ uppercase: !t.uppercase })} title="All caps">
            AA
          </button>
        </div>
        <Slider label="Max line width" value={t.maxWidth} min={0.2} max={1} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => set({ maxWidth: v }, "mw")} />
        <button type="button" className="ed-toolbtn self-start" onClick={() => set({ x: 0.5 })}>
          Center horizontally
        </button>
      </Section>
      <Section title="Timing">
        <div className="grid grid-cols-2 gap-2">
          <NumField label="Shows at" value={t.start} min={0} max={t.end - 0.1} onChange={(v) => set({ start: v })} />
          <NumField label="Hides at" value={t.end} min={t.start + 0.1} max={D} onChange={(v) => set({ end: v })} />
        </div>
        <button type="button" className="ed-toolbtn self-start !text-[var(--color-rose-400)]" onClick={() => apply((d) => deleteText(d, t.id), { select: null })}>
          <Icon name="trash" size={14} /> Remove text
        </button>
      </Section>
    </>
  );
}

// ---------------------------------------------------------------------------------------
// Zoom
// ---------------------------------------------------------------------------------------

function ZoomPanel({ z }: { z: TimelineZoom }) {
  const { apply, doc } = useEditor();
  const D = timelineDuration(doc);
  const set = (patch: Partial<TimelineZoom>, key?: string) => apply((d) => updateZoom(d, z.id, patch), key ? { coalesce: `${key}:${z.id}` } : undefined);
  return (
    <>
      <Section title="Zoom">
        <Slider label="Amount" value={z.zoom} min={1} max={3} format={(v) => `${v.toFixed(2)}×`} resetTo={1.2} onChange={(v) => set({ zoom: Math.round(v * 100) / 100 }, "amt")} />
        <div>
          <span className="ed-label">Motion</span>
          <Seg
            label="Zoom motion"
            value={z.mode}
            options={[
              ["CUT", "Jump cut"],
              ["EASE", "Smooth push"],
            ]}
            onChange={(mode) => set({ mode })}
          />
        </div>
        {z.mode === "EASE" && (
          <Slider label="Push-in time" value={z.easeSeconds} min={0} max={3} format={(v) => `${v.toFixed(1)}s`} resetTo={0.4} onChange={(v) => set({ easeSeconds: Math.round(v * 10) / 10 }, "ease")} />
        )}
      </Section>
      <Section
        title="Aim"
        right={
          <button type="button" className="text-[11.5px] text-[var(--color-text-faint)] hover:text-[var(--color-text)]" onClick={() => set({ x: 0.5, y: 0.4 })}>
            Reset
          </button>
        }
      >
        <p className="text-[12px] leading-relaxed text-[var(--color-text-muted)]">
          <Icon name="target" size={13} className="mr-1 inline" />
          Click on the video to choose what the zoom pushes into (usually the face).
        </p>
      </Section>
      <Section title="Timing">
        <div className="grid grid-cols-2 gap-2">
          <NumField label="Starts" value={z.start} min={0} max={z.end - 0.1} onChange={(v) => set({ start: v })} />
          <NumField label="Ends" value={z.end} min={z.start + 0.1} max={D} onChange={(v) => set({ end: v })} />
        </div>
        <button type="button" className="ed-toolbtn self-start !text-[var(--color-rose-400)]" onClick={() => apply((d) => deleteZoom(d, z.id), { select: null })}>
          <Icon name="trash" size={14} /> Remove zoom
        </button>
      </Section>
    </>
  );
}

// ---------------------------------------------------------------------------------------
// Captions
// ---------------------------------------------------------------------------------------

const CAPTION_LABELS: Record<(typeof CAPTION_PRESETS)[number], string> = {
  CLEAN: "Clean",
  BOLD_HIGHLIGHT: "Highlight",
  BOXED: "Boxed",
  KARAOKE: "Karaoke",
};

function CaptionSample({ c, preset }: { c: TimelineCaptions; preset: (typeof CAPTION_PRESETS)[number] }) {
  const words = ["THE", "BIG", "IDEA"];
  const plate = c.backgroundColor ?? (preset === "BOXED" ? "#000000B3" : null);
  const k = 0.22;
  return (
    <div className="flex h-[54px] items-center justify-center bg-[radial-gradient(circle_at_50%_30%,#3a3530,#121014)]">
      <span
        style={{
          fontFamily: fontFamilyCss(c.fontId),
          fontSize: 15,
          color: c.color,
          WebkitTextStroke: c.strokeColor ? `${strokePx(64) * k}px ${c.strokeColor}` : undefined,
          paintOrder: "stroke fill",
          background: plate ? hexToRgba(plate) : undefined,
          padding: plate ? "1px 6px" : undefined,
          borderRadius: 4,
        }}
      >
        {words.map((w, i) => {
          const hl = (preset === "BOLD_HIGHLIGHT" || preset === "BOXED") && i === 1 ? c.highlightColor : preset === "KARAOKE" && i <= 1 ? c.highlightColor : undefined;
          return (
            <span key={w} style={{ color: hl }}>
              {w}
              {i < 2 ? " " : ""}
            </span>
          );
        })}
      </span>
    </div>
  );
}

function CaptionsPanel() {
  const { doc, apply, wordsByAsset, engine } = useEditor();
  const c = doc.captions;
  const set = (patch: Partial<TimelineCaptions>, key?: string) => apply((d) => updateCaptions(d, patch), key ? { coalesce: `cap:${key}` } : undefined);
  const hasWords = Object.values(wordsByAsset).some((w) => w && w.length);
  return (
    <>
      <Section>
        <Toggle label="Show captions" checked={c.enabled} onChange={(enabled) => set({ enabled })} />
        {!hasWords && <p className="text-[11.5px] leading-relaxed text-[var(--color-text-faint)]">No word timings for these takes yet — transcribe a take on the video page to get captions.</p>}
      </Section>
      {c.enabled && (
        <>
          <Section title="Style">
            <div className="grid grid-cols-2 gap-2">
              {CAPTION_PRESETS.map((p) => (
                <button key={p} type="button" className="ed-card" aria-pressed={c.preset === p} onClick={() => set({ preset: p })}>
                  <CaptionSample c={c} preset={p} />
                  <span className="block px-2 py-1.5 text-[11.5px] font-medium">{CAPTION_LABELS[p]}</span>
                </button>
              ))}
            </div>
            <FontPicker value={c.fontId} onChange={(fontId) => set({ fontId })} />
            <Slider label="Size" value={c.fontSize} min={24} max={200} step={1} format={(v) => `${Math.round(v)}px`} onChange={(v) => set({ fontSize: Math.round(v) }, "fs")} />
            <ColorRow label="Text color" value={c.color} onChange={(color) => set({ color })} />
            {c.preset !== "CLEAN" && <ColorRow label="Spoken-word color" value={c.highlightColor} onChange={(highlightColor) => set({ highlightColor })} />}
            <OptionalColor label="Outline" value={c.strokeColor} defaultColor="#000000" onChange={(strokeColor) => set({ strokeColor })} />
            <OptionalColor label="Background plate" value={c.backgroundColor} defaultColor="#000000B3" withOpacity onChange={(v, f) => set({ backgroundColor: v }, f ? undefined : "bg")} />
          </Section>
          <Section title="Layout">
            <Slider label="Height on screen" value={c.y} min={0.05} max={0.95} format={(v) => `${Math.round(v * 100)}%`} resetTo={0.72} onChange={(y) => set({ y: Math.round(y * 1000) / 1000 }, "y")} />
            <Slider label="Words at a time" value={c.maxWordsPerChunk} min={1} max={8} step={1} format={(v) => String(v)} resetTo={3} onChange={(v) => set({ maxWordsPerChunk: Math.round(v) }, "wpc")} />
            <Toggle label="ALL CAPS" checked={c.uppercase} onChange={(uppercase) => set({ uppercase })} />
          </Section>
          <WordFixes onSeek={(t) => engine.seek(t)} />
        </>
      )}
    </>
  );
}

function WordFixes({ onSeek }: { onSeek: (t: number) => void }) {
  const { doc, apply, wordsByAsset } = useEditor();
  const [q, setQ] = useState("");
  // All words that will be heard (edits ignored so hidden words stay listed and restorable).
  const words = useMemo(
    () => timelineCaptionWords({ clips: doc.clips, captions: { ...doc.captions, wordEdits: {}, uppercase: false } }, wordsByAsset),
    [doc.clips, doc.captions, wordsByAsset],
  );
  const edits = doc.captions.wordEdits;
  const filtered = q.trim() ? words.filter((w) => (edits[w.key] ?? w.word).toLowerCase().includes(q.trim().toLowerCase())) : words;
  if (!words.length) return null;
  return (
    <Section title="Fix words" right={<span className="text-[11px] text-[var(--color-text-faint)]">{Object.keys(edits).length} fixed</span>}>
      <input className="ed-input" placeholder="Find a word…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find a caption word" />
      <ul className="flex max-h-[320px] flex-col gap-0.5 overflow-y-auto pr-1">
        {filtered.slice(0, 400).map((w) => {
          const edited = edits[w.key];
          const hidden = edited === "";
          return (
            <WordRow
              key={w.key}
              time={w.start}
              original={w.word}
              value={edited ?? w.word}
              hidden={hidden}
              changed={edited !== undefined && !hidden}
              onSeek={() => onSeek(w.start + 0.01)}
              onChange={(v) => apply((d) => setWordEdit(d, w.key, v === w.word ? null : v), { coalesce: `word:${w.key}` })}
              onToggleHidden={() => apply((d) => setWordEdit(d, w.key, hidden ? null : ""))}
            />
          );
        })}
      </ul>
    </Section>
  );
}

function WordRow({
  time,
  original,
  value,
  hidden,
  changed,
  onSeek,
  onChange,
  onToggleHidden,
}: {
  time: number;
  original: string;
  value: string;
  hidden: boolean;
  changed: boolean;
  onSeek: () => void;
  onChange: (v: string) => void;
  onToggleHidden: () => void;
}) {
  const { commit } = useEditor();
  return (
    <li className="flex items-center gap-1.5">
      <button type="button" className="w-[44px] shrink-0 rounded px-1 py-1 text-left text-[10.5px] tabular-nums text-[var(--color-text-faint)] hover:bg-white/[0.06] hover:text-[var(--color-text)]" onClick={onSeek} title="Jump here">
        {formatTime(time, true).slice(0, -1)}
      </button>
      <input
        className="ed-input !h-[26px] flex-1"
        value={hidden ? original : value}
        disabled={hidden}
        onChange={(e) => e.target.value.trim() && onChange(e.target.value)}
        onBlur={commit}
        style={{ textDecoration: hidden ? "line-through" : undefined, opacity: hidden ? 0.45 : 1, borderColor: changed ? "color-mix(in srgb, var(--color-gold-500) 50%, transparent)" : undefined }}
        aria-label={`Caption word ${original}`}
      />
      <button type="button" className="ed-iconbtn !h-[26px] !w-[26px]" aria-pressed={hidden} onClick={onToggleHidden} title={hidden ? "Show this word" : "Hide this word (e.g. “um”)"} aria-label={hidden ? "Show word" : "Hide word"}>
        <Icon name={hidden ? "plus" : "close"} size={12} />
      </button>
    </li>
  );
}

// ---------------------------------------------------------------------------------------
// Look (grade)
// ---------------------------------------------------------------------------------------

const GRADE_LABELS: Record<(typeof GRADE_PRESETS)[number], string> = {
  NONE: "Original",
  WARM: "Warm",
  COOL: "Cool",
  PUNCHY: "Punchy",
  MATTE: "Matte",
  BW: "B&W",
  CINEMATIC: "Cinematic",
};

function LookPanel() {
  const { doc, apply, engine } = useEditor();
  const g = doc.grade;
  const [frame, setFrame] = useState<string | null>(null);
  useEffect(() => {
    const grab = () => setFrame(engine.snapshot(96));
    grab();
    const id = setTimeout(grab, 600);
    return () => clearTimeout(id);
  }, [engine, doc.clips]);
  const set = (patch: Parameters<typeof updateGrade>[1], key: string) => apply((d) => updateGrade(d, patch), { coalesce: `grade:${key}` });
  return (
    <>
      <Section
        title="Look"
        right={
          <button type="button" className="text-[11.5px] text-[var(--color-text-faint)] hover:text-[var(--color-text)]" onClick={() => apply((d) => applyGradePreset(d, "NONE"))}>
            Reset
          </button>
        }
      >
        <div className="grid grid-cols-4 gap-1.5">
          {GRADE_PRESETS.map((p) => {
            const css = gradeCss(GRADE_PRESET_VALUES[p]);
            return (
              <button key={p} type="button" className="ed-card" aria-pressed={g.preset === p} onClick={() => apply((d) => applyGradePreset(d, p))} title={GRADE_LABELS[p]}>
                <div className="relative aspect-[9/14] overflow-hidden bg-[linear-gradient(160deg,#c9a27a,#5b4636_55%,#1c2733)]">
                  {frame && <img src={frame} alt="" className="absolute inset-0 h-full w-full object-cover" style={{ filter: css.filter === "none" ? undefined : css.filter }} />}
                  {!frame && <div className="absolute inset-0" style={{ filter: css.filter === "none" ? undefined : css.filter, background: "linear-gradient(160deg,#e0b48a,#7a5a44 50%,#2a3a4a)" }} />}
                  {css.wash && <div className="absolute inset-0" style={{ background: css.wash.color, opacity: css.wash.opacity, mixBlendMode: "soft-light" }} />}
                  {css.vignette > 0 && <div className="absolute inset-0" style={{ background: `radial-gradient(ellipse at center, transparent 40%, rgba(0,0,0,${css.vignette * 0.9}) 100%)` }} />}
                </div>
                <span className="block truncate px-1 py-1 text-center text-[10.5px] font-medium">{GRADE_LABELS[p]}</span>
              </button>
            );
          })}
        </div>
      </Section>
      <Section title="Adjust">
        <Slider label="Brightness" value={g.brightness} min={-1} max={1} format={(v) => signed(v)} resetTo={0} onChange={(v) => set({ brightness: r2(v) }, "b")} />
        <Slider label="Contrast" value={g.contrast} min={0} max={2} format={(v) => signed(v - 1)} resetTo={1} onChange={(v) => set({ contrast: r2(v) }, "c")} />
        <Slider label="Saturation" value={g.saturation} min={0} max={2} format={(v) => signed(v - 1)} resetTo={1} onChange={(v) => set({ saturation: r2(v) }, "s")} />
        <Slider label="Temperature" value={g.temperature} min={-1} max={1} format={(v) => (v === 0 ? "0" : v > 0 ? `Warm ${Math.round(v * 100)}` : `Cool ${Math.round(-v * 100)}`)} resetTo={0} onChange={(v) => set({ temperature: r2(v) }, "t")} />
        <Slider label="Vignette" value={g.vignette} min={0} max={1} format={(v) => `${Math.round(v * 100)}`} resetTo={0} onChange={(v) => set({ vignette: r2(v) }, "v")} />
        <p className="text-[11px] leading-relaxed text-[var(--color-text-faint)]">Applies to the whole video. Double-click a slider to reset it.</p>
      </Section>
    </>
  );
}

function r2(n: number) {
  return Math.round(n * 100) / 100;
}
function signed(v: number) {
  const n = Math.round(v * 100);
  return n > 0 ? `+${n}` : String(n);
}

// ---------------------------------------------------------------------------------------
// Cover
// ---------------------------------------------------------------------------------------

function CoverPanel() {
  const { doc, apply, engine, assetMap } = useEditor();
  const cover = doc.coverFrameSeconds ?? null;
  const loc = cover != null ? locateOutputTime(doc, cover) : null;
  const clip = loc ? doc.clips[loc.clipIndex] : undefined;
  const strip = useFilmstrip(clip ? assetMap.get(clip.mediaAssetId) : undefined);
  const [live, setLive] = useState<string | null>(null);
  const thumb = live ?? (strip && loc ? frameAt(strip, loc.sourceTime) : undefined);
  return (
    <>
      <Section title="Cover frame">
        <div className="flex gap-3">
          <div className="relative aspect-[9/16] w-[96px] shrink-0 overflow-hidden rounded-lg border border-[var(--ed-line-strong)] bg-black">
            {cover != null && thumb ? (
              <img src={thumb} alt="Cover frame" className="h-full w-full object-cover" style={{ filter: gradeCss(doc.grade).filter === "none" ? undefined : gradeCss(doc.grade).filter }} />
            ) : (
              <div className="flex h-full items-center justify-center p-2 text-center text-[10.5px] text-[var(--color-text-faint)]">{cover != null ? formatTime(cover, true) : "Platform picks"}</div>
            )}
          </div>
          <div className="flex flex-col gap-2">
            <p className="text-[12px] leading-relaxed text-[var(--color-text-muted)]">
              {cover != null ? `Cover is the frame at ${formatTime(cover, true)}.` : "No cover chosen — each app picks its own."}
            </p>
            <button
              type="button"
              className="btn btn-primary !py-1.5 !text-[12.5px]"
              onClick={() => {
                const t = engine.time;
                setLive(engine.snapshot(180));
                apply((d) => setCover(d, t));
              }}
            >
              <Icon name="image" size={14} /> Use frame at playhead
            </button>
            {cover != null && (
              <div className="flex gap-1">
                <button type="button" className="ed-toolbtn" onClick={() => engine.seek(cover)}>
                  Go to it
                </button>
                <button
                  type="button"
                  className="ed-toolbtn"
                  onClick={() => {
                    setLive(null);
                    apply((d: EditorDoc) => setCover(d, null));
                  }}
                >
                  Clear
                </button>
              </div>
            )}
          </div>
        </div>
      </Section>
      <Section title="Per platform">
        <ul className="flex flex-col gap-2">
          {PLATFORM_IDS.map((p) => {
            const prof = PLATFORM_PROFILES[p];
            return (
              <li key={p} className="flex items-start gap-2 text-[12px]">
                <span className={prof.coverFrame.supported ? "text-[var(--color-emerald-400)]" : "text-[var(--color-text-faint)]"}>
                  <Icon name={prof.coverFrame.supported ? "check" : "close"} size={13} />
                </span>
                <span>
                  <span className="font-medium">{prof.label}</span>
                  {prof.coverFrame.note && <span className="block text-[11.5px] text-[var(--color-text-faint)]">{prof.coverFrame.note}</span>}
                </span>
              </li>
            );
          })}
        </ul>
      </Section>
    </>
  );
}

