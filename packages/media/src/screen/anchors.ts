import { PLACEMENT_SAFE_ZONE } from "../platform-profiles";
import type { SubjectTrack } from "../subject-track-core";
import type { EditTimeline, TextAnchor } from "../timeline";
import { layoutTimelineText, type MeasureText } from "../timeline-layout";
import { ASSUMED_HEAD_REGION, mapSourceBoxToCanvas, placementSafeArea, protectedFaceRect } from "../visual-placement";
import { subjectBoxAt } from "../subject-track-core";
import { locateOutputTime, timelineDuration } from "../timeline";

/**
 * Anchors (Screen Orchestrator, docs/PREMIUM_EDITOR_PLAN.md round 5): fixed zones for the whole
 * video, picked ONCE from the subject track so the viewer learns where to look. Headlines live in
 * the top zone above the head; when the framing gives no headroom they move to the side band,
 * then under the chin — never onto the face, never the forehead. Graphics go beside the head
 * (under the headline when it is a side headline). Captions sit at one spot near the speaker
 * (the chest), not a fixed y. PURE.
 */
import type { Rect } from "../safe-zones";
export type { Rect };

export interface HeadlineAnchor {
  zone: TextAnchor;
  /** Canvas fractions (centre) + the text box width as a fraction of the canvas width. */
  x: number;
  y: number;
  maxWidth: number;
  fontSize: number;
  align: "left" | "center" | "right";
}

export interface ScreenAnchors {
  headline: HeadlineAnchor | null;
  /** The hook title's anchor (bigger type, same zone). */
  title: HeadlineAnchor | null;
  /** Where a graphic may build (canvas px), or null when nothing beside the head is wide enough. */
  graphic: Rect | null;
  caption: { zone: "CHEST" | "BELOW_HEADLINE" | "FIXED"; y: number };
  /** What the anchors were resolved from (canvas px). */
  head: Rect | null;
  face: Rect | null;
  core: Rect | null;
  tracked: boolean;
  notes: string[];
}

export interface AnchorInput {
  timeline: Pick<EditTimeline, "clips" | "canvas" | "zooms" | "captions">;
  mediaAssetId: string;
  subjectTrack?: SubjectTrack | null;
  sourceSize?: { width: number; height: number } | null;
  measure: MeasureText;
  /** The headline texts (to size the zone for the longest one) and the hook title. */
  headlines: string[];
  title: string | null;
  /** Output time the hook beat ends (the title's window); 0 = no hook window. */
  hookEnd?: number;
  headlineFontSize?: number;
  titleFontSize?: number;
  captionFontSize?: number;
}

/** The face (+ a small forehead/chin margin) inside a protected head region (subject-track-core:
 * face expanded 0.6 face heights up, 0.25 down, 0.35 widths each side). */
