import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, extname } from "node:path";
import {
  buildStarterPlan,
  getFinishedRecordingSequence,
  getLatestEditPlan,
  getReferenceStyleProfile,
  hasOpenRecordingDraft,
  parseTranscriptWords,
  readStarterSequence,
  readStoredStyleCut,
  recordAutoStyleCut,
  saveStyleCutChoice,
  autoStyleCutEligibility,
  type PrismaClient,
  type StoredStyleCut,
} from "@chris/domain";
import { EditPlanOutputSchema } from "@chris/agents";
import {
  buildStyleCut,
  detectSilences,
  EditTimelineSchema,
  parseSubjectTrack,
  planToTimeline,
  styleCutTargetFromProfile,
  timelineDuration,
  type EditTimeline,
  type StorageAdapter,
  type StyleCutResult,
} from "@chris/media";
import { timelineForPlan } from "./render-job";

/**
 * Style cut glue (docs/decisions-pending/style-cut.md): loads the selected take's word timings,
 * face track and measured silences + the reference style profile, runs the PURE
 * `buildStyleCut` (packages/media), and records the result through the domain's append-only
 * edit-plan functions. Zero model calls.
 *
 * A video recorded in PARTS with the teleprompter (docs/decisions-pending/
 * segmented-recording-drafts.md) is cut as the ordered list of its parts — each part trimmed
 * and de-paused on its own, joined in order. Never while the recording is still a draft.
 */

export type StyleCutOutcome =
  | { status: "APPLIED"; editPlanId: string; summary: string; profileNote: string }
  | { status: "SKIPPED"; reason: string };

interface LoadedTake {
  id: string;
  durationSeconds: number;
  words: ReturnType<typeof parseTranscriptWords>;
  subjectTrack: ReturnType<typeof parseSubjectTrack>;
  width: number | null;
  height: number | null;
  storageKey: string;
  originalFilename: string;
}

interface Loaded {
  item: { id: string; currentState: string };
  latest: NonNullable<Awaited<ReturnType<typeof getLatestEditPlan>>>;
  /** The selected take (the first part of a multi-part recording). */
  take: LoadedTake;
  /** Every part, in order (just [take] for an ordinary one-take video). */
  takes: LoadedTake[];
  current: EditTimeline;
}

function toLoadedTake(asset: {
  id: string;
  durationSeconds: number | null;
  transcriptWords: unknown;
  subjectTrack: unknown;
  width: number | null;
  height: number | null;
  storageKey: string;
  originalFilename: string;
}): LoadedTake {
  return {
    id: asset.id,
    durationSeconds: asset.durationSeconds ?? 0,
    words: parseTranscriptWords(asset.transcriptWords),
    subjectTrack: parseSubjectTrack(asset.subjectTrack),
    width: asset.width,
    height: asset.height,
    storageKey: asset.storageKey,
    originalFilename: asset.originalFilename,
  };
}

/** The parts of a multi-part recording this plan edits, in order — from the plan's `sequence`,
 * else the video's finished recording when the selected take is one of its parts. */
async function sequenceIds(db: PrismaClient, contentItemId: string, plan: unknown, selectedId: string): Promise<string[] | null> {
  const seq = readStarterSequence(plan);
  if (seq) return seq.takes.map((t) => t.mediaAssetId);
  const rec = await getFinishedRecordingSequence(db, contentItemId);
  if (rec && rec.mediaAssetIds.length > 1 && rec.mediaAssetIds.includes(selectedId)) return rec.mediaAssetIds;
  return null;
}

async function load(db: PrismaClient, contentItemId: string): Promise<Loaded | { error: string }> {
  const item = await db.contentItem.findUniqueOrThrow({ where: { id: contentItemId }, select: { id: true, currentState: true } });
  const latest = await getLatestEditPlan(db, contentItemId);
  if (!latest) return { error: "There's no edit yet." };
  const sel = await db.takeSelection.findUnique({ where: { id: latest.takeSelectionId }, select: { selectedMediaAssetId: true } });
  const ids = sel ? await sequenceIds(db, contentItemId, latest.plan, sel.selectedMediaAssetId) : null;
  let takes: LoadedTake[];
  if (ids) {
    const assets = await db.mediaAsset.findMany({ where: { id: { in: ids } } });
    takes = ids
      .map((id) => assets.find((a) => a.id === id))
      .filter((a): a is (typeof assets)[number] => !!a && (a.durationSeconds ?? 0) > 0)
      .map(toLoadedTake);
    if (takes.length === 0) return { error: "The footage isn't ready yet." };
  } else {
    const asset = sel ? await db.mediaAsset.findUnique({ where: { id: sel.selectedMediaAssetId } }) : null;
    if (!asset || !(asset.durationSeconds && asset.durationSeconds > 0)) return { error: "The footage isn't ready yet." };
    takes = [toLoadedTake(asset)];
  }
  const take = takes[0]!;
  let current: EditTimeline;
  try {
    const parsed = EditPlanOutputSchema.safeParse(latest.plan);
    const raw = (latest.plan ?? {}) as Record<string, unknown>;
    if (raw.timeline == null && !parsed.success) throw new Error("unparseable plan");
    current = timelineForPlan(latest.plan, parsed.success ? parsed.data : (undefined as never), {
      selectedMediaAssetId: take.id,
      sourceWordsAvailable: takes.some((t) => !!t.words?.length),
      sourceDimensions: take.width && take.height ? { width: take.width, height: take.height } : null,
    }).timeline;
  } catch {
    current = plainTimeline(takes);
  }
  return { item, latest, take, takes, current };
}

