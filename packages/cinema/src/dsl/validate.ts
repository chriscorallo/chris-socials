import type { z } from "zod";
import { ACTION_TYPES, ACTOR_KINDS, FIGURE_POSES, FilmSchema, VERBS, type Anchor, type Film, type Shot, type Verb } from "./schema";
import { VERB_TARGETS } from "../kinds";
import { closestWords, findWordIndex, levenshtein, tokenizeLine } from "./words";

/**
 * Validates a film written by a person or an LLM. Two layers:
 *  1. shape (zod) — every field's type and range;
 *  2. meaning — ids resolve, word anchors exist in the shot's line, shots have a length,
 *     camera moves have an end pose, narration exists when lines do…
 * Every problem comes back as { path, message, hint } in plain words, so the author (or the
 * model, in a repair loop) can fix exactly that field. Warnings never block a render.
 */

export interface FilmIssue {
  /** JSON-path-like location, e.g. "scenes[0].shots[2].text[0].at.word". */
  path: string;
  message: string;
  hint?: string;
}

export type ValidateFilmResult =
  | { ok: true; film: Film; warnings: FilmIssue[] }
  | { ok: false; errors: FilmIssue[]; warnings: FilmIssue[] };

function pathString(path: ReadonlyArray<PropertyKey>): string {
  let out = "";
  for (const p of path) {
    if (typeof p === "number") out += `[${p}]`;
    else out += out ? `.${String(p)}` : String(p);
  }
  return out || "(root)";
}

const FIELD_HINTS: Array<{ test: RegExp; hint: string }> = [
  { test: /\.(at|until|strikeAt)$/, hint: 'An anchor is seconds from the shot start (e.g. 1.2), "start", "end", {"word":"raise"} or {"fraction":0.5}.' },
  { test: /\.kind$/, hint: `Actor kinds: ${ACTOR_KINDS.join(", ")}.` },
  { test: /\.lens\.focalLength$/, hint: "Focal length in mm: 24 = wide, 35 = natural, 50 = normal, 85 = portrait, 135+ = compressed telephoto." },
  { test: /\.do$/, hint: `Action types: ${ACTION_TYPES.join(", ")}. See the visual catalog (VISUAL_CATALOG) for what each one depicts.` },
  { test: /\.pose$/, hint: `Poses: ${FIGURE_POSES.join(", ")}.` },
];

function zodIssues(error: z.ZodError): FilmIssue[] {
  return error.issues.map((iss) => {
    const path = pathString(iss.path);
    const hint = FIELD_HINTS.find((h) => h.test.test(path))?.hint;
    let message = iss.message;
    if (iss.code === "unrecognized_keys") {
      message = `Unknown field(s): ${iss.keys.join(", ")} — remove them or check the spelling.`;
    }
    return hint ? { path, message, hint } : { path, message };
  });
}

function isWordAnchor(a: Anchor | undefined): a is { word: string; occurrence?: number } {
  return typeof a === "object" && a !== null && "word" in a;
}

function checkAnchor(shot: Shot, anchor: Anchor | undefined, path: string, errors: FilmIssue[]) {
  if (!isWordAnchor(anchor)) return;
  if (!shot.line) {
    errors.push({ path, message: `Word anchor "${anchor.word}" but shot "${shot.id}" has no line.`, hint: "Use seconds or {\"fraction\":…} in shots without narration." });
    return;
  }
  const tokens = tokenizeLine(shot.line);
  const occ = anchor.occurrence ?? 1;
  if (findWordIndex(tokens, anchor.word, occ) < 0) {
    const count = tokens.filter((t) => t.norm === tokenizeLine(anchor.word)[0]?.norm).length;
    const message =
      count > 0
        ? `"${anchor.word}" appears ${count} time(s) in the line, not ${occ}.`
        : `"${anchor.word}" is not a word of this shot's line ("${shot.line}").`;
    errors.push({ path, message, hint: count > 0 ? undefined : `Did you mean: ${closestWords(tokens, anchor.word).join(", ")}? Anchor single words exactly as written (punctuation is ignored).` });
  }
}

