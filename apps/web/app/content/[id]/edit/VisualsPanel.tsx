"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  MOTION_TEMPLATES,
  SFX_SOUNDS,
  VISUAL_TRANSITIONS,
  timelineCaptionWords,
  timelineDuration,
  type MotionTemplate,
  type PlacementWarning,
  type TimelineVisual,
} from "@chris/media/timeline";
import {
  TEMPLATE_BLURB,
  TEMPLATE_FIELDS,
  TEMPLATE_LABEL,
  SFX_LABEL,
  addVisual,
  autoPlaceVisuals,
  defaultVisualProps,
  deleteVisual,
  phraseAt,
  placeVisualManually,
  plainRejection,
  trimVisualSpan,
  updateVisual,
  updateVisualProps,
  visualPropsProblem,
  visualSummary,
  type FieldSpec,
} from "../../../../lib/editor/visuals";
import { newId } from "../../../../lib/editor/timeline-ops";
import { formatTime } from "../../../../lib/editor/preview-math";
import { useEditor } from "./context";
import { designVisualsAction, designVisualsResultAction, type DesignVisualsStepResult } from "./actions";
import { waitForJob } from "../../../../lib/use-job-progress";
import { NumField, Section, Seg, Slider, Toggle } from "./Inspector";
import { TemplateArt } from "./template-art";
import { InShotSection, ThemePicker } from "./InteractionControls";
import { GraphicLibrary } from "./GraphicLibrary";
import { GraphicEditor } from "./GraphicEditor";
import { Icon } from "./icons";

/**
 * Motion graphics in the editor. One panel, two faces:
 * - nothing selected: "Design visuals with AI" + the template gallery + what's on the timeline;
 * - a graphic selected: its typed props editor (generated from lib/editor/visuals.ts's per-
 *   template field spec), look, entrance sound, placement and timing.
 * Used as the touch shell's Visuals sheet and as the desktop inspector's Visuals tab / selection.
 */
export function VisualsPanel() {
  const { state, doc } = useEditor();
  const sel = state.selection;
  const v = sel?.kind === "visual" ? doc.visuals.find((x) => x.id === sel.id) : undefined;
  if (v) return <VisualEditor key={v.id} v={v} />;
  return <VisualsHome />;
}

// ---------------------------------------------------------------------------------------
// Home: AI + gallery + list
// ---------------------------------------------------------------------------------------

