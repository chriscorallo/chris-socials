import { timelineDuration, type EditTimeline } from "../timeline";
import { timelineCaptionWords } from "../timeline-captions";
import type { TranscriptWord } from "../caption-chunking";
import type { PlacementOptions } from "../visual-placement";
import { directorCatalogText } from "./catalog";
import { DIRECTOR_ANSWER_SHAPE, type DirectorAnswer } from "./schema";
import { describeVisual, type DirectorRecord } from "./apply";
import { REGION_WORD } from "./placement";
import { expressionSegments, layoutWindows, understandingForTimeline, type ContactSheetPlan, type TakeUnderstanding } from "./understanding";

/**
 * The Director chat's message pack — PURE. One self-contained message (Chris's vision + what
 * the app measured about the video + the current edit + the vocabulary + the strict answer
 * shape) that Chris sends to his own ChatGPT for free, with the frames image attached — or that
 * the app sends to Claude when he has AI credit (same text, same image, same schema). Follow-ups
 * carry the conversation and the previous instructions so the answer is a delta.
 */

export const DIRECTOR_PACK_VERSION = "1.0.0";

export interface DirectorTurn {
  role: "CHRIS" | "EDITOR";
  text: string;
}

export interface DirectorPackInput {
  chrisMessage: string;
  /** Earlier turns, oldest first (Chris's messages + the editor's replies/change lists). */
  history: DirectorTurn[];
  /** The last instructions that were applied (follow-ups are deltas on top). */
  lastApplied: DirectorAnswer | null;
  timeline: EditTimeline;
  understanding: Record<string, TakeUnderstanding | null | undefined>;
  wordsByAsset: Record<string, TranscriptWord[] | null | undefined>;
  placement: Pick<PlacementOptions, "subjectTracks" | "sourceDimensions">;
  record: DirectorRecord | null;
  title?: string | null;
  /** The frames image that goes with this message (null = none attached). */
  sheet: ContactSheetPlan | null;
  /** Short brand note (optional). */
  brand?: string | null;
}

export interface DirectorPack {
  prompt: string;
  chars: number;
  version: string;
  /** Plain sentence for the UI about the image to attach. */
  imageNote: string | null;
}

const f1 = (n: number) => (Math.round(n * 10) / 10).toFixed(1);
const f2 = (n: number) => n.toFixed(2);

function transcriptBlock(timeline: EditTimeline, words: DirectorPackInput["wordsByAsset"]): string {
  const ws = timelineCaptionWords({ ...timeline, captions: { ...timeline.captions, enabled: true } }, words as Record<string, TranscriptWord[] | null>);
  if (!ws.length) return "No speech (he doesn't talk in this video) — the story is in his face and the graphics.";
  const lines: string[] = [];
  let cur: string[] = [];
  let start = ws[0]!.start;
  let last = ws[0]!.end;
  for (const w of ws) {
    if (cur.length && (w.start - last > 0.6 || cur.length >= 14)) {
      lines.push(`[${f1(start)}–${f1(last)}] ${cur.join(" ")}`);
      cur = [];
      start = w.start;
    }
    cur.push(w.word);
    last = w.end;
  }
  if (cur.length) lines.push(`[${f1(start)}–${f1(last)}] ${cur.join(" ")}`);
  return lines.join("\n");
}

