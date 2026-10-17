import type { PrismaClient } from "@prisma/client";
import { recordAudit } from "./audit";

/**
 * Motion taste — learning Chris's motion-graphics preferences from what he KEEPS, EDITS and
 * DELETES in the finishing editor (spec §7 Human Taste Model), and handing a compact,
 * evidence-weighted summary to the Motion Designer next time.
 *
 * Three layers, deliberately separate (TASTE_LEARNER.md: the raw event is evidence, the tag
 * is an interpretation):
 * 1. `diffMotionEdits(before, after)` — PURE: one save's diff -> signals (tag + auto-written
 *    raw feedback + structured context). One event says what happened, never what it means
 *    in general.
 * 2. `recordMotionEditSignals(prisma, ...)` — persists them as TasteFeedback rows
 *    (artifactType MOTION_GRAPHIC), idempotent per saved plan version.
 * 3. `buildMotionTasteProfile(rows, now)` — PURE aggregation with recency decay, minimum
 *    evidence and cross-video thresholds. Spec §7: "Do not convert one preference into a
 *    universal rule" — a preference is STRONG only after >= 3 consistent signals across >= 2
 *    videos; anything less is WEAK (a hint), and evidence from a single topic stays scoped to
 *    that topic. Chris can "forget" any learned preference (a counter-signal row; the
 *    evidence itself is never deleted).
 *
 * Structural types only (no @chris/media import) so the domain package stays dependency-free.
 */

export const MOTION_GRAPHIC_ARTIFACT = "MOTION_GRAPHIC";

// ------------------------------------------------------------------------------- topics

export const MOTION_TOPICS = ["DEBT", "CREDIT", "INVESTING", "SAVING", "CAREER", "LIFESTYLE", "MINDSET", "GENERAL"] as const;
export type MotionTopic = (typeof MOTION_TOPICS)[number];

const TOPIC_KEYWORDS: Record<Exclude<MotionTopic, "GENERAL">, RegExp[]> = {
  DEBT: [/\bdebts?\b/, /\bowe\b/, /\bloans?\b/, /\bpay(ing)? ?off\b/, /\bpayoff\b/, /\bminimum payments?\b/, /\bbalance transfer\b/, /\bsnowball\b/, /\bavalanche\b/, /\bapr\b/, /\bcollections?\b/, /\bbankrupt/, /\binterest charges?\b/, /\bcard balance\b/],
  CREDIT: [/\bcredit scores?\b/, /\bcredit reports?\b/, /\bfico\b/, /\butili[sz]ation\b/, /\bcredit limits?\b/, /\bcredit history\b/, /\bcredit cards?\b/],
  INVESTING: [/\binvest(ing|ment|ments|or|ors)?\b/, /\bstocks?\b/, /\bindex funds?\b/, /\betfs?\b/, /\bs&p\b/, /\bcompound(ing|s|ed)?\b/, /\bportfolio\b/, /\bdividends?\b/, /\bstock market\b/, /\broth\b/, /\bbrokerage\b/, /\breturns?\b/, /\bcrypto\b/],
  SAVING: [/\bsav(e|es|ing|ings)\b/, /\bemergency fund\b/, /\bbudget(ing|s)?\b/, /\bretire(ment)?\b/, /\b401\(?k\)?\b/, /\bhigh[- ]yield\b/, /\bhysa\b/, /\bpension\b/, /\binsurance\b/],
  CAREER: [/\bcareers?\b/, /\bjobs?\b/, /\bsalar(y|ies)\b/, /\braises?\b/, /\bpromotions?\b/, /\binterviews?\b/, /\bbusiness(es)?\b/, /\bstartups?\b/, /\bside hustles?\b/, /\bclients?\b/, /\bnegotiat/, /\bboss\b/, /\bresumes?\b/, /\bentrepreneur/, /\brevenue\b/, /\bincome\b/],
  LIFESTYLE: [/\bl\.?a\.?\b/, /\blos angeles\b/, /\bgym\b/, /\btravel/, /\bapartment\b/, /\bday in (the|my) life\b/, /\bmorning\b/, /\broutine\b/, /\bvlog\b/, /\bbeach\b/, /\bweekend\b/, /\bfriends?\b/, /\bworkouts?\b/, /\bdate night\b/, /\bfood\b/, /\bcoffee\b/],
  MINDSET: [/\bmindset\b/, /\bdiscipline\b/, /\bpsycholog/, /\bhabits?\b/, /\bdecisions?\b/, /\bmistakes?\b/, /\bregrets?\b/, /\bfears?\b/, /\bskeptic/, /\bambition\b/, /\bmotivation\b/, /\bconfidence\b/],
};

