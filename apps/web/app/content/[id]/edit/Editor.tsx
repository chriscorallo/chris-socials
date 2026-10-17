"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  EditTimelineSchema,
  timelineCaptionChunks,
  timelineDuration,
  type TranscriptWord,
} from "@chris/media/timeline";
import { editorReducer, initEditorState, buildSavePayload } from "../../../../lib/editor/reducer";
import {
  splitAt,
  deleteClip,
  deleteText,
  deleteZoom,
  duplicateClip,
  duplicateText,
  newId,
} from "../../../../lib/editor/timeline-ops";
import { platformWarnings } from "../../../../lib/editor/platform-warnings";
import { PLATFORM_IDS } from "../../../../lib/editor/platform-profiles";
import { formatTime } from "../../../../lib/editor/preview-math";
import type { EditorAsset, EditorDoc, Selection } from "../../../../lib/editor/types";
import { EditorContext, type EditorContextValue, type EditorUi } from "./context";
import { usePlaybackEngine } from "./playback";
import { FONT_FACE_CSS, browserMeasureText, useFontsVersion } from "./measure";
import { saveFinishingEditAction } from "./actions";
import { MediaBin } from "./MediaBin";
import { Preview } from "./Preview";
import { TimelinePanel } from "./TimelinePanel";
import { Inspector } from "./Inspector";
import { FinishModal } from "./FinishModal";
import { MobileShell } from "./MobileShell";
import { useEditorLayout } from "./layout-hooks";
import { Icon } from "./icons";
import "./editor.css";

export interface EditorProps {
  item: { id: string; title: string; state: string };
  planId: string;
  initialDoc: EditorDoc;
  assets: EditorAsset[];
  schedule: { date: string; platforms: string[]; isScheduled: boolean };
}

interface Toast {
  id: number;
  message: string;
  tone: "ok" | "warn" | "error";
}

function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  const tag = t.tagName;
  if (t.isContentEditable) return true;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") {
    const type = (t as HTMLInputElement).type;
    return !["range", "checkbox", "radio", "button", "color"].includes(type);
  }
  return false;
}

