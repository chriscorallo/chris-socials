"use client";

import {
  EMPHASIS_TEMPLATES,
  MOTION_LANGUAGES,
  anchorOffsetFor,
  normalizeZooms,
  timelineDuration,
  type MotionTheme,
  type TimelineVisual,
} from "@chris/media/timeline";
import {
  emphasisChoiceOf,
  setCameraCoupling,
  setEmphasisTiming,
  setIntegration,
  setMotionTheme,
  setVisualDepth,
  setVisualFollow,
} from "../../../../lib/editor/visuals";
import { useEditor } from "./context";
import { ensurePersonCutoutAction } from "./actions";
import { Section, Seg, Slider, Toggle } from "./Inspector";
import { drawnPlacement, PREVIEW_FPS } from "./MotionLayer";
import { Icon } from "./icons";

/**
 * Motion v2 controls for the selected graphic — "how it sits in the shot". Plain words, one
 * undo step each, and nothing ever jumps: Behind me / Follow me pin the graphic where it's drawn.
 */
export function InShotSection({ v }: { v: TimelineVisual }) {
  const { apply, doc, placement, engine, interactionCtx, interactions, assets, toast, itemId } = useEditor();
  const shown = placement.visuals.find((x) => x.id === v.id) ?? v;
  const fullFrame = v.template === "TITLE_CARD";
  const anyMatte = assets.some((a) => !!a.matteUrl);
  const behind = shown.depth === "BEHIND_SUBJECT";
  const following = v.anchor.type === "SUBJECT";
  const D = timelineDuration(doc);
  const zoomsInWindow = normalizeZooms(doc.zooms, D).zooms.some((z) => z.start < v.end && z.end > v.start && z.zoom !== 1);
  const ix = interactions[v.id];
  const hitAt = ix?.hitAtFrame != null ? v.start + ix.hitAtFrame / PREVIEW_FPS : null;
  const emphasisCapable = EMPHASIS_TEMPLATES.has(v.template) || (v.emphasisAt ?? 0) > 0;
  const choice = emphasisChoiceOf(v);
  const inWindow = (t: number) => Math.min(v.end - 0.05, Math.max(v.start, t));

  const toggleFollow = (on: boolean) => {
    const t = inWindow(engine.time);
    if (on) {
      const off = anchorOffsetFor(shown, doc, t, interactionCtx);
      if (!off) {
        toast("Can't see you in this part yet — follow needs your position (it's analysed after upload).", "warn");
        return;
      }
      apply((d) => setVisualFollow(d, v.id, off));
    } else {
      const at = drawnPlacement(shown, ix, t, doc.canvas);
      apply((d) => setVisualFollow(d, v.id, null, { x: at.x, y: at.y }));
    }
  };

  return (
    <Section title="In the shot">
      {!fullFrame && (
        <div>
          <Toggle
            label="Behind me"
            checked={behind}
            onChange={(on) => {
              apply((d) => setVisualDepth(d, v.id, on, shown));
              if (on && !anyMatte) {
                void ensurePersonCutoutAction(itemId).then((r) => {
                  if (r.started) toast("Cutting you out of the background — reopen the editor in a minute or two to see it behind you. The final video does it either way.", "ok");
                });
              }
            }}
          />
          <p className="ed-hint">
            {behind
              ? anyMatte
                ? "Sits between you and the background — you pass in front of it."
                : "Cutting you out in the background — the preview shows it in front until that's done; the final video puts it behind you."
              : "Put it behind you, like big type behind your head."}
          </p>
        </div>
      )}
      {fullFrame && (
        <div>
          <Toggle label="Behind me" checked={behind} onChange={(on) => apply((d) => setVisualDepth(d, v.id, on, shown))} />
          <p className="ed-hint">The title and the dimmed background go behind you.</p>
        </div>
      )}
      {!fullFrame && (
        <div>
          <Toggle label="Follow me" checked={following} onChange={toggleFollow} />
          <p className="ed-hint">{following ? "Moves with you — drag it to change where it sits next to you." : "Stays put on screen."}</p>
        </div>
      )}
      {!fullFrame && (
        <div>
          <Slider
            label="Move with camera"
            value={v.cameraCoupling}
            min={0}
            max={1}
            step={0.05}
            resetTo={0}
            format={(x) => (x === 0 ? "Off" : x >= 0.99 ? "Locked" : `${Math.round(x * 100)}%`)}
            onChange={(x) => apply((d) => setCameraCoupling(d, v.id, x), { coalesce: `vcam:${v.id}` })}
          />
          <p className="ed-hint">{zoomsInWindow ? "Rides your punch-in — around 35% feels like it's in the room." : "No punch-in while this graphic is on screen."}</p>
        </div>
      )}
      <div className="grid grid-cols-1 gap-2">
        <Toggle label="Shadow" checked={v.integration.shadow} onChange={(on) => apply((d) => setIntegration(d, v.id, { shadow: on }))} />
        <Toggle label="Light wrap" checked={v.integration.lightWrap} onChange={(on) => apply((d) => setIntegration(d, v.id, { lightWrap: on }))} />
        <Toggle label="Match scene" checked={v.integration.sceneMatch} onChange={(on) => apply((d) => setIntegration(d, v.id, { sceneMatch: on }))} />
      </div>
      {emphasisCapable && (
        <div>
          <Toggle label="Hit on my emphasis" checked={choice !== "OFF"} onChange={(on) => apply((d) => setEmphasisTiming(d, v.id, on ? "AUTO" : "OFF"))} />
          <p className="ed-hint">
            {choice === "OFF"
              ? "Plays at its own pace."
              : hitAt != null
                ? `Lands at ${hitAt.toFixed(1)}s — on your strongest word${typeof choice === "number" ? " near the spot you picked" : ""}.`
                : "Lands on your strongest word (measuring your voice…)."}
          </p>
          {choice !== "OFF" && (
            <button
              type="button"
              className="ed-toolbtn mt-1"
              onClick={() => {
                const t = inWindow(engine.time);
                apply((d) => setEmphasisTiming(d, v.id, Math.max(0.05, t - v.start)));
              }}
            >
              <Icon name="target" size={13} /> Hit near the playhead
            </button>
          )}
        </div>
      )}
    </Section>
  );
}

