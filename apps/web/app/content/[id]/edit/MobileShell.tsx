"use client";

import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { locateOutputTime, timelineDuration } from "@chris/media/timeline";
import { addText, addZoom, updateText, newId } from "../../../../lib/editor/timeline-ops";
import { formatTime } from "../../../../lib/editor/preview-math";
import { sheetForSelection, spanStartForPlayhead } from "../../../../lib/editor/touch-math";
import { PLATFORM_SHORT_LABEL } from "../../../../lib/editor/platform-profiles";
import { useEditor, type SheetId } from "./context";
import { useIsPlaying, usePlayheadValue } from "./playback";
import { Canvas, PlatformSwitch, WarningsList, enterReframe, useFitCanvas } from "./Preview";
import { MobileTimeline } from "./MobileTimeline";
import { Sheet } from "./Sheet";
import { ClipPanel, TextPanel, ZoomPanel, CaptionsPanel, LookPanel, CoverPanel } from "./Inspector";
import { VisualsPanel } from "./VisualsPanel";
import { SoundPanel } from "./SoundPanel";
import { StyleCutPanel } from "./StyleCutPanel";
import { autoPlaceVisuals } from "../../../../lib/editor/visuals";
import { TakeCard } from "./MediaBin";
import { useKeyboardInset } from "./layout-hooks";
import { Icon } from "./icons";

/**
 * The touch shell (iPhone first; also phone landscape and iPad portrait): a compact top bar,
 * the 9:16 preview filling the upper area, a transport row, the centre-playhead timeline and a
 * bottom toolbar of big icon+label tools. Tools open bottom sheets holding the inspector
 * controls; selecting something swaps the toolbar for that item's quick actions (CapCut-style).
 */
export function MobileShell({
  item,
  saving,
  dirty,
  restored,
  onDiscardDraft,
  onSave,
  onFinish,
  onSplit,
  onDelete,
  onDuplicate,
  landscape,
}: {
  item: { id: string; title: string };
  saving: boolean;
  dirty: boolean;
  restored: boolean;
  onDiscardDraft: () => void;
  onSave: () => void;
  onFinish: () => void;
  onSplit: () => void;
  onDelete: () => void;
  onDuplicate: () => void;
  landscape: boolean;
}) {
  const { doc, ui, setUi, state } = useEditor();
  const [sheetH, setSheetH] = useState(0);
  const onSnapChange = useCallback((h: number) => setSheetH(h), []);
  const sheetOpen = !!ui.sheet;
  const duration = timelineDuration(doc);

  // Keep the open sheet in step with the selection (a clip sheet follows to the next clip, etc.).
  const sel = state.selection;
  useEffect(() => {
    const next = sheetForSelection(ui.sheet, sel?.kind ?? null);
    if (next !== ui.sheet) setUi({ sheet: next });
  }, [sel, ui.sheet, setUi]);

  // Stop the page itself from pinch-zooming / rubber-banding behind the editor (iOS gestures).
  useEffect(() => {
    const block = (e: Event) => e.preventDefault();
    document.addEventListener("gesturestart", block);
    document.addEventListener("gesturechange", block);
    return () => {
      document.removeEventListener("gesturestart", block);
      document.removeEventListener("gesturechange", block);
    };
  }, []);

  return (
    <div className={`ed-root ed-m ${landscape ? "ed-m-land" : ""} ${sheetOpen ? "ed-m-sheet-open" : ""}`}>
      <header className="ed-m-top">
        <Link href={`/content/${item.id}`} className="ed-m-icon" aria-label="Back to the video page">
          <Icon name="back" size={22} />
        </Link>
        <div className="ed-m-titlewrap">
          <h1>{item.title}</h1>
          <p>
            {formatTime(duration)} · {saving ? "Saving…" : dirty ? "Unsaved changes" : "All saved"}
          </p>
        </div>
        {dirty && (
          <button type="button" className="ed-m-save" onClick={onSave} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </button>
        )}
        <button type="button" className="ed-m-finish" onClick={onFinish}>
          Finish
        </button>
      </header>

      {restored && (
        <div className="ed-m-banner">
          <span>Unsaved changes from last time were restored.</span>
          <button type="button" onClick={onDiscardDraft}>
            Discard
          </button>
        </div>
      )}

      <MobileStage sheetOpen={sheetOpen && !landscape} />

      <div className="ed-m-side">
        <MobileTransport />
        <div className="ed-m-dock" style={sheetOpen && !landscape && sheetH > 0 ? { height: sheetH } : undefined}>
          <MobileTimeline />
          <MobileToolbar onSplit={onSplit} onDelete={onDelete} onDuplicate={onDuplicate} />
        </div>
      </div>

      {ui.sheet && <SheetHost key={ui.sheet} id={ui.sheet} side={landscape} onSnapChange={onSnapChange} />}
      {ui.editingTextId && <KeyboardTextBar id={ui.editingTextId} />}
    </div>
  );
}