export interface MotionTopicInput {
  title?: string | null;
  description?: string | null;
  /** ContentItem.pillar: SKILL | MINDSET | LIFESTYLE | PASSIONS. */
  pillar?: string | null;
  /** The spoken script (weakest signal — long and noisy). */
  script?: string | null;
}

/**
 * Deterministic topic of a video from its title (x3), description (x2), script (x1, capped)
 * and pillar prior. Ties resolve in MOTION_TOPICS order; no keyword at all -> GENERAL.
 */
export function classifyMotionTopic(input: MotionTopicInput): { topic: MotionTopic; scores: Partial<Record<MotionTopic, number>> } {
  const scores: Partial<Record<MotionTopic, number>> = {};
  const add = (t: MotionTopic, n: number) => (scores[t] = (scores[t] ?? 0) + n);
  const parts: Array<[string | null | undefined, number, number]> = [
    [input.title, 3, 3],
    [input.description, 2, 2],
    [input.script, 1, 4],
  ];
  for (const [text, weight, cap] of parts) {
    if (!text) continue;
    const lower = text.toLowerCase();
    for (const [topic, res] of Object.entries(TOPIC_KEYWORDS) as Array<[MotionTopic, RegExp[]]>) {
      let hits = 0;
      for (const re of res) {
        const g = new RegExp(re.source, "g");
        hits += (lower.match(g) ?? []).length;
      }
      if (hits) add(topic, Math.min(cap, hits) * weight);
    }
  }
  // "credit card debt" is a debt video, not a credit-score video.
  if ((scores.DEBT ?? 0) > 0 && (scores.CREDIT ?? 0) > 0) add("DEBT", 1);
  if (input.pillar === "MINDSET") add("MINDSET", 2);
  if (input.pillar === "LIFESTYLE") add("LIFESTYLE", 1.5);
  if (input.pillar === "PASSIONS") add("LIFESTYLE", 1);
  let best: MotionTopic = "GENERAL";
  let bestScore = 0;
  for (const t of MOTION_TOPICS) {
    const s = scores[t] ?? 0;
    if (s > bestScore) {
      best = t;
      bestScore = s;
    }
  }
  return { topic: best, scores };
}

// ------------------------------------------------------------------------------- signals

/** Event-level interpretations of a single edit (never a general rule by themselves). */
export const MOTION_TASTE_TAGS = [
  "REJECTED_TEMPLATE", // an AI-proposed visual was deleted
  "ACCEPTED_TEMPLATE", // an AI-proposed visual was kept untouched (first save after an AI design)
  "ADJUSTED_TEMPLATE", // an AI-proposed visual was kept but edited (context.changes)
  "SWAPPED_TEMPLATE", // a visual's template was changed (context.from/to)
  "ADDED_TEMPLATE", // Chris added a visual himself
  "SHORTER_ANIMATIONS", // a visual was trimmed (>= 0.3 s and >= 15 %)
  "LONGER_ANIMATIONS", // a visual was extended
  "MORE_BEHIND_HEAD", // a visual moved behind the subject (depth)
  "LESS_BEHIND_HEAD", // a visual moved back in front
  "LESS_SOUND", // a sound effect was removed / an entrance sfx silenced
  "TOO_BUSY", // many of the AI's visuals deleted in one save
  "PREFERS_THEME", // the video's motion theme was overridden (context.from/to)
  "FORGET", // Chris asked the system to forget a learned preference (context.key)
] as const;
export type MotionTasteTag = (typeof MOTION_TASTE_TAGS)[number];

/** Minimal structural view of a TimelineVisual (packages/media motion-contract). */
export interface MotionVisualLike {
  id: string;
  template: string;
  start: number;
  end: number;
  props?: unknown;
  placement?: { mode?: string; x?: number; y?: number; scale?: number } | null;
  palette?: string | null;
  enter?: string | null;
  exit?: string | null;
  enterSfx?: string | null;
  depth?: string | null;
}

export interface MotionThemeLike {
  name?: string | null;
  motionLanguage?: string | null;
  iconStyle?: string | null;
  primary?: string | null;
  secondary?: string | null;
}

export interface MotionTimelineLike {
  visuals?: MotionVisualLike[] | null;
  sfx?: Array<{ id: string; sound?: string; at?: number }> | null;
  motionTheme?: MotionThemeLike | null;
}

export interface MotionEditSignal {
  tag: MotionTasteTag;
  rawFeedback: string;
  context: Record<string, unknown>;
}

/** AI-proposed visuals carry the Motion Designer's deterministic ids (mv-N); the editor's
 * own inserts are vis-..., duplicates get fresh ids. */
export function isAiVisualId(id: string): boolean {
  return /^mv-\d+$/.test(id);
}