function faceBlock(input: DirectorPackInput): string {
  const ou = understandingForTimeline(input.timeline, input.understanding);
  if (!ou.points.length) {
    return ou.missing.length
      ? "Not analysed yet for this footage (the app is still reading his face) — go by the frames image and Chris's description."
      : "No face data.";
  }
  const segs = expressionSegments(ou.points);
  const D = timelineDuration(input.timeline);
  const rows: string[] = [];
  const step = D > 80 ? 1 : 0.5;
  for (let t = 0; t <= D + 1e-6; t += step) {
    let near = ou.points[0]!;
    for (const p of ou.points) if (Math.abs(p.t - t) < Math.abs(near.t - t)) near = p;
    if (Math.abs(near.t - t) > step) continue;
    const top2 = near.probs
      ? near.probs
          .map((p, i) => ({ p, i }))
          .sort((a, b) => b.p - a.p)
          .slice(0, 2)
          .map(({ p, i }) => `${["neutral", "happy", "surprise", "sad", "angry", "disgust", "fear", "contempt"][i]} ${f2(p)}`)
          .join(", ")
      : "no face";
    rows.push(`${f1(t)} | ${top2} | motion ${f2(near.motion)}`);
  }
  const events = ou.events.length ? ou.events.map((e) => `${e.id} @ ${f2(e.t)} s — ${e.label}`).join("\n") : "(none detected)";
  const lay = layoutWindows(input.timeline, { ...input.placement, wordsByAsset: input.wordsByAsset });
  const layoutLine = (() => {
    const withHead = lay.filter((l) => l.head);
    if (!withHead.length) return "Face position unknown — assume he's centred, upper half.";
    const avg = (k: "left" | "right" | "top" | "bottom") => withHead.reduce((a, l) => a + l.free[k], 0) / withHead.length;
    const hx = withHead.reduce((a, l) => a + l.head!.x + l.head!.w / 2, 0) / withHead.length;
    const hy = withHead.reduce((a, l) => a + l.head!.y + l.head!.h / 2, 0) / withHead.length;
    return `His head is centred around x=${f2(hx)}, y=${f2(hy)} of the frame (0,0 = top-left). Free space inside the app-safe area, on average: left of his head ${Math.round(avg("left") * 100)}% of the width, right ${Math.round(avg("right") * 100)}%, above ${Math.round(avg("top") * 100)}% of the height, below ${Math.round(avg("bottom") * 100)}%. Side graphics get shrunk to fit beside him; big ones fit better BELOW his face.`;
  })();
  return [
    "(Measured by small on-device models — APPROXIMATE. Confidence 0–1. Use them as hints together with the frames image; Chris's description wins if they disagree. Mouth/eyes aren't measured separately — \"surprise\" ≈ eyes/mouth wide open.)",
    `Overall: ${segs.map((s) => `${f1(s.start)}–${f1(s.end)} s ${s.expression ?? "no face"}${s.expression ? ` (${f2(s.confidence)})` : ""}`).join(" → ")}`,
    "Events (use their ids in times, e.g. {\"event\":\"e1\"}):",
    events,
    "Per moment (time s | top expressions | motion 0–1):",
    rows.join("\n"),
    `Layout: ${layoutLine}`,
  ].join("\n");
}

function currentEditBlock(input: DirectorPackInput): string {
  const t = input.timeline;
  const D = timelineDuration(t);
  const refOf = new Map(Object.entries(input.record?.refs ?? {}).map(([ref, id]) => [id, ref]));
  const name = (id: string) => (refOf.has(id) ? `${id} (your ref "${refOf.get(id)}")` : id);
  const lines: string[] = [];
  lines.push(`Length ${f1(D)} s · ${t.clips.length} clip${t.clips.length === 1 ? "" : "s"} · captions ${t.captions.enabled ? `on (${t.captions.preset})` : "off"} · ${t.sfx.length} sound effect(s)`);
  for (const v of [...t.visuals].sort((a, b) => a.start - b.start)) {
    const pl = input.record?.placements[v.id];
    const where = pl ? REGION_WORD[pl.region] : v.placement.mode === "AUTO" ? "auto-placed" : `at x=${f2(v.placement.x)}, y=${f2(v.placement.y)}`;
    const preset = (v.props as { preset?: string }).preset;
    lines.push(`- graphic ${name(v.id)}: ${describeVisual(v)} · ${f1(v.start)}–${f1(v.end)} s · ${where}${preset ? ` · preset ${preset}` : ""}`);
  }
  for (const x of [...t.texts].sort((a, b) => a.start - b.start)) lines.push(`- text ${name(x.id)}: “${x.text.slice(0, 60)}” · ${f1(x.start)}–${f1(x.end)} s · y=${f2(x.y)}`);
  for (const z of t.zooms) lines.push(`- zoom ${name(z.id)}: ${z.zoom}× ${z.mode} · ${f1(z.start)}–${f1(z.end)} s`);
  for (const s of t.sfx) lines.push(`- sound ${name(s.id)}: ${s.sound} @ ${f1(s.at)} s`);
  if (t.visuals.length + t.texts.length + t.zooms.length + t.sfx.length === 0) lines.push("- (no graphics, texts, zooms or sounds yet — just his footage)");
  return lines.join("\n");
}