export function faceOf(head: Rect): Rect {
  const fh = head.height / 1.85;
  const fw = head.width / 1.7;
  return { x: head.x + 0.35 * fw, y: head.y + 0.45 * fh, width: fw, height: fh * 1.25 };
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

function blockHeight(text: string, fontSize: number, maxWidth: number, canvas: { width: number; height: number }, measure: MeasureText): number {
  return layoutTimelineText(
    { text, fontId: "inter-display-extrabold", fontSize, backgroundColor: "#000000B3", strokeColor: null, align: "center", x: 0.5, y: 0.5, maxWidth, uppercase: true },
    canvas,
    measure,
  ).rect.height;
}

function quantile(xs: number[], q: number): number {
  const a = [...xs].sort((x, y) => x - y);
  if (!a.length) return 0;
  const i = Math.min(a.length - 1, Math.max(0, Math.round(q * (a.length - 1))));
  return a[i]!;
}

/**
 * Where the face and the head ARE for most of the video (canvas px): sampled every 0.2 s through
 * each clip's crop, then the band the face stays inside 80 % of the time (p10–p90 of each edge).
 * A union would grow to the whole frame the moment he leans once; a fixed anchor needs the
 * typical framing, and the audit checks each element against its own window anyway.
 */
export interface SubjectBand {
  face: Rect | null;
  head: Rect | null;
  tracked: boolean;
  /** Per-sample limits (canvas px), each the value that holds for 90 % of the window — never
   * derived from the band rect (a band across two crops inflates every derived size). */
  limits: { headTop: number; hairTop: number; faceTop: number; faceTopTypical: number; faceBottom: number; headBottom: number; left: number; right: number; eye: number } | null;
}

export function sampleSubject(
  timeline: Pick<EditTimeline, "clips" | "canvas">,
  mediaAssetId: string,
  track: SubjectTrack | null,
  sourceSize: { width: number; height: number } | null,
  window: { from: number; to: number } = { from: 0, to: Number.POSITIVE_INFINITY },
): SubjectBand {
  const canvas = timeline.canvas;
  const limitsOf = (heads: Rect[], faces: Rect[]) => ({
    headTop: quantile(heads.map((r) => r.y), 0.1),
    hairTop: quantile(faces.map((r) => r.y - 0.12 * r.height), 0.1),
    faceTop: quantile(faces.map((r) => r.y), 0.1),
    /** Where the face box starts most of the time (median, a hand above the brow) — the last
     * resort limit for a top headline on a tight framing: over the hair, never the core. */
    faceTopTypical: quantile(faces.map((r) => r.y - 0.06 * r.height), 0.5),
    faceBottom: quantile(faces.map((r) => r.y + r.height), 0.9),
    headBottom: quantile(heads.map((r) => r.y + r.height), 0.9),
    left: quantile(heads.map((r) => r.x), 0.1),
    right: quantile(heads.map((r) => r.x + r.width), 0.9),
    eye: quantile(faces.map((r) => r.y + 0.35 * r.height), 0.5),
  });
  if (!track || track.length === 0) {
    const a = ASSUMED_HEAD_REGION;
    const head = { x: a.x * canvas.width, y: a.y * canvas.height, width: a.w * canvas.width, height: a.h * canvas.height };
    const face = faceOf(head);
    return { head, face, tracked: false, limits: limitsOf([head], [face]) };
  }
  const dur = timelineDuration(timeline);
  const faces: Rect[] = [];
  const heads: Rect[] = [];
  const none = { zoom: 1, x: 0.5, y: 0.5 };
  const to = Math.min(dur, window.to);
  for (let t = Math.max(0.05, window.from + 0.05); t < to; t += 0.2) {
    const loc = locateOutputTime(timeline, t);
    if (!loc) continue;
    const clip = timeline.clips[loc.clipIndex]!;
    if (clip.mediaAssetId !== mediaAssetId) continue;
    // The stored track is the PROTECTED HEAD region (face + hair + margin, subject-track-core);
    // the face is derived from it the way the placement solver does.
    const box = subjectBoxAt(track, loc.sourceTime);
    if (!box) continue;
    const src = sourceSize ?? canvas;
    const h = mapSourceBoxToCanvas(box, src, canvas, clip.crop, none);
    if (h) {
      heads.push(h);
      faces.push(faceOf(h));
    }
  }
  const band = (rs: Rect[]): Rect | null => {
    if (!rs.length) return null;
    const x = quantile(rs.map((r) => r.x), 0.1);
    const y = quantile(rs.map((r) => r.y), 0.1);
    const x2 = quantile(rs.map((r) => r.x + r.width), 0.9);
    const y2 = quantile(rs.map((r) => r.y + r.height), 0.9);
    return { x, y, width: Math.max(0, x2 - x), height: Math.max(0, y2 - y) };
  };
  return { face: band(faces), head: band(heads), tracked: true, limits: heads.length ? limitsOf(heads, faces) : null };
}

/** Resolves every anchor for one video. Never throws; a missing subject track resolves the
 * assumed centred framing (and says so). */
export function resolveScreenAnchors(input: AnchorInput): ScreenAnchors {
  const canvas = input.timeline.canvas;
  const W = canvas.width;
  const H = canvas.height;
  const k = W / 1080;
  const margin = Math.round(14 * k);
  const safe = placementSafeArea(canvas, PLACEMENT_SAFE_ZONE);
  const notes: string[] = [];
  const dur = timelineDuration(input.timeline);
  const hookEnd = Math.min(dur, Math.max(0, input.hookEnd ?? 0));
  // The title lives in the hook window (its own framing); headlines, graphics and captions in
  // the rest of the video — each anchored to the framing it will actually sit over.
  const subject = sampleSubject(input.timeline, input.mediaAssetId, input.subjectTrack ?? null, input.sourceSize ?? null, { from: hookEnd < dur - 1 ? hookEnd : 0, to: dur });
  const hookSubject = hookEnd > 0.5 ? sampleSubject(input.timeline, input.mediaAssetId, input.subjectTrack ?? null, input.sourceSize ?? null, { from: 0, to: hookEnd }) : subject;
  const head = subject.head;
  const face = subject.face;
  const core = head ? protectedFaceRect(head, safe) : null;
  if (!subject.tracked) notes.push("no subject track — anchors assume a centred framing");

  const longest = (texts: string[]) => texts.reduce((a, b) => (b.length > a.length ? b : a), texts[0] ?? "HEADLINE");
  void hookEnd;
  const headlineText = longest(input.headlines.length ? input.headlines : ["WHICH ONE ARE YOU?"]);
  const titleText = input.title ?? headlineText;
  const hSize = input.headlineFontSize ?? 60;
  const tSize = input.titleFontSize ?? 72;
  const capSize = input.captionFontSize ?? input.timeline.captions.fontSize;

  // The band a top-zone text may use: above the head (hair included) when there is room, else
  // above the face (over the hair margin — never the forehead, never the core).
  const bandTop = safe.y;
  const fitTop = (text: string, sizes: number[], maxWidth: number, sub: SubjectBand): HeadlineAnchor | null => {
    const L = sub.limits;
    const limits = L ? [L.headTop, L.hairTop, L.faceTopTypical] : [safe.y + 0.3 * H];
    for (const size of sizes) {
      const h = blockHeight(text, size, maxWidth, canvas, input.measure);
      for (const limit of limits) {
        if (limit - bandTop >= h + 2 * margin) {
          if (L && limit === L.faceTopTypical && !notes.some((n) => n.startsWith("headlines sit over the hair"))) notes.push("headlines sit over the hair (the head fills the top zone) — leave the top third empty when filming for a clean zone");
          return { zone: "TOP", x: 0.5, y: r3((bandTop + (limit - bandTop) / 2) / H), maxWidth, fontSize: size, align: "center" };
        }
      }
    }
    return null;
  };
  // Side band: beside the head, the wider side, at eye level.
  const fitSide = (text: string, sizes: number[], sub: SubjectBand): HeadlineAnchor | null => {
    const L = sub.limits;
    if (!L) return null;
    const left = L.left - safe.x;
    const right = safe.x + safe.width - L.right;
    const side: "SIDE_L" | "SIDE_R" = left >= right ? "SIDE_L" : "SIDE_R";
    const width = Math.max(left, right) - 2 * margin;
    if (width < 0.3 * W) return null;
    const maxWidth = r3(width / W);
    for (const size of sizes) {
      const h = blockHeight(text, size, maxWidth, canvas, input.measure);
      if (h > safe.height * 0.5) continue;
      const cx = side === "SIDE_L" ? safe.x + margin + width / 2 : safe.x + safe.width - margin - width / 2;
      const cy = Math.min(Math.max(L.eye, safe.y + h / 2 + margin), safe.y + safe.height - h / 2 - margin);
      return { zone: side, x: r3(cx / W), y: r3(cy / H), maxWidth, fontSize: size, align: side === "SIDE_L" ? "left" : "right" };
    }
    return null;
  };
  // Under the chin, above where the captions will sit.
  const fitBelow = (text: string, sizes: number[], maxWidth: number, sub: SubjectBand): HeadlineAnchor | null => {
    const L = sub.limits;
    if (!L) return null;
    const bottom = safe.y + safe.height - 2.4 * capSize * k; // room left for one caption line below
    for (const size of sizes) {
      const h = blockHeight(text, size, maxWidth, canvas, input.measure);
      if (bottom - L.faceBottom >= h + 2 * margin) {
        return { zone: "NEAR_SPEAKER", x: 0.5, y: r3((L.faceBottom + margin + h / 2) / H), maxWidth, fontSize: size, align: "center" };
      }
    }
    return null;
  };
  const sizesH = [hSize, hSize - 8, hSize - 16].filter((s) => s >= 40);
  const sizesT = [tSize, tSize - 8, tSize - 16, Math.max(48, tSize - 24)].filter((s, i, a) => a.indexOf(s) === i && s >= 40);
  let headline = fitTop(headlineText, sizesH, 0.8, subject) ?? fitSide(headlineText, sizesH, subject) ?? fitBelow(headlineText, sizesH, 0.8, subject);
  if (!headline) notes.push("no clear zone for headlines (the face fills the frame) — headlines dropped; shoot wider / leave the top third empty");
  // The title shares the headline's zone (one place to look) over the hook's own framing; it
  // only differs in size. With no headline zone it may still sit over the hair at a small size.
  let title: HeadlineAnchor | null = null;
  const fitIn = (zone: TextAnchor | null, text: string, sizes: number[], sub: SubjectBand) =>
    zone === "TOP" ? fitTop(text, sizes, 0.8, sub) : zone === "NEAR_SPEAKER" ? fitBelow(text, sizes, 0.8, sub) : zone ? fitSide(text, sizes, sub) : null;
  if (input.title) {
    title = (headline && fitIn(headline.zone, titleText, sizesT, hookSubject)) ?? fitTop(titleText, sizesT, 0.8, hookSubject) ?? fitSide(titleText, sizesT, hookSubject) ?? fitBelow(titleText, sizesT, 0.8, hookSubject) ?? fitTop(titleText, [48, 44], 0.8, hookSubject);
    if (!title && headline) {
      // The hook's own framing (a punch-in) leaves no clean zone: the title still opens the video,
      // in the headline's zone at a small size — a title over the hair beats no title (the hook
      // text must be on screen by 1.5 s).
      title = { ...headline, fontSize: Math.min(headline.fontSize, 48) };
      notes.push("the hook framing leaves no clean zone — the title sits in the headline zone at a small size");
    }
    if (!title) notes.push("no clear zone for the title during the hook — title dropped");
  }
  if (headline && title && headline.zone === "TOP" && title.zone === "TOP" && Math.abs(headline.y - title.y) < 0.04) {
    // Same vertical centre for both so a change from title to headline never jumps.
    headline = { ...headline, y: title.y };
  }

  // Graphics: the wider side band beside the head/body; under a side headline it is the same band.
  let graphic: Rect | null = null;
  const L = subject.limits;
  if (L) {
    const left = L.left - safe.x;
    const right = safe.x + safe.width - L.right;
    const useLeft = headline?.zone === "SIDE_L" ? true : headline?.zone === "SIDE_R" ? false : left >= right;
    const width = (useLeft ? left : right) - 2 * margin;
    if (width >= 0.3 * W) {
      const top = headline?.zone === "SIDE_L" || headline?.zone === "SIDE_R" ? L.eye + 0.5 * (L.faceBottom - L.eye) : Math.max(safe.y, L.headTop);
      graphic = { x: useLeft ? safe.x + margin : safe.x + safe.width - margin - width, y: top, width, height: Math.max(0, safe.y + safe.height - top - 2.6 * capSize * k) };
    }
  }

  // Captions: one line near the chest, below the head; under a NEAR_SPEAKER headline they move down.
  const capLine = 1.15 * capSize * k;
  let capY: number;
  let zone: ScreenAnchors["caption"]["zone"] = "CHEST";
  if (headline?.zone === "NEAR_SPEAKER") {
    const hb = headline.y * H + blockHeight(headlineText, headline.fontSize, headline.maxWidth, canvas, input.measure) / 2;
    capY = Math.min(0.82 * H, Math.max(input.timeline.captions.y * H, hb + 2 * margin + capLine / 2));
    zone = "BELOW_HEADLINE";
  } else if (L) {
    // Near the chest: below the chin, never higher on screen than the base look puts them
    // (his own placement / the default 0.72 already sits under the platform-safe line he
    // accepts), and never into the very bottom of the frame.
    const chest = L.faceBottom + 3 * margin + capLine / 2;
    capY = Math.min(0.82 * H, Math.max(input.timeline.captions.y * H, chest));
    if (chest > input.timeline.captions.y * H) notes.push("captions moved down under the chin");
  } else {
    capY = input.timeline.captions.y * H;
    zone = "FIXED";
  }
  return { headline, title, graphic, caption: { zone, y: r3(capY / H) }, head, face, core, tracked: subject.tracked, notes };
}