const TEMPLATE_WORDS: Record<string, string> = {
  KINETIC_TEXT: "kinetic text",
  NUMBER_COUNTER: "number counter",
  STAT_CARD: "stat card",
  BAR_CHART: "bar chart",
  LINE_CHART: "line chart",
  COMPARISON: "comparison",
  PERCENT_RING: "percent ring",
  LIST_STEPS: "list",
  ICON_3D: "3D icon",
  MONEY_STACK_3D: "3D money stack",
  CALLOUT: "callout",
  TIMELINE: "timeline",
  DEFINITION: "definition card",
  TITLE_CARD: "title card",
};

export function templateWords(t: string): string {
  return TEMPLATE_WORDS[t] ?? t.toLowerCase().replace(/_/g, " ");
}

/** "3D" graphics: real-geometry templates and depth3d bar charts. */
export function isThreeD(v: Pick<MotionVisualLike, "template" | "props">): boolean {
  if (v.template === "ICON_3D" || v.template === "MONEY_STACK_3D") return true;
  return v.template === "BAR_CHART" && !!(v.props as { depth3d?: unknown } | null)?.depth3d;
}

function stable(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  return `{${Object.keys(v as object)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
    .join(",")}}`;
}

function topicWord(topic: MotionTopic): string {
  return topic === "GENERAL" ? "" : ` on a ${topic.toLowerCase()} video`;
}

function secs(n: number): string {
  return `${(Math.round(n * 10) / 10).toFixed(1)}s`;
}

const DURATION_ABS = 0.3;
const DURATION_REL = 0.15;
const PLACEMENT_EPS = 0.02;

/**
 * PURE: what one finishing-edit save says about Chris's motion taste. `beforeWasAiDesign`
 * = the previous version was produced by the Motion Designer (only then does "kept as is"
 * mean "accepted" — later saves would otherwise re-count the same untouched visuals).
 */
