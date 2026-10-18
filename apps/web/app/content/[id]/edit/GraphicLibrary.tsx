"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  GRAPHIC_CATEGORIES,
  GRAPHIC_COMPONENT_SPECS,
  GRAPHIC_PRESETS,
  presetBase,
  searchPresets,
  suggestGraphics,
  timelineCaptionWords,
  type GraphicCategory,
  type GraphicComponent,
  type GraphicPreset,
  type GraphicSuggestion,
  type MotionTemplate,
  type MotionTheme,
} from "@chris/media/timeline";
import { presetVisual } from "@chris/motion/pure";
import { addPresetVisual } from "../../../../lib/editor/graphics";
import { TEMPLATE_LABEL, phraseAt } from "../../../../lib/editor/visuals";
import { newId } from "../../../../lib/editor/timeline-ops";
import { useEditor } from "./context";
import { usePlayheadValue } from "./playback";
import { designVisualsAction, designVisualsResultAction, graphicPrefsAction, recordGraphicUseAction, setGraphicFavoriteAction } from "./actions";
import { waitForJob } from "../../../../lib/use-job-progress";
import { TemplateArt } from "./template-art";
import { Icon } from "./icons";
import "./graphics.css";

/**
 * The graphics LIBRARY in the Visuals sheet (phone-first): search (fuzzy, synonyms), category
 * chips, ★ favourites and recently used (per user, saved in the DB), "For this moment"
 * suggestions pre-filled from what's being said at the playhead (deterministic, free) plus an
 * optional "Suggest with AI", and a grid of 150+ presets with real rendered posters. Tap a card
 * to add it at the playhead (then its edit sheet opens); ▶ plays a live animated preview.
 */
const PresetPlayer = dynamic(() => import("@chris/motion/preset-player").then((m) => m.PresetPlayer), { ssr: false, loading: () => null });

type Filter = "ALL" | "FAV" | "RECENT" | GraphicCategory;

export function baseLabel(p: GraphicPreset): string {
  const b = presetBase(p);
  return p.template === "GRAPHIC" ? GRAPHIC_COMPONENT_SPECS[b as GraphicComponent].label : TEMPLATE_LABEL[b as MotionTemplate];
}