export function buildDirectorPack(input: DirectorPackInput): DirectorPack {
  const followUp = input.history.length > 0 || !!input.lastApplied;
  const D = timelineDuration(input.timeline);
  const focus = [input.chrisMessage, ...input.history.filter((h) => h.role === "CHRIS").map((h) => h.text)].join(" ");
  const imageNote = input.sheet
    ? `Attach the frames image: ${input.sheet.cells.length} frames, one every ${input.sheet.stepS} s, each labelled with its time and the detected expression.`
    : null;
  const parts = [
    `CHRIS'S VIDEO DIRECTOR — ${followUp ? "FOLLOW-UP" : "NEW EDIT"}${input.title ? ` · “${input.title}”` : ""}
You are the editor for one short vertical video (9:16, ${f1(D)} s) of Chris, a personal-finance creator. He describes his vision; you answer ONLY with edit instructions (JSON) that his app applies exactly. Build/animate/edit it for HIS vision — not led by captions or audio. Premium, clean, readable on a phone.${input.brand ? `\nBrand: ${input.brand}` : ""}`,
    `## WHAT CHRIS WANTS (his words — he outranks everything below)\n\n${input.chrisMessage.trim()}`,
    input.history.length
      ? `## CONVERSATION SO FAR (oldest first)\n\n${input.history
          .slice(-8)
          .map((h) => `${h.role === "CHRIS" ? "Chris" : "Editor (applied)"}: ${h.text.slice(0, 700)}`)
          .join("\n")}`
      : "",
    input.lastApplied
      ? `## YOUR PREVIOUS INSTRUCTIONS (already applied — answer with CHANGES ONLY: use move/update/remove on the ids below; don't add things twice)\n\n${JSON.stringify(input.lastApplied.operations).slice(0, 4000)}`
      : "",
    input.sheet ? `## FRAMES IMAGE\n\n${imageNote} Look at his face and body language in it.` : `## FRAMES IMAGE\n\n(No image attached this time — use the measurements below.)`,
    `## WHAT HE SAYS (word timings)\n\n${transcriptBlock(input.timeline, input.wordsByAsset)}`,
    `## FACE & MOVES\n\n${faceBlock(input)}`,
    `## CURRENT EDIT (ids you can move / update / remove)\n\n${currentEditBlock(input)}`,
    `## WHAT YOU CAN USE\n\n${directorCatalogText(focus)}`,
    `## RULES
- Times are seconds of the CURRENT edit (0–${f1(D)}). When he ties a moment to his face ("when I smile", "when the bills hit and my face drops"), use an expression/event time — not a guess.
- Use ONLY presets from the library (ids above). Put his data in with "props", "quick" or "lines"; never leave a preset's example data on screen.
- Numbers: use the ones Chris gives. If he gave none, pick realistic round numbers that fit his story and SAY in "reply" which numbers you chose so he can correct them.
- Placement: name a side/region ("LEFT", "RIGHT", "BOTTOM"…) relative to his face; the app keeps every graphic off his eyes and mouth and tells him if it had to move or shrink one. Max 2 graphics on screen at once.
- Timing: hold each graphic ≥ 1.2 s (≥ 0.4 s per line of text); a reaction lands on the beat, not before it.
- Sound: one sound per hit (CASH for money in, SOFT_POP/TICK for items stacking, IMPACT for a hard hit); ≤ 1 sound per 0.3 s.
- Text he says on screen goes in "addText" (style HEADLINE for a closing line).
- cut/trim run last; all times refer to the edit as it is now.
- If something he asks for isn't possible with these tools, do the closest thing and explain it in "reply" (or add a "note").

## HOW TO ANSWER
Reply with ONE JSON object in ONE code block, nothing before or after:
${DIRECTOR_ANSWER_SHAPE}`,
  ].filter(Boolean);
  const prompt = parts.join("\n\n");
  return { prompt, chars: prompt.length, version: DIRECTOR_PACK_VERSION, imageNote };
}