export function diffMotionEdits(
  before: MotionTimelineLike | null | undefined,
  after: MotionTimelineLike | null | undefined,
  ctx: { topic: MotionTopic; beforeWasAiDesign?: boolean },
): MotionEditSignal[] {
  const out: MotionEditSignal[] = [];
  const bVis = before?.visuals ?? [];
  const aVis = after?.visuals ?? [];
  const aById = new Map(aVis.map((v) => [v.id, v]));
  const bById = new Map(bVis.map((v) => [v.id, v]));
  const tw = topicWord(ctx.topic);
  const base = (v: MotionVisualLike) => ({ template: v.template, topic: ctx.topic, at: Math.round(v.start * 100) / 100, visualId: v.id, threeD: isThreeD(v) });

  const ai = bVis.filter((v) => isAiVisualId(v.id));
  let deleted = 0;
  for (const v of ai) {
    const now = aById.get(v.id);
    if (!now) {
      deleted++;
      out.push({ tag: "REJECTED_TEMPLATE", rawFeedback: `Deleted AI ${templateWords(v.template)} at ${secs(v.start)}${tw}`, context: base(v) });
      continue;
    }
    const changes: string[] = [];
    if (now.template !== v.template) changes.push("template");
    if (stable(now.props) !== stable(v.props)) changes.push("props");
    const bp = v.placement ?? {};
    const ap = now.placement ?? {};
    if ((ap.mode ?? "AUTO") !== (bp.mode ?? "AUTO") || Math.abs((ap.x ?? 0.5) - (bp.x ?? 0.5)) > PLACEMENT_EPS || Math.abs((ap.y ?? 0.3) - (bp.y ?? 0.3)) > PLACEMENT_EPS || Math.abs((ap.scale ?? 1) - (bp.scale ?? 1)) > PLACEMENT_EPS) changes.push("placement");
    if (Math.abs(now.start - v.start) > 0.05 || Math.abs(now.end - v.end) > 0.05) changes.push("timing");
    if ((now.depth ?? "FRONT") !== (v.depth ?? "FRONT")) changes.push("depth");
    if ((now.palette ?? "BRAND") !== (v.palette ?? "BRAND")) changes.push("palette");
    if ((now.enter ?? "AUTO") !== (v.enter ?? "AUTO") || (now.exit ?? "AUTO") !== (v.exit ?? "AUTO")) changes.push("transitions");
    if ((now.enterSfx ?? null) !== (v.enterSfx ?? null)) changes.push("sound");
    if (changes.length === 0) {
      if (ctx.beforeWasAiDesign) out.push({ tag: "ACCEPTED_TEMPLATE", rawFeedback: `Kept AI ${templateWords(v.template)} at ${secs(v.start)} as designed${tw}`, context: base(v) });
      continue;
    }
    if (changes.includes("template")) {
      out.push({ tag: "SWAPPED_TEMPLATE", rawFeedback: `Changed AI ${templateWords(v.template)} at ${secs(v.start)} into a ${templateWords(now.template)}${tw}`, context: { ...base(v), from: v.template, to: now.template } });
    }
    out.push({ tag: "ADJUSTED_TEMPLATE", rawFeedback: `Edited AI ${templateWords(v.template)} at ${secs(v.start)} (${changes.join(", ")})${tw}`, context: { ...base(v), changes } });
  }

  // Signals that hold for ANY visual (AI or his own): length, depth, sound.
  for (const v of bVis) {
    const now = aById.get(v.id);
    if (!now) continue;
    const d0 = v.end - v.start;
    const d1 = now.end - now.start;
    if (Math.abs(d1 - d0) >= DURATION_ABS && Math.abs(d1 - d0) / Math.max(0.1, d0) >= DURATION_REL) {
      const shorter = d1 < d0;
      out.push({
        tag: shorter ? "SHORTER_ANIMATIONS" : "LONGER_ANIMATIONS",
        rawFeedback: `${shorter ? "Trimmed" : "Extended"} ${isAiVisualId(v.id) ? "AI " : ""}${templateWords(v.template)} at ${secs(v.start)} from ${secs(d0)} to ${secs(d1)}${tw}`,
        context: { ...base(v), fromSeconds: Math.round(d0 * 100) / 100, toSeconds: Math.round(d1 * 100) / 100 },
      });
    }
    const dep0 = v.depth ?? "FRONT";
    const dep1 = now.depth ?? "FRONT";
    if (dep0 !== dep1) {
      const behind = dep1 === "BEHIND_SUBJECT";
      out.push({ tag: behind ? "MORE_BEHIND_HEAD" : "LESS_BEHIND_HEAD", rawFeedback: `Moved ${templateWords(v.template)} at ${secs(v.start)} ${behind ? "behind" : "in front of"} his head${tw}`, context: base(v) });
    }
    if (v.enterSfx && !now.enterSfx) {
      out.push({ tag: "LESS_SOUND", rawFeedback: `Silenced the ${v.enterSfx.toLowerCase()} on ${templateWords(v.template)} at ${secs(v.start)}${tw}`, context: { ...base(v), sound: v.enterSfx } });
    }
  }

  for (const v of aVis) {
    if (bById.has(v.id)) continue;
    out.push({ tag: "ADDED_TEMPLATE", rawFeedback: `Added a ${templateWords(v.template)} at ${secs(v.start)} himself${tw}`, context: base(v) });
  }

  const aSfx = new Set((after?.sfx ?? []).map((s) => s.id));
  const removedSfx = (before?.sfx ?? []).filter((s) => !aSfx.has(s.id));
  if (removedSfx.length) {
    out.push({ tag: "LESS_SOUND", rawFeedback: `Removed ${removedSfx.length} sound effect${removedSfx.length > 1 ? "s" : ""}${tw}`, context: { topic: ctx.topic, removed: removedSfx.length, sounds: removedSfx.map((s) => s.sound ?? null) } });
  }

  if (ai.length >= 2 && deleted >= 2 && deleted / ai.length >= 0.4) {
    out.push({ tag: "TOO_BUSY", rawFeedback: `Deleted ${deleted} of ${ai.length} AI graphics in one pass${tw}`, context: { topic: ctx.topic, deleted, total: ai.length } });
  }

  const t0 = before?.motionTheme ?? null;
  const t1 = after?.motionTheme ?? null;
  if (t1 && stable(pickTheme(t0)) !== stable(pickTheme(t1))) {
    const what = [
      t0?.motionLanguage !== t1.motionLanguage ? `${(t1.motionLanguage ?? "?").toLowerCase()} motion` : null,
      t0?.iconStyle !== t1.iconStyle ? `${(t1.iconStyle ?? "?").toLowerCase().replace(/_/g, " ")} icons` : null,
      t0?.primary !== t1.primary || t0?.secondary !== t1.secondary ? "new colors" : null,
    ].filter(Boolean);
    out.push({
      tag: "PREFERS_THEME",
      rawFeedback: `Changed the motion theme${t0?.name ? ` from "${t0.name}"` : ""} to "${t1.name ?? "custom"}" (${what.join(", ") || "tweaked"})${tw}`,
      context: { topic: ctx.topic, from: pickTheme(t0), to: pickTheme(t1) },
    });
  }
  return out;
}

function pickTheme(t: MotionThemeLike | null | undefined) {
  if (!t) return null;
  return { name: t.name ?? null, motionLanguage: t.motionLanguage ?? null, iconStyle: t.iconStyle ?? null, primary: t.primary ?? null, secondary: t.secondary ?? null };
}