// ---------------------------------------------------------------------------------------
// Stage + transport
// ---------------------------------------------------------------------------------------

function MobileStage({ sheetOpen }: { sheetOpen: boolean }) {
  const { doc, ui, setUi, warnings } = useEditor();
  const boxRef = useRef<HTMLDivElement>(null);
  const size = useFitCanvas(boxRef, doc.canvas.width / doc.canvas.height, 24, 12);
  return (
    <section className="ed-m-stage" aria-label="Preview">
      {!sheetOpen && (
        <div className="ed-m-stagehead">
          <PlatformSwitch compact value={ui.platformView} onChange={(v) => setUi({ platformView: v })} />
          <button
            type="button"
            className={`ed-m-chip ${warnings.length ? "ed-m-chip-warn" : "ed-m-chip-ok"}`}
            onClick={() => setUi({ sheet: "platforms" })}
            aria-label={warnings.length ? `${warnings.length} things to check` : "Fits every platform"}
          >
            <Icon name={warnings.length ? "warn" : "check"} size={14} />
            {warnings.length ? warnings.length : "Fits"}
          </button>
        </div>
      )}
      <div className="ed-m-canvasbox" ref={boxRef}>
        {size.w > 0 && <Canvas w={size.w} h={size.h} />}
        {ui.reframe && (
          <button type="button" className="ed-m-pill" onClick={() => setUi({ reframe: false })}>
            <Icon name="check" size={15} /> Done reframing
          </button>
        )}
      </div>
    </section>
  );
}