export function Editor({ item, planId, initialDoc, assets, schedule }: EditorProps) {
  const assetMap = useMemo(() => new Map(assets.map((a) => [a.id, a])), [assets]);
  const durations = useMemo(() => Object.fromEntries(assets.map((a) => [a.id, a.duration])), [assets]);
  const [state, dispatch] = useReducer(editorReducer, undefined, () => initEditorState(initialDoc, durations));
  const doc = state.doc;
  const engine = usePlaybackEngine(doc, assetMap);
  const [ui, setUiState] = useState<EditorUi>({ reframe: false, platformView: "ALL", tab: "look", pxPerSec: 60, sheet: null, editingTextId: null });
  const layout = useEditorLayout();
  const touch = !layout.desktop;
  const setUi = useCallback((patch: Partial<EditorUi>) => setUiState((u) => ({ ...u, ...patch })), []);
  const [itemState, setItemState] = useState(item.state);
  const [saving, setSaving] = useState(false);
  const [finishOpen, setFinishOpen] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [restored, setRestored] = useState(false);
  const [showKeys, setShowKeys] = useState(false);
  const dirty = state.doc !== state.savedDoc;

  const wordsByAsset = useMemo(() => {
    const out: Record<string, TranscriptWord[] | null> = {};
    for (const a of assets) out[a.id] = a.words;
    return out;
  }, [assets]);
  const chunks = useMemo(() => timelineCaptionChunks(doc, wordsByAsset), [doc, wordsByAsset]);
  const fontsVersion = useFontsVersion([doc.captions.fontId, ...doc.texts.map((t) => t.fontId)]);
  const sourceSizes = useMemo(() => Object.fromEntries(assets.map((a) => [a.id, { width: a.width, height: a.height }])), [assets]);
  const warnings = useMemo(
    // Only after fonts load on the client (fontsVersion > 0): layouts need real glyph widths,
    // and the server render must match the first client render (no warnings yet).
    () => (fontsVersion > 0 ? platformWarnings(doc, ui.platformView === "ALL" ? PLATFORM_IDS : [ui.platformView], wordsByAsset, browserMeasureText, sourceSizes) : []),
    [doc, ui.platformView, wordsByAsset, sourceSizes, fontsVersion],
  );

  const toast = useCallback((message: string, tone: Toast["tone"] = "ok") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-2), { id, message, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === "error" ? 7000 : 3200);
  }, []);

  const apply = useCallback<EditorContextValue["apply"]>(
    (recipe, opts) => dispatch({ type: "apply", recipe, coalesce: opts?.coalesce, select: opts?.select }),
    [],
  );
  const commit = useCallback(() => dispatch({ type: "commit" }), []);

  const focus = useCallback(
    (sel: Selection) => {
      dispatch({ type: "select", selection: sel });
      if (!sel) return;
      setUi({ tab: sel.kind === "captions" ? "captions" : "selection" });
      const t = engine.time;
      let span: { start: number; end: number } | null = null;
      if (sel.kind === "text") span = doc.texts.find((x) => x.id === sel.id) ?? null;
      if (sel.kind === "zoom") span = doc.zooms.find((x) => x.id === sel.id) ?? null;
      if (span && (t < span.start || t >= span.end)) engine.seek(span.start + Math.min(0.05, (span.end - span.start) / 2));
    },
    [doc, engine, setUi],
  );

  // ---------------------------------------------------------------- local draft autosave
  const draftKey = `chris-editor:${item.id}:${planId}`;
  const restoredOnce = useRef(false);
  useEffect(() => {
    if (restoredOnce.current) return;
    restoredOnce.current = true;
    try {
      const raw = localStorage.getItem(draftKey);
      if (!raw) return;
      const draft = JSON.parse(raw) as EditorDoc;
      const parsed = EditTimelineSchema.safeParse(draft);
      if (!parsed.success) return;
      const restoredDoc: EditorDoc = parsed.data;
      if (JSON.stringify(restoredDoc) === JSON.stringify(initialDoc)) return;
      dispatch({ type: "replace", doc: restoredDoc });
      setRestored(true);
    } catch {
      // storage unavailable or corrupt draft — start from the saved version
    }
  }, [draftKey, initialDoc]);

  useEffect(() => {
    const handle = setTimeout(() => {
      try {
        if (dirty) localStorage.setItem(draftKey, JSON.stringify(state.doc));
        else localStorage.removeItem(draftKey);
      } catch {
        // storage full / blocked — the server save still works
      }
    }, 400);
    return () => clearTimeout(handle);
  }, [state.doc, dirty, draftKey]);

  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  const discardDraft = () => {
    try {
      localStorage.removeItem(draftKey);
    } catch {
      /* ignore */
    }
    dispatch({ type: "replace", doc: state.savedDoc });
    setRestored(false);
  };

  // ---------------------------------------------------------------- save
  const save = useCallback(async (): Promise<boolean> => {
    const docAtSave = state.doc;
    const payload = buildSavePayload(docAtSave);
    if (!payload.ok) {
      toast(`Can't save yet — ${payload.error}`, "error");
      return false;
    }
    setSaving(true);
    try {
      const res = await saveFinishingEditAction({
        contentItemId: item.id,
        timeline: payload.timeline,
      });
      if (!res.ok) {
        toast(res.error, "error");
        return false;
      }
      dispatch({ type: "markSaved", doc: docAtSave });
      setItemState(res.state);
      setRestored(false);
      try {
        localStorage.removeItem(draftKey);
      } catch {
        /* ignore */
      }
      toast("Saved. It will re-render when you finish.");
      return true;
    } catch {
      toast("Couldn't reach the server — your edit is kept on this device. Try again.", "error");
      return false;
    } finally {
      setSaving(false);
    }
  }, [state.doc, item.id, draftKey, toast]);

  // ---------------------------------------------------------------- keyboard
  const deleteSelection = useCallback(() => {
    const sel = state.selection;
    if (!sel) return;
    if (sel.kind === "clip") {
      if (doc.clips.length <= 1) return toast("A video needs at least one clip.", "warn");
      apply((d) => deleteClip(d, sel.id), { select: null });
    } else if (sel.kind === "text") apply((d) => deleteText(d, sel.id), { select: null });
    else if (sel.kind === "zoom") apply((d) => deleteZoom(d, sel.id), { select: null });
  }, [state.selection, doc.clips.length, apply, toast]);

  const duplicateSelection = useCallback(() => {
    const sel = state.selection;
    if (sel?.kind === "clip") {
      const id = newId("clip");
      apply((d) => duplicateClip(d, sel.id, id).doc, { select: { kind: "clip", id } });
    } else if (sel?.kind === "text") {
      const id = newId("text");
      apply((d) => duplicateText(d, sel.id, id).doc, { select: { kind: "text", id } });
    }
  }, [state.selection, apply]);

  const split = useCallback(() => {
    const id = newId("clip");
    const t = engine.time;
    if (!splitAt(doc, t, id).newClipId) {
      toast("Move the playhead inside a clip to split it.", "warn");
      return;
    }
    apply((d) => splitAt(d, t, id).doc, { select: { kind: "clip", id } });
  }, [apply, engine, toast, doc]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void save();
        return;
      }
      if (isTypingTarget(e.target)) return;
      const step = e.shiftKey ? 1 : 1 / 30;
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        dispatch({ type: e.shiftKey ? "redo" : "undo" });
        return;
      }
      if (mod && e.key.toLowerCase() === "y") {
        e.preventDefault();
        dispatch({ type: "redo" });
        return;
      }
      if (mod && e.key.toLowerCase() === "d") {
        e.preventDefault();
        duplicateSelection();
        return;
      }
      if (mod) return;
      switch (e.key) {
        case " ":
        case "k":
        case "K":
          e.preventDefault();
          engine.toggle();
          break;
        case "ArrowLeft":
          e.preventDefault();
          engine.pause();
          engine.seek(engine.time - step);
          break;
        case "ArrowRight":
          e.preventDefault();
          engine.pause();
          engine.seek(engine.time + step);
          break;
        case "j":
        case "J":
          engine.seek(engine.time - 1);
          break;
        case "l":
        case "L":
          engine.seek(engine.time + 1);
          break;
        case "Home":
          engine.seek(0);
          break;
        case "End":
          engine.seek(engine.totalDuration);
          break;
        case "s":
        case "S":
          e.preventDefault();
          split();
          break;
        case "Backspace":
        case "Delete":
          e.preventDefault();
          deleteSelection();
          break;
        case "Escape":
          if (ui.reframe) setUi({ reframe: false });
          else if (ui.sheet) setUi({ sheet: null });
          else dispatch({ type: "select", selection: null });
          break;
        case "?":
          setShowKeys((v) => !v);
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [engine, save, split, deleteSelection, duplicateSelection, ui.reframe, ui.sheet, setUi]);

  // Switch the inspector to whatever was just selected.
  const selKey = state.selection ? `${state.selection.kind}:${"id" in state.selection ? state.selection.id : ""}` : "";
  useEffect(() => {
    if (!selKey) return;
    setUi({ tab: selKey.startsWith("captions") ? "captions" : "selection" });
  }, [selKey, setUi]);
  useEffect(() => {
    if (state.selection?.kind !== "clip" && ui.reframe) setUi({ reframe: false });
  }, [state.selection, ui.reframe, setUi]);

  const ctx: EditorContextValue = {
    state,
    doc,
    dispatch,
    apply,
    commit,
    engine,
    assets,
    assetMap,
    wordsByAsset,
    chunks,
    ui,
    setUi,
    warnings,
    fontsVersion,
    focus,
    toast,
    touch,
  };

  const duration = timelineDuration(doc);

  const toastList = (
    <div className={`ed-toasts ${touch ? "ed-toasts-m" : ""}`} aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`ed-toast ed-toast-${t.tone}`}>
          {t.message}
        </div>
      ))}
    </div>
  );

  const finishModal = finishOpen && (
    <FinishModal
      itemId={item.id}
      itemState={itemState}
      dirty={dirty}
      defaultDate={schedule.date}
      defaultPlatforms={schedule.platforms}
      onClose={() => setFinishOpen(false)}
      onSaved={(savedState) => {
        dispatch({ type: "markSaved", doc: state.doc });
        setItemState(savedState);
        try {
          localStorage.removeItem(draftKey);
        } catch {
          /* ignore */
        }
      }}
      onStateChange={setItemState}
    />
  );

  if (touch) {
    return (
      <EditorContext.Provider value={ctx}>
        <style dangerouslySetInnerHTML={{ __html: FONT_FACE_CSS }} />
        <MobileShell
          item={item}
          saving={saving}
          dirty={dirty}
          restored={restored}
          onDiscardDraft={discardDraft}
          onSave={() => void save()}
          onFinish={() => {
            engine.pause();
            setUi({ sheet: null, editingTextId: null });
            setFinishOpen(true);
          }}
          onSplit={split}
          onDelete={deleteSelection}
          onDuplicate={duplicateSelection}
          landscape={layout.landscape}
        />
        {toastList}
        {finishModal}
      </EditorContext.Provider>
    );
  }

  return (
    <EditorContext.Provider value={ctx}>
      <style dangerouslySetInnerHTML={{ __html: FONT_FACE_CSS }} />
      <div className="ed-root">
        {/* ------------------------------------------------------------ top bar */}
        <header className="ed-topbar">
          <div className="flex min-w-0 items-center gap-3">
            <Link href={`/content/${item.id}`} className="ed-iconbtn" aria-label="Back to the video page" title="Back">
              <Icon name="back" />
            </Link>
            <div className="min-w-0">
              <p className="ed-eyebrow">Finishing edit</p>
              <h1 className="truncate text-[14px] font-semibold leading-tight">{item.title}</h1>
            </div>
            <span className="ed-chip" title="Length of the finished video">
              <Icon name="clock" size={13} />
              {formatTime(duration, true)}
            </span>
            {restored && (
              <span className="ed-chip ed-chip-gold">
                Unsaved changes restored
                <button type="button" className="underline decoration-dotted" onClick={discardDraft}>
                  Discard
                </button>
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            <button type="button" className="ed-iconbtn" aria-label="Undo" title="Undo (⌘Z)" disabled={!state.past.length} onClick={() => dispatch({ type: "undo" })}>
              <Icon name="undo" />
            </button>
            <button type="button" className="ed-iconbtn" aria-label="Redo" title="Redo (⇧⌘Z)" disabled={!state.future.length} onClick={() => dispatch({ type: "redo" })}>
              <Icon name="redo" />
            </button>
            <div className="relative">
              <button type="button" className="ed-iconbtn" aria-label="Keyboard shortcuts" title="Shortcuts (?)" onClick={() => setShowKeys((v) => !v)}>
                <Icon name="keyboard" />
              </button>
              {showKeys && <ShortcutSheet onClose={() => setShowKeys(false)} />}
            </div>
            <span className="mx-1.5 h-5 w-px bg-[var(--color-border)]" />
            <span className="mr-1 hidden text-[12px] text-[var(--color-text-faint)] xl:inline">
              {saving ? "Saving…" : dirty ? "Unsaved changes" : "All changes saved"}
            </span>
            <button type="button" className="btn btn-ghost !py-1.5 !text-[13px]" onClick={() => void save()} disabled={saving || !dirty} title="Save a version (⌘S)">
              {saving ? "Saving…" : "Save"}
            </button>
            <button type="button" className="btn btn-primary !py-1.5 !text-[13px]" onClick={() => setFinishOpen(true)}>
              Finish &amp; schedule
            </button>
          </div>
        </header>

        {/* ------------------------------------------------------------ workspace */}
        <div className="ed-main">
          <MediaBin />
          <Preview />
          <Inspector />
        </div>
        <TimelinePanel onSplit={split} onDelete={deleteSelection} onDuplicate={duplicateSelection} />
        {toastList}
      </div>
      {finishModal}
    </EditorContext.Provider>
  );
}

function ShortcutSheet({ onClose }: { onClose: () => void }) {
  const rows: Array<[string, string]> = [
    ["Space / K", "Play · pause"],
    ["← →", "Step one frame"],
    ["⇧ ← →", "Jump one second"],
    ["J / L", "Back / forward 1s"],
    ["S", "Split at playhead"],
    ["⌫", "Delete (closes the gap)"],
    ["⌘D", "Duplicate"],
    ["⌘Z / ⇧⌘Z", "Undo / redo"],
    ["⌘S", "Save"],
    ["Esc", "Deselect"],
    ["⌘ + scroll", "Zoom the timeline"],
  ];
  return (
    <div className="ed-popover right-0 top-10 w-[260px]" role="dialog" aria-label="Keyboard shortcuts">
      <div className="mb-2 flex items-center justify-between">
        <p className="ed-eyebrow">Shortcuts</p>
        <button type="button" className="text-[12px] text-[var(--color-text-faint)] hover:text-[var(--color-text)]" onClick={onClose}>
          Close
        </button>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-[12px]">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt>
              <kbd className="ed-kbd">{k}</kbd>
            </dt>
            <dd className="text-[var(--color-text-muted)]">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