const LANGUAGE_LABEL: Record<(typeof MOTION_LANGUAGES)[number], string> = {
  CALM: "Calm",
  CRISP: "Crisp",
  PUNCHY: "Punchy",
  CINEMATIC: "Cinematic",
  PLAYFUL: "Playful",
};
const ICON_STYLE_LABEL: Record<MotionTheme["iconStyle"], string> = {
  GOLD_METAL: "Gold",
  SOFT_CLAY: "Clay",
  GLASS: "Glass",
  LINE: "Line",
};

/** The video's motion theme (timeline.motionTheme). "Auto" = picked from the topic. Data only. */
export function ThemePicker() {
  const { doc, apply } = useEditor();
  const t = doc.motionTheme;
  return (
    <Section title="Look of this video">
      <Seg
        label="Theme"
        value={t ? "CUSTOM" : "AUTO"}
        options={[
          ["AUTO", "Auto (from topic)"],
          ["CUSTOM", "Custom"],
        ]}
        onChange={(m) => apply((d) => (m === "AUTO" ? setMotionTheme(d, null) : setMotionTheme(d, { name: "My look" })))}
      />
      {t ? (
        <>
          <label className="flex flex-col gap-1">
            <span className="ed-label">Name</span>
            <input
              className="ed-input"
              value={t.name}
              maxLength={40}
              onChange={(e) => apply((d) => setMotionTheme(d, { name: e.target.value || "My look" }), { coalesce: "theme:name" })}
            />
          </label>
          <div>
            <span className="ed-label">Motion</span>
            <div className="ed-chips" role="group" aria-label="Motion language">
              {MOTION_LANGUAGES.map((l) => (
                <button key={l} type="button" className="ed-chip-btn" aria-pressed={t.motionLanguage === l} onClick={() => apply((d) => setMotionTheme(d, { motionLanguage: l }))}>
                  {LANGUAGE_LABEL[l]}
                </button>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <ColorPick label="Main color" value={t.primary} onChange={(c) => apply((d) => setMotionTheme(d, { primary: c }), { coalesce: "theme:primary" })} />
            <ColorPick label="Second color" value={t.secondary} onChange={(c) => apply((d) => setMotionTheme(d, { secondary: c }), { coalesce: "theme:secondary" })} />
          </div>
          <div>
            <span className="ed-label">Icons</span>
            <div className="ed-chips" role="group" aria-label="Icon style">
              {(Object.keys(ICON_STYLE_LABEL) as Array<MotionTheme["iconStyle"]>).map((s) => (
                <button key={s} type="button" className="ed-chip-btn" aria-pressed={t.iconStyle === s} onClick={() => apply((d) => setMotionTheme(d, { iconStyle: s }))}>
                  {ICON_STYLE_LABEL[s]}
                </button>
              ))}
            </div>
          </div>
          {t.rationale && <p className="ed-hint">“{t.rationale}”</p>}
        </>
      ) : (
        <p className="ed-hint">Colors, motion and icons are chosen to fit what the video is about.</p>
      )}
    </Section>
  );
}

function ColorPick({ label, value, onChange }: { label: string; value: string | null; onChange: (c: string | null) => void }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="ed-label">{label}</span>
      <div className="flex items-center gap-2">
        <label className="ed-swatch relative cursor-pointer overflow-hidden" style={{ background: value ?? "conic-gradient(red, yellow, lime, cyan, blue, magenta, red)" }}>
          <input type="color" className="absolute inset-0 opacity-0" aria-label={label} value={value ?? "#FFD54A"} onChange={(e) => onChange(e.target.value.toUpperCase())} />
        </label>
        {value ? (
          <button type="button" className="ed-toolbtn" onClick={() => onChange(null)}>
            Palette
          </button>
        ) : (
          <span className="text-[11px] text-[var(--color-text-faint)]">From palette</span>
        )}
      </div>
    </div>
  );
}