function MobileTransport() {
  const { engine, doc, state, dispatch } = useEditor();
  const playing = useIsPlaying(engine);
  const t = usePlayheadValue(engine, (x) => Math.floor(x * 10) / 10);
  const d = timelineDuration(doc);
  return (
    <div className="ed-m-transport">
      <span className="ed-m-time">
        <b>{formatTime(t, true).slice(0, -1)}</b>
        <span> / {formatTime(d, true).slice(0, -1)}</span>
      </span>
      <button
        type="button"
        className="ed-m-play"
        aria-label={playing ? "Pause" : "Play"}
        // play() must run inside the tap itself — iOS only allows sound from a user gesture
        onClick={() => engine.toggle()}
      >
        <Icon name={playing ? "pause" : "play"} size={22} />
      </button>
      <div className="ed-m-undo">
        <button type="button" className="ed-m-icon" aria-label="Undo" disabled={!state.past.length} onClick={() => dispatch({ type: "undo" })}>
          <Icon name="undo" size={21} />
        </button>
        <button type="button" className="ed-m-icon" aria-label="Redo" disabled={!state.future.length} onClick={() => dispatch({ type: "redo" })}>
          <Icon name="redo" size={21} />
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------------------------

function Tool({ icon, label, onClick, disabled, active, danger }: { icon: string; label: string; onClick: () => void; disabled?: boolean; active?: boolean; danger?: boolean }) {
  return (
    <button type="button" className={`ed-m-tool ${danger ? "ed-m-tool-danger" : ""}`} onClick={onClick} disabled={disabled} aria-pressed={active}>
      <Icon name={icon} size={22} />
      <span>{label}</span>
    </button>
  );
}

function MobileToolbar({ onSplit, onDelete, onDuplicate }: { onSplit: () => void; onDelete: () => void; onDuplicate: () => void }) {
  const { doc, ui, setUi, state, dispatch, engine, apply, toast, solvePlacements } = useEditor();
  const sel = state.selection;
  const open = (sheet: SheetId) => setUi({ sheet: ui.sheet === sheet ? null : sheet });

  let tools: ReactNode;
  let title: string | null = null;
  if (sel?.kind === "clip") {
    const clip = doc.clips.find((c) => c.id === sel.id);
    title = "Clip";
    tools = (
      <>
        <Tool icon="split" label="Split" onClick={onSplit} />
        <Tool icon="fit" label="Trim" onClick={() => open("clip")} active={ui.sheet === "clip"} />
        <Tool icon={clip?.volume === 0 ? "mute" : "volume"} label="Volume" onClick={() => open("volume")} active={ui.sheet === "volume"} />
        <Tool icon="crop" label="Reframe" active={ui.reframe} onClick={() => {
            if (!clip) return;
            setUi({ sheet: null });
            enterReframe(engine, doc, clip.id, ui.reframe, setUi);
          }}
        />
        <Tool icon="duplicate" label="Duplicate" onClick={onDuplicate} />
        <Tool icon="trash" label="Delete" danger disabled={doc.clips.length <= 1} onClick={onDelete} />
      </>
    );
  } else if (sel?.kind === "text") {
    title = "Text";
    tools = (
      <>
        <Tool icon="text" label="Edit text" onClick={() => setUi({ editingTextId: sel.id })} />
        <Tool icon="palette" label="Style" onClick={() => open("text")} active={ui.sheet === "text"} />
        <Tool icon="duplicate" label="Duplicate" onClick={onDuplicate} />
        <Tool icon="trash" label="Delete" danger onClick={onDelete} />
      </>
    );
  } else if (sel?.kind === "zoom") {
    title = "Zoom";
    tools = (
      <>
        <Tool icon="sparkle" label="Adjust" onClick={() => open("zoom")} active={ui.sheet === "zoom"} />
        <Tool icon="target" label="Aim" onClick={() => toast("Tap the video where the zoom should push in.")} />
        <Tool icon="trash" label="Delete" danger onClick={onDelete} />
      </>
    );
  } else if (sel?.kind === "visual") {
    const v = doc.visuals.find((x) => x.id === sel.id);
    title = "Graphic";
    tools = (
      <>
        <Tool icon="palette" label="Edit" onClick={() => open("visuals")} active={ui.sheet === "visuals"} />
        <Tool
          icon="target"
          label="Auto-place"
          disabled={v?.placement.mode === "AUTO"}
          onClick={() => {
            apply((d) => autoPlaceVisuals(d, [sel.id], solvePlacements));
            toast("Placed automatically — clear of your face and the captions.");
          }}
        />
        <Tool icon="duplicate" label="Duplicate" onClick={onDuplicate} />
        <Tool icon="trash" label="Delete" danger onClick={onDelete} />
      </>
    );
  } else if (sel?.kind === "sfx") {
    title = "Sound effect";
    tools = (
      <>
        <Tool icon="volume" label="Edit" onClick={() => open("sound")} active={ui.sheet === "sound"} />
        <Tool icon="trash" label="Delete" danger onClick={onDelete} />
      </>
    );
  } else if (sel?.kind === "captions") {
    title = "Captions";
    tools = (
      <>
        <Tool icon="palette" label="Style" onClick={() => open("captions")} active={ui.sheet === "captions"} />
        <Tool icon="text" label="Fix words" onClick={() => open("captions")} />
      </>
    );
  } else {
    tools = (
      <>
        <Tool icon="sparkle" label="Style cut" onClick={() => open("style")} active={ui.sheet === "style"} />
        <Tool icon="split" label="Split" onClick={onSplit} />
        <Tool
          icon="film"
          label="Edit"
          onClick={() => {
            const loc = locateOutputTime(doc, engine.time);
            const clip = loc ? doc.clips[loc.clipIndex] : doc.clips[0];
            if (clip) dispatch({ type: "select", selection: { kind: "clip", id: clip.id } });
          }}
        />
        <Tool
          icon="text"
          label="Text"
          onClick={() => {
            const id = newId("text");
            const at = spanStartForPlayhead(engine.time, timelineDuration(doc));
            engine.pause();
            apply((d) => addText(d, at, { text: "Your text" }, id).doc, { select: { kind: "text", id } });
            engine.seek(at);
            setUi({ editingTextId: id, sheet: null });
          }}
        />
        <Tool icon="captions" label="Captions" onClick={() => {
            dispatch({ type: "select", selection: { kind: "captions" } });
            setUi({ sheet: "captions" });
          }}
        />
        <Tool
          icon="zoom"
          label="Zoom"
          onClick={() => {
            const id = newId("zoom");
            const at = spanStartForPlayhead(engine.time, timelineDuration(doc));
            engine.pause();
            apply((d) => addZoom(d, at, id).doc, { select: { kind: "zoom", id } });
            engine.seek(at);
            toast("Zoom added — tap the video where it should push in.");
          }}
        />
        <Tool icon="magic" label="Visuals" onClick={() => open("visuals")} active={ui.sheet === "visuals"} />
        <Tool icon="music" label="Sound" onClick={() => open("sound")} active={ui.sheet === "sound"} />
        <Tool icon="palette" label="Look" onClick={() => open("look")} active={ui.sheet === "look"} />
        <Tool icon="plus" label="Add clip" onClick={() => open("media")} active={ui.sheet === "media"} />
        <Tool icon="image" label="Cover" onClick={() => open("cover")} active={ui.sheet === "cover"} />
        <Tool icon="phone" label="Platforms" onClick={() => open("platforms")} active={ui.sheet === "platforms"} />
      </>
    );
  }

  return (
    <nav className="ed-m-toolbar" aria-label={title ? `${title} tools` : "Tools"}>
      {title && (
        <button type="button" className="ed-m-toolback" onClick={() => {
            dispatch({ type: "select", selection: null });
            setUi({ sheet: null, reframe: false });
          }} aria-label="Done with this selection">
          <Icon name="back" size={20} />
          <span>{title}</span>
        </button>
      )}
      <div className="ed-m-tools">{tools}</div>
    </nav>
  );
}

// ---------------------------------------------------------------------------------------
// Sheets
// ---------------------------------------------------------------------------------------

const SHEET_TITLES: Record<SheetId, string> = {
  clip: "Clip",
  volume: "Volume",
  text: "Text style",
  zoom: "Zoom",
  captions: "Captions",
  look: "Look",
  media: "Add a clip",
  cover: "Cover",
  platforms: "Platforms",
  visuals: "Visuals",
  sound: "Sound",
  style: "Style cut",
};

function SheetHost({ id, side, onSnapChange }: { id: SheetId; side: boolean; onSnapChange: (h: number) => void }) {
  const { setUi, state, doc, assets, ui } = useEditor();
  const sel = state.selection;
  const close = useCallback(() => setUi({ sheet: null }), [setUi]);
  let body: ReactNode = null;
  if (id === "clip" || id === "volume") {
    const clip = sel?.kind === "clip" ? doc.clips.find((c) => c.id === sel.id) : undefined;
    body = clip ? <ClipPanel clip={clip} only={id === "volume" ? "sound" : undefined} /> : <EmptyNote>Tap a clip on the timeline first.</EmptyNote>;
  } else if (id === "text") {
    const t = sel?.kind === "text" ? doc.texts.find((x) => x.id === sel.id) : undefined;
    body = t ? <TextPanel t={t} /> : <EmptyNote>Tap a text on the video or the timeline first.</EmptyNote>;
  } else if (id === "zoom") {
    const z = sel?.kind === "zoom" ? doc.zooms.find((x) => x.id === sel.id) : undefined;
    body = z ? <ZoomPanel z={z} /> : <EmptyNote>Tap a zoom on the timeline first.</EmptyNote>;
  } else if (id === "captions") body = <CaptionsPanel />;
  else if (id === "look") body = <LookPanel />;
  else if (id === "visuals") body = <VisualsPanel />;
  else if (id === "sound") body = <SoundPanel />;
  else if (id === "style") body = <StyleCutPanel />;
  else if (id === "cover") body = <CoverPanel />;
  else if (id === "media") {
    const used = new Set(doc.clips.map((c) => c.mediaAssetId));
    body = (
      <div className="ed-m-takes">
        {assets.length === 0 && <EmptyNote>No raw takes uploaded for this video.</EmptyNote>}
        {assets.map((a, i) => (
          <TakeCard key={a.id} asset={a} index={i} inUse={used.has(a.id)} />
        ))}
        <p className="ed-m-hint">Press and slide across a take to preview it. “Add at playhead” drops it where the white line is.</p>
      </div>
    );
  } else if (id === "platforms") {
    body = (
      <div className="ed-section">
        <p className="ed-label">Preview with each app&apos;s buttons</p>
        <PlatformSwitch value={ui.platformView} onChange={(v) => setUi({ platformView: v })} />
        <p className="ed-eyebrow mb-2 mt-5">{ui.platformView === "ALL" ? "Things to check (all apps)" : `Things to check on ${PLATFORM_SHORT_LABEL[ui.platformView]}`}</p>
        <WarningsList onPicked={close} />
      </div>
    );
  }
  return (
    <Sheet title={SHEET_TITLES[id]} label={SHEET_TITLES[id]} onClose={close} side={side} onSnapChange={onSnapChange} initial={id === "media" ? "full" : "half"}>
      {body}
    </Sheet>
  );
}

function EmptyNote({ children }: { children: ReactNode }) {
  return <p className="px-5 py-8 text-center text-[14px] text-[var(--color-text-faint)]">{children}</p>;
}

// ---------------------------------------------------------------------------------------
// Keyboard text bar
// ---------------------------------------------------------------------------------------

/**
 * Typing into a text element on a phone: a field docked right above the iOS keyboard (via
 * visualViewport — iOS overlays the keyboard instead of resizing the page), editing the
 * element live on the preview. 16px font so iOS doesn't zoom the page on focus.
 */
function KeyboardTextBar({ id }: { id: string }) {
  const { doc, apply, commit, setUi } = useEditor();
  const t = doc.texts.find((x) => x.id === id);
  const ref = useRef<HTMLTextAreaElement>(null);
  const [value, setValue] = useState(t?.text ?? "");
  const inset = useKeyboardInset(true);
  const fresh = useRef(t?.text === "Your text");

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    if (fresh.current) el.select();
    else el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  useEffect(() => {
    if (!t) setUi({ editingTextId: null });
  }, [t, setUi]);

  const done = () => {
    commit();
    setUi({ editingTextId: null });
  };

  return (
    <div className="ed-kbar" style={{ transform: `translate3d(0, ${-inset}px, 0)` }} onPointerDown={(e) => e.stopPropagation()}>
      <textarea
        ref={ref}
        className="ed-kbar-input"
        value={value}
        rows={1}
        maxLength={500}
        enterKeyHint="done"
        autoCapitalize="sentences"
        aria-label="Text"
        onChange={(e) => {
          const v = e.target.value;
          setValue(v);
          if (v.trim()) apply((d) => updateText(d, id, { text: v.replace(/\n+$/, "") }), { coalesce: `type:${id}` });
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            done();
          }
        }}
        onBlur={done}
      />
      <button type="button" className="ed-kbar-done" onPointerDown={(e) => e.preventDefault()} onClick={done}>
        Done
      </button>
    </div>
  );
}