export function validateFilm(input: unknown): ValidateFilmResult {
  const warnings: FilmIssue[] = [];
  const parsed = FilmSchema.safeParse(input);
  if (!parsed.success) return { ok: false, errors: zodIssues(parsed.error), warnings };
  const film = parsed.data;
  const errors: FilmIssue[] = [];

  // ids
  const castIds = new Set<string>();
  film.cast.forEach((a, i) => {
    if (castIds.has(a.id)) errors.push({ path: `cast[${i}].id`, message: `Duplicate actor id "${a.id}".` });
    castIds.add(a.id);
  });
  const actorRef = (ref: string, path: string) => {
    if (!castIds.has(ref)) {
      const near = [...castIds].sort((a, b) => levenshtein(a, ref) - levenshtein(b, ref)).slice(0, 2);
      errors.push({ path, message: `No actor "${ref}" in the cast.`, hint: near.length ? `Cast ids: ${[...castIds].join(", ")}. Closest: ${near.join(", ")}.` : "Add it to film.cast first." });
    }
  };
  const targetRef = (t: unknown, path: string) => {
    if (typeof t === "string" && t !== "target") actorRef(t, path);
  };
  const kindOf = new Map(film.cast.map((a) => [a.id, a.kind]));

  // parents: exist, not self, no cycles
  film.cast.forEach((a, i) => {
    if (!a.parent) return;
    if (a.parent === a.id) {
      errors.push({ path: `cast[${i}].parent`, message: `Actor "${a.id}" can't ride on itself.` });
      return;
    }
    actorRef(a.parent, `cast[${i}].parent`);
    const seen = new Set<string>([a.id]);
    let cur: string | undefined = a.parent;
    while (cur) {
      if (seen.has(cur)) {
        errors.push({ path: `cast[${i}].parent`, message: `Parent chain of "${a.id}" loops back on itself.`, hint: "A rides on B, B rides on A is impossible — remove one parent." });
        break;
      }
      seen.add(cur);
      cur = film.cast.find((c) => c.id === cur)?.parent;
    }
  });
  film.cast.forEach((a, i) => {
    if ((a.kind === "FIGURE" || a.kind === "CROWD") && typeof a.params?.pose === "string" && !(FIGURE_POSES as readonly string[]).includes(a.params.pose)) {
      errors.push({ path: `cast[${i}].params.pose`, message: `Unknown pose "${a.params.pose}".`, hint: `Poses: ${FIGURE_POSES.join(", ")}.` });
    }
  });

  const shotIds = new Set<string>();
  const sceneIds = new Set<string>();
  let anyLine = false;
  let estSeconds = 0;
  let first = true;

  film.scenes.forEach((scene, si) => {
    if (sceneIds.has(scene.id)) errors.push({ path: `scenes[${si}].id`, message: `Duplicate scene id "${scene.id}".` });
    sceneIds.add(scene.id);
    scene.shots.forEach((shot, hi) => {
      const p = `scenes[${si}].shots[${hi}]`;
      if (shotIds.has(shot.id)) errors.push({ path: `${p}.id`, message: `Duplicate shot id "${shot.id}".` });
      shotIds.add(shot.id);
      if (shot.line) anyLine = true;
      if (!shot.line && shot.duration === undefined) {
        errors.push({ path: `${p}.duration`, message: `Shot "${shot.id}" has no line and no duration — it would last 0 s.`, hint: "Give it a duration in seconds, or a narration line." });
      }
      if (shot.say && !shot.line) errors.push({ path: `${p}.say`, message: "`say` is a pronunciation override for `line`; this shot has no line." });
      const words = shot.line ? tokenizeLine(shot.line).length : 0;
      estSeconds += shot.duration ?? words / 2.6 + (shot.hold ?? 0) + (shot.leadIn ?? 0);

      // camera
      const cam = shot.camera;
      targetRef(cam.target, `${p}.camera.target`);
      if (cam.from === "CONTINUE" && first) errors.push({ path: `${p}.camera.from`, message: "The first shot cannot CONTINUE a previous camera.", hint: "Give it a pose: {\"distance\":6,\"azimuth\":0,\"elevation\":10}." });
      if (cam.rig !== "HOLD" && !cam.to) errors.push({ path: `${p}.camera.to`, message: `A ${cam.rig} needs an end pose ("to").`, hint: "Use rig HOLD for a still frame (it still breathes with `drift`)." });
      for (const pose of [cam.from, cam.to]) {
        if (pose && pose !== "CONTINUE" && pose.lookAt !== undefined) targetRef(pose.lookAt, `${p}.camera.lookAt`);
        if (pose && pose !== "CONTINUE" && pose.position === undefined && pose.distance === undefined && pose !== cam.to) {
          errors.push({ path: `${p}.camera.from`, message: "A camera pose needs a distance (spherical around the target) or a position." });
        }
      }
      if (cam.rig === "PASS_THROUGH" && cam.to && (cam.to.distance ?? 1) > 0.6) {
        warnings.push({ path: `${p}.camera.to.distance`, message: "PASS_THROUGH usually ends inside/very near the target (distance ≤ 0.6) so the next shot can emerge from it." });
      }
      targetRef(cam.lens.focus, `${p}.camera.lens.focus`);
      if (cam.rackFocus) {
        targetRef(cam.rackFocus.to, `${p}.camera.rackFocus.to`);
        checkAnchor(shot, cam.rackFocus.at, `${p}.camera.rackFocus.at`, errors);
      }
      if (cam.shake) checkAnchor(shot, cam.shake.at, `${p}.camera.shake.at`, errors);
      if (shot.lighting?.focusOn) actorRef(shot.lighting.focusOn, `${p}.lighting.focusOn`);

      // actions
      (shot.actions ?? []).forEach((a, ai) => {
        actorRef(a.actor, `${p}.actions[${ai}].actor`);
        if (a.do === "FLOW") actorRef(a.into, `${p}.actions[${ai}].into`);
        const kind = kindOf.get(a.actor);
        if (kind && (VERBS as readonly string[]).includes(a.do)) {
          const verb = a.do as Verb;
          const tgt = VERB_TARGETS[verb][kind];
          if (!tgt) {
            const ok = Object.keys(VERB_TARGETS[verb]);
            errors.push({ path: `${p}.actions[${ai}].do`, message: `${verb} doesn't apply to a ${kind} ("${a.actor}").`, hint: `${verb} works on: ${ok.join(", ")}. For anything else use SET with the param name.` });
          } else if (tgt.default === null && (a as { to?: number }).to === undefined) {
            errors.push({ path: `${p}.actions[${ai}].to`, message: `${verb} on a ${kind} needs "to" (the new ${tgt.param}).` });
          }
        }
        if (a.do === "CLIMB") {
          actorRef(a.on, `${p}.actions[${ai}].on`);
          const host = kindOf.get(a.on);
          if (host && host !== "STAIRS" && host !== "LADDER") errors.push({ path: `${p}.actions[${ai}].on`, message: `CLIMB needs a STAIRS or LADDER to climb; "${a.on}" is a ${host}.` });
          if (kind && kind !== "FIGURE") warnings.push({ path: `${p}.actions[${ai}].actor`, message: `Only a FIGURE has climbing limbs; a ${kind} will just slide up the path.` });
        }
        if ((a.do === "WALK" || a.do === "POSE") && kind && kind !== "FIGURE" && !(a.do === "POSE" && kind === "CROWD")) {
          warnings.push({ path: `${p}.actions[${ai}].actor`, message: `${a.do} is meant for a FIGURE${a.do === "POSE" ? " or CROWD" : ""}; a ${kind} will ${a.do === "WALK" ? "just glide" : "ignore it"}.` });
        }
        checkAnchor(shot, a.at, `${p}.actions[${ai}].at`, errors);
      });
      (shot.text ?? []).forEach((t, ti) => {
        checkAnchor(shot, t.at, `${p}.text[${ti}].at`, errors);
        checkAnchor(shot, t.until, `${p}.text[${ti}].until`, errors);
        checkAnchor(shot, t.strikeAt, `${p}.text[${ti}].strikeAt`, errors);
        if (t.style !== "FOOTNOTE" && t.text.length > 60) errors.push({ path: `${p}.text[${ti}].text`, message: `On-screen text is ${t.text.length} characters; keep beats ≤ 60 (FOOTNOTE allows 120).`, hint: "Say it in the line; put only the number or the 2–5 words that matter on screen." });
        if (t.countFrom !== undefined && !/\d/.test(t.text)) errors.push({ path: `${p}.text[${ti}].countFrom`, message: "countFrom needs a number in the text to count to." });
        if (t.style === "HERO_NUMBER" && t.text.length > 12) warnings.push({ path: `${p}.text[${ti}].text`, message: "HERO_NUMBER is set huge; more than ~12 characters will be shrunk to fit." });
      });
      (shot.sfx ?? []).forEach((s, xi) => checkAnchor(shot, s.at, `${p}.sfx[${xi}].at`, errors));
      first = false;
    });
  });

  if (anyLine && !film.narration) errors.push({ path: "narration", message: "Shots have lines but the film has no narration settings.", hint: '"narration": {"engine":"KOKORO","voice":"am_michael"}' });
  const ratio = film.format.width / film.format.height;
  if (Math.abs(ratio - 9 / 16) > 0.01) warnings.push({ path: "format", message: `Aspect ${film.format.width}×${film.format.height} is not 9:16; shorts platforms will crop or letterbox it.` });
  if (estSeconds > 75) warnings.push({ path: "scenes", message: `Estimated length ~${Math.round(estSeconds)} s — mini-movies land best at 30–60 s.` });
  if (estSeconds < 10) warnings.push({ path: "scenes", message: `Estimated length ~${Math.round(estSeconds)} s — very short.` });

  return errors.length ? { ok: false, errors, warnings } : { ok: true, film, warnings };
}

/** Human-readable report (CLI / repair prompt). */
export function formatIssues(issues: FilmIssue[]): string {
  return issues.map((i) => `- ${i.path}: ${i.message}${i.hint ? `\n    hint: ${i.hint}` : ""}`).join("\n");
}