/**
 * Persists one save's motion signals as TasteFeedback (artifactType MOTION_GRAPHIC).
 * Idempotent per `planId` (the saved version): a retry of the same save records nothing new.
 * Never throws for a bad diff input — learning must not break saving (callers still wrap it).
 */
export async function recordMotionEditSignals(
  prisma: PrismaClient,
  input: {
    contentItemId: string;
    before: MotionTimelineLike | null | undefined;
    after: MotionTimelineLike | null | undefined;
    actorId: string;
    /** The NEW EditPlan version the save created (idempotency key). */
    planId?: string | null;
    beforeWasAiDesign?: boolean;
  },
): Promise<{ recorded: number; topic: MotionTopic; signals: MotionEditSignal[] }> {
  const item = await prisma.contentItem.findUnique({ where: { id: input.contentItemId }, select: { title: true, description: true, pillar: true } });
  const { topic } = classifyMotionTopic({ title: item?.title, description: item?.description, pillar: item?.pillar });
  const signals = diffMotionEdits(input.before, input.after, { topic, beforeWasAiDesign: input.beforeWasAiDesign });
  if (signals.length === 0) return { recorded: 0, topic, signals };
  if (input.planId) {
    const existing = await prisma.tasteFeedback.count({
      where: { artifactType: MOTION_GRAPHIC_ARTIFACT, contentItemId: input.contentItemId, context: { path: ["planId"], equals: input.planId } },
    });
    if (existing > 0) return { recorded: 0, topic, signals };
  }
  const plan = await prisma.editPlan.findFirst({ where: { contentItemId: input.contentItemId }, orderBy: { createdAt: "desc" }, select: { productionTier: true } });
  await prisma.tasteFeedback.createMany({
    data: signals.map((s) => ({
      contentItemId: input.contentItemId,
      artifactType: MOTION_GRAPHIC_ARTIFACT,
      rawFeedback: s.rawFeedback.slice(0, 500),
      normalizedTag: s.tag,
      productionTier: plan?.productionTier ?? null,
      context: { ...s.context, planId: input.planId ?? null, source: "EDITOR_DIFF" } as never,
    })),
  });
  await recordAudit(prisma, {
    actor: input.actorId,
    actorType: "HUMAN",
    action: "MOTION_TASTE_SIGNALS_RECORDED",
    entityType: "ContentItem",
    entityId: input.contentItemId,
    after: { planId: input.planId ?? null, topic, tags: signals.map((s) => s.tag) },
  });
  return { recorded: signals.length, topic, signals };
}

// ------------------------------------------------------------------------------- profile

export interface MotionTasteRow {
  normalizedTag: string;
  rawFeedback?: string;
  contentItemId: string | null;
  context: unknown;
  createdAt: Date;
}

export type MotionPreferenceStrength = "STRONG" | "WEAK";

export interface MotionPreference {
  /** Stable key, e.g. "AVOID_TEMPLATE:BAR_CHART", "THEME:INVESTING:CINEMATIC". */
  key: string;
  kind: "AVOID_TEMPLATE" | "FAVOR_TEMPLATE" | "PREFERS_3D" | "AVOIDS_3D" | "FEWER_VISUALS" | "SHORTER_ANIMATIONS" | "LONGER_ANIMATIONS" | "MORE_BEHIND_HEAD" | "LESS_SOUND" | "THEME_LANGUAGE" | "ICON_STYLE";
  /** Human sentence for Chris and the designer. */
  label: string;
  strength: MotionPreferenceStrength;
  /** 0..1 */
  confidence: number;
  /** Supporting signals (after "forget"), and distinct videos they came from. */
  evidenceCount: number;
  videoCount: number;
  /** Recency-weighted support vs. contradiction. */
  support: number;
  opposition: number;
  /** "ALL" only when the evidence spans >= 2 topics; else the one topic it was seen on. */
  scope: "ALL" | MotionTopic;
  template?: string;
  value?: string;
  lastSeenAt: Date;
}

export interface MotionTasteProfile {
  preferences: MotionPreference[];
  /** Total MOTION_GRAPHIC signals considered (after forgets). */
  signalCount: number;
  generatedAt: Date;
}

/** Recency half-life: a signal from 45 days ago counts half. */
export const MOTION_TASTE_HALF_LIFE_DAYS = 45;
export const STRONG_MIN_SIGNALS = 3;
export const STRONG_MIN_VIDEOS = 2;
export const STRONG_MIN_CONSISTENCY = 0.7;
export const WEAK_MIN_CONSISTENCY = 0.6;