export function GraphicLibrary() {
  const { doc, engine, apply, toast, wordsByAsset, setUi, touch, itemId, dirty, save, loadSavedVersion } = useEditor();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("ALL");
  const [prefs, setPrefs] = useState<{ favorites: string[]; recents: string[] }>({ favorites: [], recents: [] });
  const [preview, setPreview] = useState<GraphicPreset | null>(null);
  const [ai, setAi] = useState<{ phase: "idle" | "running" | "error"; message?: string }>({ phase: "idle" });
  useEffect(() => {
    let alive = true;
    graphicPrefsAction()
      .then((p) => alive && setPrefs(p))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  const words = useMemo(() => timelineCaptionWords(doc, wordsByAsset), [doc, wordsByAsset]);
  // Suggestions follow the playhead in half-second steps (cheap; recomputed only when it moves).
  const tq = usePlayheadValue(engine, (t) => Math.round(t * 2) / 2);
  const phrase = useMemo(() => phraseAt(words, tq, 24), [words, tq]);
  // Suggestions read a little further than the sentence (comparisons span sentences:
  // "as an employee… as a freelancer… as a business owner…").
  const ahead = useMemo(() => words.filter((w) => w.end > tq - 1 && w.start < tq + 9).map((w) => w.word).join(" "), [words, tq]);
  const suggestions = useMemo(() => (ahead || phrase ? suggestGraphics(ahead || phrase, 6) : []), [ahead, phrase]);
  const fav = useMemo(() => new Set(prefs.favorites), [prefs.favorites]);

  const list = useMemo(() => {
    if (filter === "FAV") return GRAPHIC_PRESETS.filter((p) => fav.has(p.id) && (!query || searchPresets(query).some((h) => h.preset.id === p.id)));
    if (filter === "RECENT") return prefs.recents.map((id) => GRAPHIC_PRESETS.find((p) => p.id === id)).filter((p): p is GraphicPreset => !!p);
    return searchPresets(query, { category: filter === "ALL" ? null : filter, favorites: fav, recents: prefs.recents }).map((h) => h.preset);
  }, [query, filter, fav, prefs.recents]);

  const insert = (preset: GraphicPreset, props?: Record<string, unknown>, anchor?: string | null) => {
    const t = engine.time;
    const id = newId("vis");
    const probe = addPresetVisual(doc, preset, t, { id, props, anchorText: anchor ?? (phrase || null) });
    if (!probe.id) {
      toast("No room for another graphic here — graphics can't overlap. Shorten or delete one first.", "warn");
      return;
    }
    engine.pause();
    apply((d) => addPresetVisual(d, preset, t, { id, props, anchorText: anchor ?? (phrase || null) }).doc, { select: { kind: "visual", id } });
    const added = probe.doc.visuals.find((v) => v.id === id)!;
    engine.seek(Math.min(added.end - 0.05, added.start + Math.min(2.4, (added.end - added.start) * 0.6)));
    if (touch) setUi({ sheet: "visuals" });
    toast(`${preset.name} added at ${added.start.toFixed(1)}s.`);
    setPreview(null);
    setPrefs((p) => ({ ...p, recents: [preset.id, ...p.recents.filter((x) => x !== preset.id)].slice(0, 12) }));
    void recordGraphicUseAction(preset.id).then((p) => p && setPrefs(p));
  };

  const toggleFav = (preset: GraphicPreset) => {
    const on = !fav.has(preset.id);
    setPrefs((p) => ({ ...p, favorites: on ? [preset.id, ...p.favorites] : p.favorites.filter((x) => x !== preset.id) }));
    void setGraphicFavoriteAction(preset.id, on).then((p) => p && setPrefs(p));
  };

  const suggestWithAi = async () => {
    if (ai.phase === "running") return;
    const t = engine.time;
    setAi({ phase: "running" });
    if (dirty && !(await save())) {
      setAi({ phase: "error", message: "Your edit couldn't be saved, so the AI didn't run." });
      return;
    }
    try {
      const focus = { start: Math.max(0, t - 1), end: t + 4, phrase: phrase || null };
      let res = await designVisualsAction({ contentItemId: itemId, focus });
      if (res.ok && "pending" in res) {
        const done = await waitForJob(res.jobRunId, () => undefined);
        res = done.status === "SUCCEEDED" || done.status === "FAILED" ? await designVisualsResultAction(itemId, res.jobRunId) : { ok: false, error: "The AI didn't finish — try again." };
      }
      if (!res.ok) {
        setAi({ phase: "error", message: res.error });
        return;
      }
      loadSavedVersion(res.timeline, res.state);
      setAi({ phase: "idle" });
      toast(res.added.length ? "The AI added a graphic for this moment — saved as a new version (undo to remove)." : "The AI didn't find a graphic worth adding here.");
    } catch {
      setAi({ phase: "error", message: "Couldn't reach the server. Your edit is unchanged." });
    }
  };

  const chips: Array<[Filter, string]> = [["ALL", "All"], ["FAV", "★ Favorites"], ["RECENT", "Recent"], ...GRAPHIC_CATEGORIES.map((c) => [c.id, c.label] as [Filter, string])];
  return (
    <div className="gl">
      <div className="gl-search">
        <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden className="gl-search-icon">
          <path d="M10.5 18a7.5 7.5 0 1 0 0-15a7.5 7.5 0 0 0 0 15zM16 16l5 5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
        <input
          className="ed-input gl-search-input"
          type="search"
          value={query}
          placeholder="Search 150+ graphics — income, vs, donut…"
          aria-label="Search graphics"
          onChange={(e) => setQuery(e.target.value)}
          enterKeyHint="search"
        />
        {query && (
          <button type="button" className="gl-clear" onClick={() => setQuery("")} aria-label="Clear search">
            <Icon name="close" size={14} />
          </button>
        )}
      </div>

      {!query && filter === "ALL" && (
        <div className="gl-suggest">
          <div className="gl-suggest-head">
            <span className="ed-eyebrow">For this moment{phrase ? "" : " (move the playhead to where you talk)"}</span>
            <button type="button" className="gl-ai-btn" onClick={() => void suggestWithAi()} disabled={ai.phase === "running"}>
              {ai.phase === "running" ? <span className="ed-spinner" aria-hidden /> : <Icon name="magic" size={13} />} Suggest with AI
            </button>
          </div>
          {phrase && <p className="gl-phrase">“{phrase}”</p>}
          {ai.phase === "error" && <p className="ed-ai-error" role="alert"><Icon name="warn" size={13} /> <span>{ai.message}</span></p>}
          {suggestions.length > 0 && (
            <div className="gl-suggest-row" role="list">
              {suggestions.map((s) => (
                <SuggestionCard key={s.preset.id} s={s} onAdd={() => insert(s.preset, s.props)} />
              ))}
            </div>
          )}
        </div>
      )}

      <div className="gl-chips" role="tablist" aria-label="Categories">
        {chips.map(([id, label]) => (
          <button key={id} type="button" role="tab" className="ed-chip-btn gl-chip" aria-selected={filter === id} aria-pressed={filter === id} onClick={() => setFilter(id)}>
            {label}
          </button>
        ))}
      </div>

      {list.length === 0 ? (
        <p className="gl-empty">
          {filter === "FAV" ? "Tap ☆ on any graphic to keep it here." : filter === "RECENT" ? "Graphics you add show up here." : `Nothing matches “${query}”. Try “income”, “vs”, “chart”, “steps”…`}
        </p>
      ) : (
        <div className="gl-grid">
          {list.map((p) => (
            <PresetCard key={p.id} p={p} fav={fav.has(p.id)} onAdd={() => insert(p)} onFav={() => toggleFav(p)} onPreview={() => setPreview(p)} />
          ))}
        </div>
      )}

      {preview && <PreviewDialog p={preview} fav={fav.has(preview.id)} onClose={() => setPreview(null)} onAdd={() => insert(preview)} onFav={() => toggleFav(preview)} motionTheme={doc.motionTheme} />}
    </div>
  );
}

function Poster({ p, className }: { p: GraphicPreset; className?: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <span className={`gl-poster gl-poster-art ${className ?? ""}`}>
        <TemplateArt template={p.template} size={44} />
      </span>
    );
  }
  return (
    // Plain <img>: tiny static posters, lazy-loaded; next/image adds nothing here.
    <img className={`gl-poster ${className ?? ""}`} src={`/motion-posters/${p.id}.jpg`} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} />
  );
}