/** Every take whole, in order, with the house captions (what the starter edit renders). */
function plainTimeline(takes: LoadedTake[], keepLookFrom?: EditTimeline): EditTimeline {
  const first = takes[0]!;
  const hasWords = takes.some((t) => !!t.words?.length);
  const plan = buildStarterPlan({ durationSeconds: first.durationSeconds, productionTier: "FAST", takeCount: 1 });
  const t = planToTimeline(plan, { mediaAssetId: first.id, sourceWordsAvailable: hasWords });
  if (takes.length > 1) {
    t.clips = takes.map((k, i) => ({ id: `clip-${i + 1}`, mediaAssetId: k.id, sourceStart: 0, sourceEnd: k.durationSeconds, crop: { zoom: 1, panX: 0, panY: 0 }, volume: 1 }));
  }
  if (!keepLookFrom) return t;
  return EditTimelineSchema.parse({
    ...t,
    captions: { ...keepLookFrom.captions, enabled: hasWords },
    grade: keepLookFrom.grade,
    audio: keepLookFrom.audio,
    motionTheme: keepLookFrom.motionTheme,
  });
}

/** Silences measured earlier for this take (cached on a previous style-cut plan), else measured now. */
async function silencesFor(db: PrismaClient, storage: StorageAdapter, contentItemId: string, take: LoadedTake, measure = true) {
  const plans = await db.editPlan.findMany({ where: { contentItemId }, orderBy: { createdAt: "desc" }, take: 30, select: { plan: true } });
  for (const p of plans) {
    const sc = readStoredStyleCut(p.plan);
    if (!sc) continue;
    const byAsset = sc.silencesByAsset?.[take.id];
    if (Array.isArray(byAsset)) return byAsset;
    if (sc.mediaAssetId === take.id && Array.isArray(sc.silences)) return sc.silences;
  }
  if (!measure) return null;
  const dir = await mkdtemp(join(tmpdir(), "chris-stylecut-"));
  try {
    const file = join(dir, `take${extname(take.originalFilename) || ".mp4"}`);
    await writeFile(file, await storage.get(take.storageKey));
    return (await detectSilences(file)).silences;
  } catch (err) {
    console.warn("[style-cut] silence detection failed — using word timings only:", err instanceof Error ? err.message : err);
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function compute(db: PrismaClient, storage: StorageAdapter, contentItemId: string, l: Loaded, measure = true): Promise<{ r: StyleCutResult; stored: StoredStyleCut | null }> {
  if (!l.takes.some((t) => t.words?.length)) {
    return { r: { ok: false, reason: "NO_TRANSCRIPT", message: "Style cut needs captions first — they appear once your words are transcribed." }, stored: null };
  }
  const profile = await getReferenceStyleProfile(db, { group: "MAIN" });
  const target = styleCutTargetFromProfile(profile);
  const sizeOf = (t: LoadedTake) => (t.width && t.height ? { width: t.width, height: t.height } : null);

  if (l.takes.length > 1) {
    const silencesByAsset: Record<string, Array<{ start: number; end: number }> | null> = {};
    for (const t of l.takes) silencesByAsset[t.id] = t.words?.length ? await silencesFor(db, storage, contentItemId, t, measure) : null;
    const r = buildStyleCut({
      base: l.current,
      takes: l.takes.map((t) => ({
        mediaAssetId: t.id,
        words: t.words,
        durationSeconds: t.durationSeconds,
        subjectTrack: t.subjectTrack,
        sourceSize: sizeOf(t),
        silences: silencesByAsset[t.id] ?? null,
      })),
      target,
    });
    if (!r.ok) return { r, stored: null };
    const stored: StoredStyleCut = {
      version: r.version,
      origin: "AUTO",
      inputsKey: r.inputsKey,
      summary: r.summary,
      profileNote: r.profileNote,
      stats: { ...r.stats },
      target: { ...r.target },
      silences: null,
      silencesByAsset,
      mediaAssetId: l.take.id,
      mediaAssetIds: l.takes.map((t) => t.id),
    };
    return { r, stored };
  }

  const silences = await silencesFor(db, storage, contentItemId, l.take, measure);
  const r = buildStyleCut({
    base: l.current,
    mediaAssetId: l.take.id,
    words: l.take.words,
    durationSeconds: l.take.durationSeconds,
    subjectTrack: l.take.subjectTrack,
    sourceSize: sizeOf(l.take),
    silences,
    target,
  });
  if (!r.ok) return { r, stored: null };
  const stored: StoredStyleCut = {
    version: r.version,
    origin: "AUTO",
    inputsKey: r.inputsKey,
    summary: r.summary,
    profileNote: r.profileNote,
    stats: { ...r.stats },
    target: { ...r.target },
    silences,
    mediaAssetId: l.take.id,
  };
  return { r, stored };
}

/**
 * Automatic: after captions (or the face track) land, replace an UNTOUCHED starter edit (or an
 * earlier automatic style cut whose inputs changed) with a style cut. Never touches anything
 * Chris saved. Idempotent; safe to call from several places. Never throws — a failure just
 * leaves the plain starter edit in place. Skipped while the video's recording is a draft.
 */
export async function maybeAutoStyleCut(
  db: PrismaClient,
  storage: StorageAdapter,
  contentItemId: string,
  actor: { actorId: string },
  options: { measureSilences?: boolean } = {},
): Promise<StyleCutOutcome> {
  try {
    if (process.env.STYLE_CUT_AUTO === "off") return { status: "SKIPPED", reason: "Automatic style cut is turned off (STYLE_CUT_AUTO=off)." };
    if (await hasOpenRecordingDraft(db, contentItemId)) return { status: "SKIPPED", reason: "Still a draft — the style cut runs when you finish filming." };
    const l = await load(db, contentItemId);
    if ("error" in l) return { status: "SKIPPED", reason: l.error };
    const elig = autoStyleCutEligibility(l.item.currentState as never, l.latest);
    if (!elig.eligible) return { status: "SKIPPED", reason: elig.reason };
    // The auto cut always starts from the plain take's look (the latest is untouched anyway).
    const base = { ...l, current: elig.replaces === "STARTER" ? plainTimeline(l.takes) : l.current };
    const { r, stored } = await compute(db, storage, contentItemId, base, options.measureSilences ?? true);
    if (!r.ok || !stored) return { status: "SKIPPED", reason: r.ok ? "Nothing to do." : r.message };
    const row = await recordAutoStyleCut(
      db,
      { contentItemId, expectedLatestPlanId: l.latest.id, timeline: r.timeline, durationSeconds: timelineDuration(r.timeline), styleCut: stored },
      actor,
    );
    if (!row) return { status: "SKIPPED", reason: "Already up to date." };
    return { status: "APPLIED", editPlanId: row.id, summary: r.summary, profileNote: r.profileNote };
  } catch (err) {
    console.warn("[style-cut] automatic style cut failed:", err instanceof Error ? err.message : err);
    return { status: "SKIPPED", reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The editor's buttons. STYLE = re-apply the style cut (keeps the current caption style/look);
 * PLAIN = back to the whole take (every part whole, in order, for a multi-part recording).
 * Each is a new saved version (undo-able in the editor).
 */
export async function applyStyleCutChoice(
  db: PrismaClient,
  storage: StorageAdapter,
  contentItemId: string,
  mode: "STYLE" | "PLAIN",
  actorId: string,
): Promise<{ ok: true; editPlanId: string; timeline: EditTimeline; summary: string | null; profileNote: string | null } | { ok: false; error: string }> {
  const l = await load(db, contentItemId);
  if ("error" in l) return { ok: false, error: l.error };
  if (mode === "PLAIN") {
    const timeline = plainTimeline(l.takes, l.current);
    const row = await saveStyleCutChoice(db, { contentItemId, timeline, durationSeconds: timelineDuration(timeline), actorId, styleCut: null });
    return { ok: true, editPlanId: row.id, timeline, summary: null, profileNote: null };
  }
  const { r, stored } = await compute(db, storage, contentItemId, l);
  if (!r.ok || !stored) return { ok: false, error: r.ok ? "Couldn't make the style cut." : r.message };
  const row = await saveStyleCutChoice(db, { contentItemId, timeline: r.timeline, durationSeconds: timelineDuration(r.timeline), actorId, styleCut: stored });
  return { ok: true, editPlanId: row.id, timeline: r.timeline, summary: r.summary, profileNote: r.profileNote };
}