export function VisualsHome() {
  const { doc, focus, placement } = useEditor();
  const warnIds = new Set(placement.warnings.filter((w) => w.severity === "WARNING").map((w) => w.visualId));
  const list = [...doc.visuals].sort((a, b) => a.start - b.start);
  return (
    <>
      <AiDesignCard />
      {list.length > 0 && (
        <Section title={`On the timeline (${list.length})`}>
          <ul className="flex flex-col gap-1">
            {list.map((v) => (
              <li key={v.id}>
                <button type="button" className="ed-card ed-vis-row" onClick={() => focus({ kind: "visual", id: v.id })}>
                  <span className="ed-vis-row-art">
                    <TemplateArt template={v.template} size={28} />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-left">{visualSummary(v)}</span>
                  {warnIds.has(v.id) && (
                    <span className="text-[var(--color-gold-400)]" aria-label="Placement warning">
                      <Icon name="warn" size={13} />
                    </span>
                  )}
                  <span className="shrink-0 text-[11px] tabular-nums text-[var(--color-text-faint)]">
                    {formatTime(v.start, true).slice(0, -1)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Section>
      )}
      <ThemePicker />
      <Section title="Add a graphic">
        <GraphicLibrary />
      </Section>
    </>
  );
}

type DesignState =
  | { phase: "idle" }
  | { phase: "running"; step: string; startedAt: number }
  | { phase: "done"; result: DesignVisualsStepResult }
  | { phase: "error"; message: string };

function AiDesignCard() {
  const { itemId, dirty, save, loadSavedVersion, doc, toast } = useEditor();
  const [st, setSt] = useState<DesignState>({ phase: "idle" });
  const [replace, setReplace] = useState(false);
  const [now, setNow] = useState(0);
  const running = st.phase === "running";
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [running]);

  const run = async () => {
    if (running) return;
    const startedAt = Date.now();
    setNow(startedAt);
    if (dirty) {
      setSt({ phase: "running", step: "Saving your edit first…", startedAt });
      const ok = await save();
      if (!ok) {
        setSt({ phase: "error", message: "Your edit couldn't be saved, so the AI didn't run. Fix what the message says and try again." });
        return;
      }
    }
    setSt({ phase: "running", step: "Reading the script and research, finding Chris in the frame, designing…", startedAt });
    try {
      let res = await designVisualsAction({ contentItemId: itemId, replaceExisting: replace });
      if (res.ok && "pending" in res) {
        // Live site: it runs in the cloud worker — follow its progress, then load the result.
        const jobRunId = res.jobRunId;
        const done = await waitForJob(jobRunId, (v) => v.status === "RUNNING" && setSt({ phase: "running", step: v.line ?? "Designing…", startedAt }));
        res = done.status === "SUCCEEDED" || done.status === "FAILED" ? await designVisualsResultAction(itemId, jobRunId) : { ok: false, error: "Designing didn't finish — try again." };
      }
      if (!res.ok) {
        setSt({ phase: "error", message: res.error });
        return;
      }
      loadSavedVersion(res.timeline, res.state);
      setSt({ phase: "done", result: res });
      toast(res.added.length ? `Added ${res.added.length} graphic${res.added.length === 1 ? "" : "s"} — saved as a new version.` : "The AI didn't add any graphics this time.");
    } catch {
      setSt({ phase: "error", message: "Couldn't reach the server. Your edit is unchanged — try again." });
    }
  };

  const elapsed = st.phase === "running" ? Math.max(0, Math.round((now - st.startedAt) / 1000)) : 0;
  return (
    <div className="ed-section">
      <div className="ed-ai-card">
        <div className="flex items-start gap-3">
          <span className="ed-ai-icon">
            <Icon name="magic" size={20} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[14px] font-semibold leading-tight">Design visuals with AI</p>
            <p className="mt-1 text-[12px] leading-relaxed text-[var(--color-text-muted)]">
              Charts, numbers and callouts timed to what you say — only numbers from your fact-checked research. Placed around your face and captions.
            </p>
          </div>
        </div>
        {doc.visuals.length > 0 && <Toggle label="Replace the graphics already here" checked={replace} onChange={setReplace} />}
        <button type="button" className="btn btn-primary ed-ai-btn" onClick={() => void run()} disabled={running}>
          {running ? (
            <>
              <span className="ed-spinner" aria-hidden /> Designing… {elapsed > 2 ? `${elapsed}s` : ""}
            </>
          ) : (
            <>
              <Icon name="magic" size={16} /> {doc.visuals.length ? "Design more visuals with AI" : "Design visuals with AI"}
            </>
          )}
        </button>
        {st.phase === "running" && <p className="text-[12px] text-[var(--color-text-muted)]" aria-live="polite">{st.step}</p>}
        {st.phase === "error" && (
          <p className="ed-ai-error" role="alert">
            <Icon name="warn" size={14} /> <span>{st.message}</span>
          </p>
        )}
        {st.phase === "done" && <DesignResult r={st.result} />}
      </div>
    </div>
  );
}

function DesignResult({ r }: { r: DesignVisualsStepResult }) {
  const { focus, doc } = useEditor();
  const byId = new Map(doc.visuals.map((v) => [v.id, v]));
  const placementNotes = dedupe(r.placementWarnings.filter((w) => w.severity === "WARNING").map((w) => placementSentence(w, byId.get(w.visualId))));
  return (
    <div className="flex flex-col gap-2.5 text-[12.5px]" aria-live="polite">
      <p className="font-medium text-[var(--color-emerald-400)]">
        <Icon name="check" size={13} className="mr-1 inline" />
        Added {r.added.length} graphic{r.added.length === 1 ? "" : "s"}
        {r.rejected.length ? ` · held back ${r.rejected.length}` : ""}
      </p>
      {r.added.length > 0 && (
        <ul className="flex flex-col gap-1">
          {r.added.map((a) => {
            const v = byId.get(a.id);
            return (
              <li key={a.id}>
                <button type="button" className="ed-ai-added" onClick={() => v && focus({ kind: "visual", id: a.id })} disabled={!v}>
                  <b>{v ? visualSummary(v) : a.template}</b>
                  <span>
                    {a.start.toFixed(1)}s{a.anchorText ? ` · “${a.anchorText}”` : ""}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {r.rejected.length > 0 && (
        <ul className="ed-ai-notes">
          {r.rejected.map((x, i) => (
            <li key={i}>{plainRejection(x)}</li>
          ))}
        </ul>
      )}
      {placementNotes.length > 0 && (
        <ul className="ed-ai-notes ed-ai-notes-warn">
          {placementNotes.map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
      )}
      {r.rationale && <p className="text-[11.5px] leading-relaxed text-[var(--color-text-faint)]">{r.rationale}</p>}
    </div>
  );
}

function dedupe(xs: string[]): string[] {
  return [...new Set(xs)];
}

/** "Bar chart 2.1–4.0s covers Chris's face — …" (engine wording, editor names). */
function placementSentence(w: PlacementWarning, v: TimelineVisual | undefined): string {
  const rest = w.message.replace(/^[a-z0-9 ]+ at \d+(\.\d+)?s:?\s*/i, "");
  return v ? `${TEMPLATE_LABEL[v.template]} ${v.start.toFixed(1)}–${v.end.toFixed(1)}s ${rest}` : w.message;
}

export function TemplateGallery() {
  const { doc, engine, apply, toast, wordsByAsset, setUi, touch } = useEditor();
  const words = useMemo(() => timelineCaptionWords(doc, wordsByAsset), [doc, wordsByAsset]);
  const insert = (template: MotionTemplate) => {
    const t = engine.time;
    const phrase = phraseAt(words, t);
    const id = newId("vis");
    const props = defaultVisualProps(template, phrase);
    const probe = addVisual(doc, template, t, props, id, phrase || null);
    if (!probe.id) {
      toast("No room for another graphic here — graphics can't overlap. Shorten or delete one first.", "warn");
      return;
    }
    engine.pause();
    apply((d) => addVisual(d, template, t, props, id, phrase || null).doc, { select: { kind: "visual", id } });
    const added = probe.doc.visuals.find((v) => v.id === id)!;
    // Land the playhead where the graphic has finished its entrance, so it's on screen.
    engine.seek(Math.min(added.end - 0.05, added.start + 0.9));
    if (touch) setUi({ sheet: "visuals" });
    toast(`${TEMPLATE_LABEL[template]} added at ${added.start.toFixed(1)}s.`);
  };
  return (
    <div className="ed-tgrid">
      {MOTION_TEMPLATES.map((t) => (
        <button key={t} type="button" className="ed-tcard" onClick={() => insert(t)} aria-label={`Add ${TEMPLATE_LABEL[t]} at the playhead`}>
          <span className="ed-tcard-art">
            <TemplateArt template={t} />
          </span>
          <span className="ed-tcard-name">{TEMPLATE_LABEL[t]}</span>
          <span className="ed-tcard-blurb">{TEMPLATE_BLURB[t]}</span>
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------------------
// Selected graphic
// ---------------------------------------------------------------------------------------

const TRANSITION_LABEL: Record<(typeof VISUAL_TRANSITIONS)[number], string> = {
  AUTO: "Auto",
  FADE: "Fade",
  SCALE: "Scale",
  SLIDE: "Slide",
  BLUR: "Blur",
  SPRING: "Spring",
};

export function VisualEditor({ v }: { v: TimelineVisual }) {
  const { apply, doc, dispatch, warnings, solvePlacements, audio, placement, touch, setUi } = useEditor();
  // A newly selected graphic opens at the top of its editor (the sheet/inspector may have been
  // scrolled down the gallery).
  const topRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    topRef.current?.closest(".ed-sheet-body, .ed-scroll")?.scrollTo({ top: 0 });
  }, []);
  const D = timelineDuration(doc);
  const [numbersTouched, setNumbersTouched] = useState(false);
  const problem = visualPropsProblem(v);
  const mine = warnings.filter((w) => w.target?.kind === "visual" && w.target.id === v.id && !w.id.startsWith("visual:props:"));
  const shown = placement.visuals.find((x) => x.id === v.id) ?? v;
  const set = (patch: Partial<Omit<TimelineVisual, "id">>, key?: string) => apply((d) => updateVisual(d, v.id, patch), key ? { coalesce: `${key}:${v.id}` } : undefined);
  const setProps = (props: Record<string, unknown>, key: string, touchedNumber: boolean) => {
    if (touchedNumber) setNumbersTouched(true);
    apply((d) => updateVisualProps(d, v.id, props), { coalesce: `vprop:${v.id}:${key}` });
  };
  return (
    <>
      <div className="ed-section" ref={topRef}>
        <div className="flex items-center gap-3">
          <span className="ed-vis-row-art">
            <TemplateArt template={v.template} size={34} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[14px] font-semibold">{v.template === "GRAPHIC" ? visualSummary(v).split(" · ")[0] : TEMPLATE_LABEL[v.template]}</p>
            <p className="text-[11.5px] tabular-nums text-[var(--color-text-faint)]">
              {v.start.toFixed(1)}–{v.end.toFixed(1)}s · {(v.end - v.start).toFixed(1)}s on screen
            </p>
          </div>
          {!touch && (
            <button type="button" className="ed-toolbtn" onClick={() => dispatch({ type: "select", selection: null })} title="Back to the gallery">
              All graphics
            </button>
          )}
        </div>
        {v.anchorText && <p className="ed-vis-anchor">“{v.anchorText}”</p>}
        {problem && (
          <p className="ed-ai-error mt-3" role="alert">
            <Icon name="warn" size={14} /> <span>This graphic won&apos;t render until it&apos;s fixed: {problem}</span>
          </p>
        )}
        {mine.map((w) => (
          <p key={w.id} className="ed-vis-warn">
            <Icon name="warn" size={13} /> <span>{w.message}</span>
          </p>
        ))}
      </div>

      {v.template === "GRAPHIC" ? (
        <>
          <GraphicEditor v={v} onNumbersTouched={() => setNumbersTouched(true)} />
          {numbersTouched && (
            <div className="ed-section">
              <p className="ed-factual-note">
                <Icon name="target" size={13} /> Numbers on screen aren&apos;t fact-checked until you run Finish (the quality gate checks on-screen numbers, totals included).
              </p>
            </div>
          )}
        </>
      ) : (
        <Section title="Content">
          <PropsForm fields={TEMPLATE_FIELDS[v.template]} value={v.props as Record<string, unknown>} onChange={setProps} />
          {numbersTouched && (
            <p className="ed-factual-note">
              <Icon name="target" size={13} /> Numbers on screen aren&apos;t fact-checked until you run Finish (the quality gate checks on-screen numbers).
            </p>
          )}
        </Section>
      )}

      <Section title="Look">
        <div>
          <span className="ed-label">Colors</span>
          <Seg
            label="Palette"
            value={v.palette}
            options={[
              ["BRAND", "Brand"],
              ["MONO", "Mono"],
              ["VIVID", "Vivid"],
            ]}
            onChange={(palette) => set({ palette })}
          />
        </div>
        <ChipPick label="Comes in" value={v.enter} options={VISUAL_TRANSITIONS.map((t) => [t, TRANSITION_LABEL[t]])} onChange={(enter) => set({ enter })} />
        <ChipPick label="Goes out" value={v.exit} options={VISUAL_TRANSITIONS.map((t) => [t, TRANSITION_LABEL[t]])} onChange={(exit) => set({ exit })} />
        <div>
          <span className="ed-label">Entrance sound</span>
          <div className="ed-chips">
            <button type="button" className="ed-chip-btn" aria-pressed={v.enterSfx === null} onClick={() => set({ enterSfx: null })}>
              None
            </button>
            {SFX_SOUNDS.map((s) => (
              <button
                key={s}
                type="button"
                className="ed-chip-btn"
                aria-pressed={v.enterSfx === s}
                onClick={() => {
                  set({ enterSfx: s });
                  void audio.audition(s);
                }}
              >
                <Icon name="volume" size={12} /> {SFX_LABEL[s]}
              </button>
            ))}
          </div>
          {!doc.audio.sfxEnabled && (
            <p className="mt-1.5 text-[11px] text-[var(--color-text-faint)]">
              Sound effects are off for this video.{" "}
              <button type="button" className="underline" onClick={() => setUi(touch ? { sheet: "sound" } : { tab: "sound" })}>
                Sound settings
              </button>
            </p>
          )}
        </div>
      </Section>

      <Section
        title="Position"
        right={
          <span className={`ed-pill ${v.placement.mode === "AUTO" ? "ed-pill-ok" : ""}`}>{v.placement.mode === "AUTO" ? "Auto" : "Placed by you"}</span>
        }
      >
        <p className="text-[12px] leading-relaxed text-[var(--color-text-muted)]">
          {v.placement.mode === "AUTO"
            ? "Auto keeps it clear of your face, the captions and each app's buttons — it moves if you re-edit around it."
            : touch
              ? "You placed it — it stays exactly there. Drag it on the video, pinch to resize."
              : "You placed it — it stays exactly there. Drag it on the video, or drag its corner to resize."}
        </p>
        <Slider
          label="Size"
          value={shown.placement.scale}
          min={0.3}
          max={2.5}
          format={(x) => `${Math.round(x * 100)}%`}
          resetTo={1}
          onChange={(scale) => apply((d) => placeVisualManually(d, v.id, { x: shown.placement.x, y: shown.placement.y, scale }), { coalesce: `vscale:${v.id}` })}
        />
        <button
          type="button"
          className="btn btn-ghost !py-2 !text-[13px]"
          disabled={v.placement.mode === "AUTO"}
          onClick={() => apply((d) => autoPlaceVisuals(d, [v.id], solvePlacements))}
        >
          <Icon name="target" size={14} /> Auto-place
        </button>
      </Section>

      <InShotSection v={v} />

      <Section title="Timing">
        <div className="grid grid-cols-2 gap-2">
          <NumField label="Shows at" value={v.start} min={0} max={v.end - 0.5} onChange={(x) => apply((d) => trimVisualSpan(d, v.id, "start", x))} />
          <NumField label="Hides at" value={v.end} min={v.start + 0.5} max={D} onChange={(x) => apply((d) => trimVisualSpan(d, v.id, "end", x))} />
        </div>
        <button type="button" className="ed-toolbtn self-start !text-[var(--color-rose-400)]" onClick={() => apply((d) => deleteVisual(d, v.id), { select: null })}>
          <Icon name="trash" size={14} /> Remove graphic
        </button>
      </Section>
    </>
  );
}

function ChipPick<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: Array<[T, string]>; onChange: (v: T) => void }) {
  return (
    <div>
      <span className="ed-label">{label}</span>
      <div className="ed-chips" role="group" aria-label={label}>
        {options.map(([o, l]) => (
          <button key={o} type="button" className="ed-chip-btn" aria-pressed={value === o} onClick={() => onChange(o)}>
            {l}
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------
// Typed props form (one generator for all 14 templates)
// ---------------------------------------------------------------------------------------

type OnChange = (props: Record<string, unknown>, key: string, touchedNumber: boolean) => void;

const hasDigit = (s: string) => /\d/.test(s);

function PropsForm({ fields, value, onChange }: { fields: FieldSpec[]; value: Record<string, unknown>; onChange: OnChange }) {
  return (
    <>
      {fields.map((f) => (
        <Field key={f.key} spec={f} value={value[f.key]} all={value} onChange={(x, touchedNumber) => onChange({ ...value, [f.key]: x }, f.key, touchedNumber)} />
      ))}
    </>
  );
}

function Field({ spec, value, all, onChange }: { spec: FieldSpec; value: unknown; all: Record<string, unknown>; onChange: (v: unknown, touchedNumber: boolean) => void }) {
  switch (spec.kind) {
    case "text":
      return <TextField spec={spec} value={value as string | null} onChange={onChange} />;
    case "number":
      return <NumberField label={spec.label} value={typeof value === "number" ? value : 0} min={spec.min} max={spec.max} onChange={(n) => onChange(n, spec.key !== "from")} />;
    case "enum":
      return spec.options.length <= 3 ? (
        <div>
          <span className="ed-label">{spec.label}</span>
          <Seg label={spec.label} value={String(value)} options={spec.options.map(([o, l]) => [String(o), l])} onChange={(x) => onChange(typeof spec.options[0]![0] === "number" ? Number(x) : x, false)} />
        </div>
      ) : (
        <ChipPick label={spec.label} value={String(value)} options={spec.options.map(([o, l]) => [String(o), l] as [string, string])} onChange={(x) => onChange(typeof spec.options[0]![0] === "number" ? Number(x) : x, false)} />
      );
    case "bool":
      return <Toggle label={spec.label} checked={value === true} onChange={(x) => onChange(x, false)} />;
    case "tags":
      return <TagsField spec={spec} value={Array.isArray(value) ? (value as string[]) : []} text={typeof all.text === "string" ? all.text : ""} onChange={(x) => onChange(x, false)} />;
    case "stringList":
      return <StringListField spec={spec} value={Array.isArray(value) ? (value as string[]) : []} onChange={onChange} />;
    case "objectList":
      return <ObjectListField spec={spec} value={Array.isArray(value) ? (value as Array<Record<string, unknown>>) : []} onChange={onChange} />;
    case "object": {
      const obj = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
      return (
        <fieldset className="ed-fieldset">
          <legend className="ed-label">{spec.label}</legend>
          <div className="grid grid-cols-[1fr_7.5rem] gap-2">
            {spec.fields.map((f) => (
              <Field key={f.key} spec={f} value={obj[f.key]} all={obj} onChange={(x, n) => onChange({ ...obj, [f.key]: x }, n)} />
            ))}
          </div>
        </fieldset>
      );
    }
    case "point": {
      const pt = (value && typeof value === "object" ? value : { x: 0.5, y: 0.5 }) as { x: number; y: number };
      return (
        <div className="flex flex-col gap-2">
          <span className="ed-label !mb-0">{spec.label}</span>
          <Slider label="Left ↔ right" value={pt.x} min={0} max={1} format={(x) => `${Math.round(x * 100)}%`} onChange={(x) => onChange({ ...pt, x: Math.round(x * 1000) / 1000 }, false)} />
          <Slider label="Up ↕ down" value={pt.y} min={0} max={1} format={(x) => `${Math.round(x * 100)}%`} onChange={(y) => onChange({ ...pt, y: Math.round(y * 1000) / 1000 }, false)} />
        </div>
      );
    }
    case "custom":
      return null;
    case "index": {
      const items = Array.isArray(all[spec.of]) ? (all[spec.of] as Array<Record<string, unknown>>) : [];
      const options: Array<[string, string]> = [["none", "None"], ...items.map((it, i) => [String(i), String(it[spec.itemKey] ?? `#${i + 1}`)] as [string, string])];
      return <ChipPick label={spec.label} value={value == null ? "none" : String(value)} options={options} onChange={(x) => onChange(x === "none" ? null : Number(x), false)} />;
    }
  }
}

function TextField({ spec, value, onChange }: { spec: Extract<FieldSpec, { kind: "text" }>; value: string | null; onChange: (v: unknown, touchedNumber: boolean) => void }) {
  const v = value ?? "";
  const handle = (s: string) => {
    const next = s.slice(0, spec.max);
    onChange(spec.nullable && next.trim() === "" ? null : next, hasDigit(next) || hasDigit(v));
  };
  const common = {
    className: "ed-input",
    value: v,
    maxLength: spec.max,
    placeholder: spec.placeholder,
    "aria-label": spec.label,
  };
  return (
    <label className="block">
      <span className="ed-label">
        <span className="flex justify-between gap-2">
          <span>{spec.label}</span>
          <span className="tabular-nums text-[var(--color-text-faint)]">
            {v.length}/{spec.max}
          </span>
        </span>
      </span>
      {spec.multiline ? (
        <textarea {...common} rows={2} onChange={(e) => handle(e.target.value.replace(/\n/g, " "))} />
      ) : (
        <input {...common} onChange={(e) => handle(e.target.value)} enterKeyHint="done" />
      )}
    </label>
  );
}

/** A number input that lets you type freely ("1,800", "24.5k") and commits on blur/Enter. */
export function NumberField({ label, value, onChange, min, max, compact }: { label: string; value: number; onChange: (v: number) => void; min?: number; max?: number; compact?: boolean }) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? String(value);
  const commit = () => {
    if (draft === null) return;
    const m = /^\s*\$?\s*(-?[\d,]*\.?\d+)\s*([kKmM])?\s*%?\s*$/.exec(draft);
    setDraft(null);
    if (!m) return;
    let n = Number(m[1]!.replace(/,/g, ""));
    if (m[2]) n *= /k/i.test(m[2]) ? 1e3 : 1e6;
    if (!Number.isFinite(n)) return;
    onChange(Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n)));
  };
  return (
    <label className="block">
      {!compact && <span className="ed-label">{label}</span>}
      <input
        className="ed-input tabular-nums"
        inputMode="decimal"
        value={shown}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        aria-label={label}
      />
    </label>
  );
}

function TagsField({ spec, value, text, onChange }: { spec: Extract<FieldSpec, { kind: "tags" }>; value: string[]; text: string; onChange: (v: string[]) => void }) {
  // Tap the words of the text itself to make them hit harder (CapCut-style word emphasis).
  const words = [...new Set(text.split(/\s+/).map((w) => w.replace(/^[^\p{L}\p{N}$]+|[^\p{L}\p{N}%]+$/gu, "")).filter((w) => w.length > 0 && w.length <= spec.itemMax))];
  const lower = new Set(value.map((x) => x.toLowerCase()));
  return (
    <div>
      <span className="ed-label">
        {spec.label} <span className="text-[var(--color-text-faint)]">(up to {spec.maxItems})</span>
      </span>
      <div className="ed-chips">
        {words.map((w) => {
          const on = lower.has(w.toLowerCase());
          return (
            <button
              key={w}
              type="button"
              className="ed-chip-btn"
              aria-pressed={on}
              disabled={!on && value.length >= spec.maxItems}
              onClick={() => onChange(on ? value.filter((x) => x.toLowerCase() !== w.toLowerCase()) : [...value, w])}
            >
              {w}
            </button>
          );
        })}
        {words.length === 0 && <span className="text-[12px] text-[var(--color-text-faint)]">Type the text first.</span>}
      </div>
    </div>
  );
}

function ListHead({ label, count, max, onAdd, addLabel }: { label: string; count: number; max: number; onAdd: () => void; addLabel: string }) {
  return (
    <div className="mb-1.5 flex items-center justify-between">
      <span className="ed-label !mb-0">
        {label} <span className="text-[var(--color-text-faint)]">({count}/{max})</span>
      </span>
      <button type="button" className="ed-toolbtn !text-[12px]" onClick={onAdd} disabled={count >= max}>
        <Icon name="plus" size={13} /> {addLabel}
      </button>
    </div>
  );
}

function RemoveBtn({ onClick, disabled, label }: { onClick: () => void; disabled: boolean; label: string }) {
  return (
    <button type="button" className="ed-row-remove" onClick={onClick} disabled={disabled} aria-label={label} title={disabled ? "Needs at least this many" : label}>
      <Icon name="close" size={14} />
    </button>
  );
}

function StringListField({ spec, value, onChange }: { spec: Extract<FieldSpec, { kind: "stringList" }>; value: string[]; onChange: (v: unknown, touchedNumber: boolean) => void }) {
  return (
    <div>
      <ListHead label={spec.label} count={value.length} max={spec.maxItems} addLabel={`Add ${spec.itemLabel.toLowerCase()}`} onAdd={() => onChange([...value, `${spec.itemLabel} ${value.length + 1}`], false)} />
      <div className="flex flex-col gap-1.5">
        {value.map((item, i) => (
          <div key={i} className="ed-row">
            <span className="ed-row-n">{i + 1}</span>
            <input
              className="ed-input"
              value={item}
              maxLength={spec.itemMax}
              aria-label={`${spec.itemLabel} ${i + 1}`}
              onChange={(e) => onChange(value.map((x, k) => (k === i ? e.target.value.slice(0, spec.itemMax) : x)), hasDigit(e.target.value))}
            />
            <RemoveBtn label={`Remove ${spec.itemLabel.toLowerCase()} ${i + 1}`} disabled={value.length <= spec.minItems} onClick={() => onChange(value.filter((_, k) => k !== i), false)} />
          </div>
        ))}
      </div>
    </div>
  );
}

function ObjectListField({ spec, value, onChange }: { spec: Extract<FieldSpec, { kind: "objectList" }>; value: Array<Record<string, unknown>>; onChange: (v: unknown, touchedNumber: boolean) => void }) {
  const keyRef = useRef(0);
  return (
    <div>
      <ListHead label={spec.label} count={value.length} max={spec.maxItems} addLabel={`Add ${spec.itemLabel.toLowerCase()}`} onAdd={() => onChange([...value, spec.blank()], true)} />
      <div className="flex flex-col gap-1.5">
        {value.map((item, i) => (
          <div key={`${i}-${keyRef.current}`} className="ed-row">
            <span className="ed-row-n">{i + 1}</span>
            <div className="ed-row-fields">
              {spec.fields.map((f) =>
                f.kind === "number" ? (
                  <NumberField key={f.key} compact label={`${spec.itemLabel} ${i + 1} ${f.label.toLowerCase()}`} value={typeof item[f.key] === "number" ? (item[f.key] as number) : 0} onChange={(n) => onChange(value.map((x, k) => (k === i ? { ...x, [f.key]: n } : x)), true)} />
                ) : f.kind === "text" ? (
                  <input
                    key={f.key}
                    className="ed-input"
                    value={(item[f.key] as string | null) ?? ""}
                    maxLength={f.max}
                    placeholder={f.placeholder ?? f.label}
                    aria-label={`${spec.itemLabel} ${i + 1} ${f.label.toLowerCase()}`}
                    onChange={(e) => {
                      const s = e.target.value.slice(0, f.max);
                      onChange(value.map((x, k) => (k === i ? { ...x, [f.key]: f.nullable && s.trim() === "" ? null : s } : x)), hasDigit(s));
                    }}
                  />
                ) : null,
              )}
            </div>
            <RemoveBtn
              label={`Remove ${spec.itemLabel.toLowerCase()} ${i + 1}`}
              disabled={value.length <= spec.minItems}
              onClick={() => {
                keyRef.current += 1;
                onChange(value.filter((_, k) => k !== i), false);
              }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