function Star({ on }: { on: boolean }) {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden>
      <path d="M12 3.5l2.6 5.3l5.9.9l-4.3 4.1l1 5.8L12 16.9l-5.2 2.7l1-5.8l-4.3-4.1l5.9-.9z" fill={on ? "#FFD54A" : "none"} stroke={on ? "#FFD54A" : "currentColor"} strokeWidth="1.8" strokeLinejoin="round" />
    </svg>
  );
}

function PresetCard({ p, fav, onAdd, onFav, onPreview }: { p: GraphicPreset; fav: boolean; onAdd: () => void; onFav: () => void; onPreview: () => void }) {
  return (
    <div className="gl-card">
      <button type="button" className="gl-card-main" onClick={onAdd} aria-label={`Add ${p.name} at the playhead`}>
        <span className="gl-card-art">
          <Poster p={p} />
        </span>
        <span className="gl-card-name">{p.name}</span>
        <span className="gl-card-base">{baseLabel(p)}</span>
      </button>
      <button type="button" className="gl-card-fav" onClick={onFav} aria-label={fav ? `Remove ${p.name} from favorites` : `Add ${p.name} to favorites`} aria-pressed={fav}>
        <Star on={fav} />
      </button>
      <button type="button" className="gl-card-play" onClick={onPreview} aria-label={`Preview ${p.name}`}>
        <Icon name="play" size={12} />
      </button>
    </div>
  );
}

function SuggestionCard({ s, onAdd }: { s: GraphicSuggestion; onAdd: () => void }) {
  return (
    <button type="button" role="listitem" className="gl-sug" onClick={onAdd} aria-label={`Add ${s.preset.name}: ${s.reason}`}>
      <span className="gl-sug-art">
        <Poster p={s.preset} />
      </span>
      <span className="gl-sug-name">{s.preset.name}</span>
      <span className="gl-sug-why">{s.reason}</span>
    </button>
  );
}

function PreviewDialog({ p, fav, onClose, onAdd, onFav, motionTheme }: { p: GraphicPreset; fav: boolean; onClose: () => void; onAdd: () => void; onFav: () => void; motionTheme: MotionTheme | null }) {
  const visual = useMemo(() => presetVisual(p, 0, p.seconds), [p]);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  // Portalled to <body>: the bottom sheet is transformed, which would trap a fixed overlay.
  return createPortal(
    <div className="gl-dialog-backdrop" onClick={onClose}>
      <div className="gl-dialog" role="dialog" aria-modal="true" aria-label={`Preview: ${p.name}`} tabIndex={-1} ref={ref} onClick={(e) => e.stopPropagation()}>
        <div className="gl-dialog-stage">
          <PresetPlayer visual={visual} width={180} height={320} motionTheme={motionTheme} />
        </div>
        <div className="gl-dialog-body">
          <p className="gl-dialog-name">{p.name}</p>
          <p className="gl-dialog-desc">{p.description}</p>
          <p className="gl-dialog-meta">
            {baseLabel(p)} · {GRAPHIC_CATEGORIES.find((c) => c.id === p.category)?.label} · {p.seconds}s
          </p>
          <p className="gl-dialog-tags">{p.tags.slice(0, 6).join(" · ")}</p>
          <div className="gl-dialog-actions">
            <button type="button" className="btn btn-primary" onClick={onAdd}>
              <Icon name="plus" size={15} /> Add at playhead
            </button>
            <button type="button" className="btn btn-ghost" onClick={onFav} aria-pressed={fav}>
              <Star on={fav} /> {fav ? "Saved" : "Favorite"}
            </button>
          </div>
          <p className="gl-dialog-note">Sample numbers — tap the graphic after adding to put in yours. Every number, label and layout is editable.</p>
          <button type="button" className="gl-dialog-close" onClick={onClose} aria-label="Close preview">
            <Icon name="close" size={16} />
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