interface Acc {
  kind: MotionPreference["kind"];
  template?: string;
  value?: string;
  topicScoped?: MotionTopic;
  support: number;
  opposition: number;
  count: number;
  videos: Set<string>;
  topics: Set<string>;
  last: number;
}

function ctxOf(row: MotionTasteRow): Record<string, unknown> {
  return row.context && typeof row.context === "object" ? (row.context as Record<string, unknown>) : {};
}

/**
 * PURE: Chris's motion taste from MOTION_GRAPHIC TasteFeedback rows (any order).
 * Thresholds: STRONG = >= 3 supporting signals from >= 2 videos with >= 70% recency-weighted
 * consistency; WEAK = consistency >= 60%; contradicted preferences are dropped. A FORGET row
 * for a key discards that key's evidence up to the moment Chris pressed "forget".
 */
export function buildMotionTasteProfile(rows: MotionTasteRow[], now: Date = new Date()): MotionTasteProfile {
  const forgetAt = new Map<string, number>();
  for (const r of rows) {
    if (r.normalizedTag !== "FORGET") continue;
    const key = ctxOf(r).key;
    if (typeof key === "string") forgetAt.set(key, Math.max(forgetAt.get(key) ?? 0, r.createdAt.getTime()));
  }
  const acc = new Map<string, Acc>();
  const get = (key: string, init: Omit<Acc, "support" | "opposition" | "count" | "videos" | "topics" | "last">) => {
    let a = acc.get(key);
    if (!a) {
      a = { ...init, support: 0, opposition: 0, count: 0, videos: new Set(), topics: new Set(), last: 0 };
      acc.set(key, a);
    }
    return a;
  };
  let considered = 0;
  const nowMs = now.getTime();
  for (const r of rows) {
    if (r.normalizedTag === "FORGET") continue;
    const c = ctxOf(r);
    const t = r.createdAt.getTime();
    const w = Math.pow(0.5, Math.max(0, nowMs - t) / (MOTION_TASTE_HALF_LIFE_DAYS * 86400000));
    const topic = typeof c.topic === "string" ? c.topic : "GENERAL";
    const template = typeof c.template === "string" ? c.template : undefined;
    const threeD = c.threeD === true;
    let used = false;
    const hit = (key: string, init: Omit<Acc, "support" | "opposition" | "count" | "videos" | "topics" | "last">, dir: "support" | "oppose", k = 1) => {
      if ((forgetAt.get(key) ?? -1) >= t) return;
      used = true;
      const a = get(key, init);
      if (dir === "support") {
        a.support += w * k;
        a.count++;
        if (r.contentItemId) a.videos.add(r.contentItemId);
        a.topics.add(topic);
        a.last = Math.max(a.last, t);
      } else a.opposition += w * k;
    };
    switch (r.normalizedTag) {
      case "REJECTED_TEMPLATE":
        if (template) {
          hit(`AVOID_TEMPLATE:${template}`, { kind: "AVOID_TEMPLATE", template }, "support");
          hit(`FAVOR_TEMPLATE:${template}`, { kind: "FAVOR_TEMPLATE", template }, "oppose");
        }
        if (threeD) {
          hit("AVOIDS_3D", { kind: "AVOIDS_3D" }, "support");
          hit("PREFERS_3D", { kind: "PREFERS_3D" }, "oppose");
        }
        break;
      case "ACCEPTED_TEMPLATE":
      case "ADDED_TEMPLATE": {
        const k = r.normalizedTag === "ADDED_TEMPLATE" ? 1.5 : 0.75;
        if (template) {
          hit(`FAVOR_TEMPLATE:${template}`, { kind: "FAVOR_TEMPLATE", template }, "support", k);
          hit(`AVOID_TEMPLATE:${template}`, { kind: "AVOID_TEMPLATE", template }, "oppose", k);
        }
        if (threeD) {
          hit("PREFERS_3D", { kind: "PREFERS_3D" }, "support", k);
          hit("AVOIDS_3D", { kind: "AVOIDS_3D" }, "oppose", k);
        }
        if (r.normalizedTag === "ADDED_TEMPLATE") hit("FEWER_VISUALS", { kind: "FEWER_VISUALS" }, "oppose", 0.5);
        break;
      }
      case "SWAPPED_TEMPLATE": {
        const from = typeof c.from === "string" ? c.from : undefined;
        const to = typeof c.to === "string" ? c.to : undefined;
        if (from) hit(`AVOID_TEMPLATE:${from}`, { kind: "AVOID_TEMPLATE", template: from }, "support", 0.75);
        if (to) hit(`FAVOR_TEMPLATE:${to}`, { kind: "FAVOR_TEMPLATE", template: to }, "support", 0.75);
        break;
      }
      case "TOO_BUSY":
        hit("FEWER_VISUALS", { kind: "FEWER_VISUALS" }, "support");
        break;
      case "SHORTER_ANIMATIONS":
        hit("SHORTER_ANIMATIONS", { kind: "SHORTER_ANIMATIONS" }, "support");
        hit("LONGER_ANIMATIONS", { kind: "LONGER_ANIMATIONS" }, "oppose");
        break;
      case "LONGER_ANIMATIONS":
        hit("LONGER_ANIMATIONS", { kind: "LONGER_ANIMATIONS" }, "support");
        hit("SHORTER_ANIMATIONS", { kind: "SHORTER_ANIMATIONS" }, "oppose");
        break;
      case "MORE_BEHIND_HEAD":
        hit("MORE_BEHIND_HEAD", { kind: "MORE_BEHIND_HEAD" }, "support");
        break;
      case "LESS_BEHIND_HEAD":
        hit("MORE_BEHIND_HEAD", { kind: "MORE_BEHIND_HEAD" }, "oppose");
        break;
      case "LESS_SOUND":
        hit("LESS_SOUND", { kind: "LESS_SOUND" }, "support");
        break;
      case "PREFERS_THEME": {
        const to = (c.to ?? null) as MotionThemeLike | null;
        const from = (c.from ?? null) as MotionThemeLike | null;
        const tp = topic as MotionTopic;
        if (to?.motionLanguage && to.motionLanguage !== from?.motionLanguage) {
          hit(`THEME:${tp}:${to.motionLanguage}`, { kind: "THEME_LANGUAGE", value: to.motionLanguage, topicScoped: tp }, "support");
          if (from?.motionLanguage) hit(`THEME:${tp}:${from.motionLanguage}`, { kind: "THEME_LANGUAGE", value: from.motionLanguage, topicScoped: tp }, "oppose");
        }
        if (to?.iconStyle && to.iconStyle !== from?.iconStyle) {
          hit(`ICON_STYLE:${to.iconStyle}`, { kind: "ICON_STYLE", value: to.iconStyle }, "support");
          if (from?.iconStyle) hit(`ICON_STYLE:${from.iconStyle}`, { kind: "ICON_STYLE", value: from.iconStyle }, "oppose");
        }
        break;
      }
    }
    if (used) considered++;
  }

  const preferences: MotionPreference[] = [];
  for (const [key, a] of acc) {
    if (a.count === 0 || a.support <= 0) continue;
    const consistency = a.support / (a.support + a.opposition);
    if (consistency < WEAK_MIN_CONSISTENCY) continue;
    const strong = a.count >= STRONG_MIN_SIGNALS && a.videos.size >= STRONG_MIN_VIDEOS && consistency >= STRONG_MIN_CONSISTENCY;
    const scope: MotionPreference["scope"] = a.topicScoped ?? (a.topics.size >= 2 ? "ALL" : ((([...a.topics][0] ?? "GENERAL") as MotionTopic)));
    const confidence = Math.min(0.95, consistency * (1 - Math.exp(-a.support / 2.5)) * (a.videos.size >= 2 ? 1 : 0.6));
    preferences.push({
      key,
      kind: a.kind,
      label: preferenceLabel(a),
      strength: strong ? "STRONG" : "WEAK",
      confidence: Math.round(confidence * 100) / 100,
      evidenceCount: a.count,
      videoCount: a.videos.size,
      support: Math.round(a.support * 100) / 100,
      opposition: Math.round(a.opposition * 100) / 100,
      scope,
      template: a.template,
      value: a.value,
      lastSeenAt: new Date(a.last),
    });
  }
  preferences.sort((x, y) => (x.strength === y.strength ? y.confidence - x.confidence : x.strength === "STRONG" ? -1 : 1));
  return { preferences, signalCount: considered, generatedAt: now };
}

function preferenceLabel(a: Acc): string {
  const t = a.template ? templateWords(a.template) : "";
  switch (a.kind) {
    case "AVOID_TEMPLATE":
      return `Avoid ${t}s`;
    case "FAVOR_TEMPLATE":
      return `Likes ${t}s`;
    case "PREFERS_3D":
      return "Prefers 3D graphics";
    case "AVOIDS_3D":
      return "Prefers flat graphics over 3D";
    case "FEWER_VISUALS":
      return "Fewer graphics per video";
    case "SHORTER_ANIMATIONS":
      return "Shorter graphics";
    case "LONGER_ANIMATIONS":
      return "Longer-held graphics";
    case "MORE_BEHIND_HEAD":
      return "Text/graphics behind his head";
    case "LESS_SOUND":
      return "Fewer sound effects";
    case "THEME_LANGUAGE":
      return `${(a.value ?? "").charAt(0)}${(a.value ?? "").slice(1).toLowerCase()} motion for ${(a.topicScoped ?? "GENERAL").toLowerCase()} videos`;
    case "ICON_STYLE":
      return `${(a.value ?? "").toLowerCase().replace(/_/g, " ")} icon style`;
  }
}

/** What the Motion Designer gets: a compact text block + the few deterministic levers that
 * STRONG, in-scope preferences are allowed to pull (cap -1, avoid-list for cuts). */
export interface MotionTasteForDesign {
  context: string | null;
  capDelta: number;
  avoidTemplates: string[];
  preferTemplates: string[];
  profile: MotionTasteProfile;
}

function inScope(p: MotionPreference, topic: MotionTopic | null | undefined): boolean {
  return p.scope === "ALL" || !topic || p.scope === topic;
}

/** PURE: the designer's view of a profile for one video's topic. */
export function motionTasteForDesign(profile: MotionTasteProfile, topic?: MotionTopic | null, maxLines = 8): MotionTasteForDesign {
  // Topic-scoped evidence only speaks for its own topic (a debt-video habit says nothing
  // about lifestyle videos).
  const relevant = profile.preferences.filter((p) => inScope(p, topic));
  const lines = relevant.slice(0, maxLines).map((p) => {
    const where = p.scope === "ALL" ? "" : ` (seen on ${p.scope.toLowerCase()} videos only)`;
    return `- ${p.strength}: ${p.label}${where} — ${p.evidenceCount} edit${p.evidenceCount === 1 ? "" : "s"} across ${p.videoCount} video${p.videoCount === 1 ? "" : "s"}, confidence ${p.confidence.toFixed(2)}`;
  });
  const strong = relevant.filter((p) => p.strength === "STRONG");
  return {
    context: lines.length
      ? `Learned from Chris's own edits (STRONG = consistent across >= ${STRONG_MIN_VIDEOS} videos: follow it unless this moment clearly needs otherwise; WEAK = a hint from few edits — do NOT treat it as a rule):\n${lines.join("\n")}`
      : null,
    capDelta: strong.some((p) => p.kind === "FEWER_VISUALS") ? -1 : 0,
    avoidTemplates: strong.filter((p) => p.kind === "AVOID_TEMPLATE" && p.template).map((p) => p.template!),
    preferTemplates: strong.filter((p) => p.kind === "FAVOR_TEMPLATE" && p.template).map((p) => p.template!),
    profile,
  };
}

const PROFILE_ROW_LIMIT = 500;

export async function listMotionTasteRows(prisma: PrismaClient, limit = PROFILE_ROW_LIMIT): Promise<MotionTasteRow[]> {
  const rows = await prisma.tasteFeedback.findMany({
    where: { artifactType: MOTION_GRAPHIC_ARTIFACT },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: { normalizedTag: true, rawFeedback: true, contentItemId: true, context: true, createdAt: true },
  });
  return rows;
}

export async function getMotionTasteProfile(prisma: PrismaClient, now: Date = new Date()): Promise<MotionTasteProfile> {
  return buildMotionTasteProfile(await listMotionTasteRows(prisma), now);
}

/** Compact text block for prompts (null when nothing has been learned yet). */
export async function getMotionTasteContext(prisma: PrismaClient, opts: { topic?: MotionTopic | null; now?: Date } = {}): Promise<string | null> {
  return motionTasteForDesign(await getMotionTasteProfile(prisma, opts.now), opts.topic).context;
}

export async function getMotionTasteForDesign(prisma: PrismaClient, topic?: MotionTopic | null, now: Date = new Date()): Promise<MotionTasteForDesign> {
  return motionTasteForDesign(await getMotionTasteProfile(prisma, now), topic);
}

/** "Forget this": a counter-signal row (the evidence stays — audit trails are permanent). */
export async function forgetMotionPreference(prisma: PrismaClient, input: { key: string; label?: string | null; actorId: string }) {
  const row = await prisma.tasteFeedback.create({
    data: {
      artifactType: MOTION_GRAPHIC_ARTIFACT,
      normalizedTag: "FORGET",
      rawFeedback: `Chris asked to forget: ${input.label ?? input.key}`.slice(0, 500),
      context: { key: input.key, source: "LEARNINGS_PAGE" },
    },
  });
  await recordAudit(prisma, {
    actor: input.actorId,
    actorType: "HUMAN",
    action: "MOTION_TASTE_FORGOTTEN",
    entityType: "TasteFeedback",
    entityId: row.id,
    after: { key: input.key },
  });
  return row;
}
