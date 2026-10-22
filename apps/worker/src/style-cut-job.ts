import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, extname } from "node:path";
import {
  buildStarterPlan,
  getFinishedRecordingSequence,
  getLatestEditPlan,
  getReferenceStyleProfile,
  getStyleModel,
  editorDigest,
  hasOpenRecordingDraft,
  parseTranscriptWords,
  readStarterSequence,
  readStoredStyleCut,
  readStoredFullEdit,
  recordAutoStyleCut,
  recordAutoFullEdit,
  saveStyleCutChoice,
  saveFullEditChoice,
  autoStyleCutEligibility,
  getAutoEditMode,
  type AutoEditMode,
  type PrismaClient,
  type StoredStyleCut,
  type StoredFullEdit,
  getLatestCreativeBrief,
  creativeBriefTextFor,
  uploadToReadyLatency,
  READY_BUDGET_MINUTES,
  isHandEditReason,
  type StyleModel,
} from "@chris/domain";
import { EditPlanOutputSchema, getBrandContextText, runEditorAgent, scopeProvider, type ModelProvider } from "@chris/agents";
import {
  analyzeTakeAudio,
  buildFullEdit,
  buildStyleCut,
  detectSilences,
  EditTimelineSchema,
  LEXICAL_EMBEDDER,
  nodeMeasureText,
  parseSubjectTrack,
  planToTimeline,
  storyTargetFromProfile,
  styleCutTargetFromProfile,
  timelineDuration,
  type EditTimeline,
  type FullEditChoices,
  type FullEditEmbedder,
  type FullEditReport,
  type GoldenFixture,
  type SpliceAnalysis,
  isSpliceAnalysis,
  type StorageAdapter,
  type StyleCutResult,
  screenStyleFromStyleModel,
  captionDefaultsFromStyleModel,
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
    const fe = readStoredFullEdit(p.plan);
    if (fe && fe.mediaAssetId === take.id && Array.isArray(fe.silences)) return fe.silences;
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

  const audio = await takeAudioFor(db, storage, contentItemId, l.take, measure);
  const silences = audio.silences;
  const r = buildStyleCut({
    base: l.current,
    mediaAssetId: l.take.id,
    words: l.take.words,
    durationSeconds: l.take.durationSeconds,
    subjectTrack: l.take.subjectTrack,
    sourceSize: sizeOf(l.take),
    silences,
    splice: audio.splice,
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
    envelope: audio.envelope,
    splice: audio.splice,
    mediaAssetId: l.take.id,
  };
  return { r, stored };
}

// ---------------------------------------------------------------------------------------
// Full edit (free) — docs/decisions-pending/full-edit.md. $0: local MiniLM sentence
// embeddings (falls back to hashed word stems if the model can't load), deterministic bots.
// ---------------------------------------------------------------------------------------

/** Local MiniLM, degrading to the lexical embedder (and saying so in its id) if it can't load. */
class LocalOrLexicalEmbedder implements FullEditEmbedder {
  private fallback = false;
  private primary: FullEditEmbedder | null = null;
  get id() {
    return this.fallback || !this.primary ? `${LEXICAL_EMBEDDER.id}${this.fallback ? " (local model unavailable)" : ""}` : this.primary.id;
  }
  get thresholds() {
    return this.fallback || !this.primary ? LEXICAL_EMBEDDER.thresholds : this.primary.thresholds;
  }
  async embed(texts: string[]): Promise<number[][]> {
    if (!this.fallback) {
      try {
        if (!this.primary) {
          const { LocalSentenceEmbedder } = await import("@chris/media/embeddings");
          this.primary = new LocalSentenceEmbedder();
        }
        return await this.primary.embed(texts);
      } catch (err) {
        console.warn("[full-edit] local sentence model unavailable — using word overlap:", err instanceof Error ? err.message : err);
        this.fallback = true;
      }
    }
    return LEXICAL_EMBEDDER.embed(texts);
  }
}

let embedderSingleton: FullEditEmbedder | null = null;
/** FULL_EDIT_EMBEDDINGS=lexical forces the model-free embedder (tests, tiny hosts). */
export function fullEditEmbedder(): FullEditEmbedder {
  if (process.env.FULL_EDIT_EMBEDDINGS === "lexical") return LEXICAL_EMBEDDER;
  return (embedderSingleton ??= new LocalOrLexicalEmbedder());
}

/** Silences + loudness envelope of a take: cached on an earlier full edit, else measured now. */
async function takeAudioFor(
  db: PrismaClient,
  storage: StorageAdapter,
  contentItemId: string,
  take: LoadedTake,
  measure: boolean,
): Promise<{ silences: Array<{ start: number; end: number }> | null; envelope: { frameS: number; db: number[] } | null; splice: SpliceAnalysis | null }> {
  const plans = await db.editPlan.findMany({ where: { contentItemId }, orderBy: { createdAt: "desc" }, take: 30, select: { plan: true } });
  for (const p of plans) {
    // Cached on an earlier edit of this take — including the splice engine's analysis (an edit
    // stored before the engine existed has none, so the take is decoded once more).
    const fe = readStoredFullEdit(p.plan);
    if (fe && fe.mediaAssetId === take.id && Array.isArray(fe.silences) && fe.envelope && isSpliceAnalysis(fe.splice)) return { silences: fe.silences, envelope: fe.envelope, splice: fe.splice };
    const sc = readStoredStyleCut(p.plan);
    if (sc && sc.mediaAssetId === take.id && Array.isArray(sc.silences) && sc.envelope && isSpliceAnalysis(sc.splice)) return { silences: sc.silences, envelope: sc.envelope, splice: sc.splice };
  }
  if (!measure) return { silences: await silencesFor(db, storage, contentItemId, take, false), envelope: null, splice: null };
  const dir = await mkdtemp(join(tmpdir(), "chris-fulledit-"));
  try {
    const file = join(dir, `take${extname(take.originalFilename) || ".mp4"}`);
    await writeFile(file, await storage.get(take.storageKey));
    const a = await analyzeTakeAudio(file);
    return { silences: a.silences, envelope: a.envelope, splice: a.splice };
  } catch (err) {
    console.warn("[full-edit] audio analysis failed — using word timings only:", err instanceof Error ? err.message : err);
    return { silences: null, envelope: null, splice: null };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

type FullEditComputed =
  | { ok: true; timeline: EditTimeline; stored: StoredFullEdit; report: FullEditReport }
  | { ok: false; error: string };

/** The free Full edit of the selected take (one-take videos; multi-part recordings get the style cut). */
/** The Creative Brief's hook line and story beats, for the Full edit to match against the take. */
async function briefForFullEdit(db: PrismaClient, contentItemId: string): Promise<{ hook: string | null; keep: string[]; onScreenText: string | null } | null> {
  const b = await getLatestCreativeBrief(db, contentItemId).catch(() => null);
  if (!b) return null;
  const chosen = b.hooks[b.chosenHookIndex] ?? b.hooks[0];
  return { hook: chosen?.text ?? null, keep: [b.story.midpointReversal, b.story.payoff, b.story.ending].filter((t): t is string => !!t), onScreenText: chosen?.onScreenText ?? null };
}

/** The Editor agent as the Full edit's planner (the plan is stored with the edit's choices). */
export function editorPlannerFor(db: PrismaClient, provider: ModelProvider, contentItemId: string, profile: { durationS?: { value: number; n: number; p25: number; p75: number } | null } | null | undefined, styleModel?: StyleModel | null) {
  return async (lines: Array<{ id: number; text: string; start: number; end: number; words: number }>) => {
    const st = storyTargetFromProfile(profile);
    const item = await db.contentItem.findUnique({ where: { id: contentItemId }, select: { title: true } });
    const model = styleModel === undefined ? await getStyleModel(db, { group: "MAIN" }).catch(() => null) : styleModel;
    return runEditorAgent(scopeProvider(provider, { contentItemId }), {
      title: item?.title ?? null,
      durationS: lines.length ? Math.max(...lines.map((l) => l.end)) : 0,
      lines,
      brandContext: await getBrandContextText(db),
      creativeBrief: await creativeBriefTextFor(db, contentItemId),
      referenceLengthS: st.source === "REFERENCES" ? { targetS: st.targetS, minS: st.minS, maxS: st.maxS } : null,
      styleDigest: model ? editorDigest(model) : null,
    });
  };
}

async function computeFullEdit(db: PrismaClient, storage: StorageAdapter, contentItemId: string, l: Loaded, choices: FullEditChoices, measure = true, provider: ModelProvider | null = null): Promise<FullEditComputed> {
  if (l.takes.length > 1) return { ok: false, error: "The full edit works on one take — this video was recorded in parts, so it gets the cuts-only edit." };
  if (!l.take.words?.length) return { ok: false, error: "The full edit needs captions first — they appear once your words are transcribed." };
  const profile = await getReferenceStyleProfile(db, { group: "MAIN" });
  // The references' StyleModel: the Editor's digest and the orchestrator's presets (reference
  // learning). Loaded once; a failure here never costs the cut.
  const styleModel = await getStyleModel(db, { group: "MAIN" }).catch(() => null);
  const audio = await takeAudioFor(db, storage, contentItemId, l.take, measure);
  const r = await buildFullEdit(
    {
      base: l.current,
      mediaAssetId: l.take.id,
      words: l.take.words,
      durationSeconds: l.take.durationSeconds,
      subjectTrack: l.take.subjectTrack,
      sourceSize: l.take.width && l.take.height ? { width: l.take.width, height: l.take.height } : null,
      silences: audio.silences,
      envelope: audio.envelope,
      splice: audio.splice,
      target: styleCutTargetFromProfile(profile),
      story: storyTargetFromProfile(profile),
      choices,
      brief: await briefForFullEdit(db, contentItemId),
      measure: nodeMeasureText,
      screenStyle: screenStyleFromStyleModel(styleModel),
      captionDefaults: captionDefaultsFromStyleModel(styleModel),
      editorPlanner: provider && choices.useEditor ? editorPlannerFor(db, provider, contentItemId, profile, styleModel) : null,
    },
    fullEditEmbedder(),
  );
  if (!r.ok) return { ok: false, error: r.message };
  const stored: StoredFullEdit = {
    version: r.version,
    origin: "AUTO",
    inputsKey: r.inputsKey,
    summary: r.report.summary,
    report: r.report as unknown as Record<string, unknown>,
    // The Editor's plan rides along so a re-apply never asks the model again.
    choices: { ...choices, ...(r.report.choices.editorPlan ? { editorPlan: r.report.choices.editorPlan } : {}) },
    mediaAssetId: l.take.id,
    silences: audio.silences,
    envelope: audio.envelope,
    splice: audio.splice,
  };
  return { ok: true, timeline: r.timeline, stored, report: r.report };
}

/**
 * The golden-set harness's export (docs/PREMIUM_EDITOR_HANDOFF.md §3.1): one real take frozen as
 * data so the whole edit replays offline (packages/media golden). Read-only — never writes a
 * plan. The machine cut is the latest plan carrying a stored full edit (or `machinePlanId`); the
 * hand edit is the latest plan Chris saved in the editor (or `handEditPlanId`).
 */
export async function exportGoldenFixture(
  db: PrismaClient,
  storage: StorageAdapter,
  contentItemId: string,
  options: { slug: string; machinePlanId?: string | null; handEditPlanId?: string | null },
): Promise<GoldenFixture> {
  const l = await load(db, contentItemId);
  if ("error" in l) throw new Error(l.error);
  if (l.takes.length > 1) throw new Error("The golden set works on one take — this video was recorded in parts.");
  if (!l.take.words?.length) throw new Error("This take has no word timings yet.");
  const audio = await takeAudioFor(db, storage, contentItemId, l.take, true);
  const profile = await getReferenceStyleProfile(db, { group: "MAIN" });
  const item = await db.contentItem.findUnique({ where: { id: contentItemId }, select: { title: true } });
  const plans = await db.editPlan.findMany({
    where: { contentItemId },
    orderBy: { createdAt: "desc" },
    take: 60,
    select: { id: true, createdAt: true, plan: true, revisionReason: true },
  });
  const timelineOf = (plan: unknown): EditTimeline | null => {
    const parsed = EditTimelineSchema.safeParse((plan as { timeline?: unknown } | null)?.timeline);
    return parsed.success ? parsed.data : null;
  };
  // The machine cut: the latest automatic edit or editor-button choice — never a hand save
  // (a hand save keeps the earlier `fullEdit` block on its row, so the block alone is no proof).
  const machineRow = options.machinePlanId
    ? plans.find((p) => p.id === options.machinePlanId)
    : plans.find((p) => !isHandEditReason(p.revisionReason) && (readStoredFullEdit(p.plan) || readStoredStyleCut(p.plan)) && timelineOf(p.plan));
  const machineFe = machineRow ? (readStoredFullEdit(machineRow.plan) ?? readStoredStyleCut(machineRow.plan)) : null;
  const machineTl = machineRow ? timelineOf(machineRow.plan) : null;
  const handRow = options.handEditPlanId
    ? plans.find((p) => p.id === options.handEditPlanId)
    : plans.find((p) => isHandEditReason(p.revisionReason) && timelineOf(p.plan));
  const handTl = handRow ? timelineOf(handRow.plan) : null;
  const editorPlan = plans.map((p) => readStoredFullEdit(p.plan)?.choices?.editorPlan).find((x) => x != null) ?? null;
  return {
    version: 1,
    slug: options.slug,
    contentItemId,
    title: item?.title ?? null,
    exportedAt: new Date().toISOString(),
    take: {
      mediaAssetId: l.take.id,
      durationSeconds: l.take.durationSeconds,
      width: l.take.width,
      height: l.take.height,
      words: l.take.words.map((w) => ({ word: w.word, start: w.start, end: w.end })),
      subjectTrack: l.take.subjectTrack ?? null,
    },
    audio: { silences: audio.silences ?? null, envelope: audio.envelope ?? null, splice: audio.splice ?? null },
    base: plainTimeline(l.takes, l.current),
    brief: await briefForFullEdit(db, contentItemId),
    profile: (profile ?? null) as unknown,
    editorPlan: editorPlan as GoldenFixture["editorPlan"],
    machine:
      machineRow && machineTl
        ? { editPlanId: machineRow.id, createdAt: machineRow.createdAt.toISOString(), reason: machineRow.revisionReason, summary: machineFe?.summary ?? "", timeline: machineTl }
        : null,
    handEdit:
      handRow && handTl
        ? { editPlanId: handRow.id, createdAt: handRow.createdAt.toISOString(), note: handRow.revisionReason, timeline: handTl }
        : null,
  };
}

/** Upload → ready, logged once the automatic edit lands (budget: READY_BUDGET_MINUTES). Never throws. */
async function logReadyLatency(db: PrismaClient, contentItemId: string): Promise<void> {
  try {
    const l = await uploadToReadyLatency(db, contentItemId);
    if (l?.minutes != null) console.log(`[latency] ${contentItemId} upload→ready ${l.minutes.toFixed(1)} min (budget ${READY_BUDGET_MINUTES})${l.overBudget ? " OVER BUDGET" : ""}`);
  } catch {
    // Telemetry only.
  }
}

/** Which automatic edit new uploads get: FULL_EDIT_AUTO=off forces Cuts only; else Chris's setting. */
async function autoMode(db: PrismaClient): Promise<AutoEditMode> {
  if (process.env.FULL_EDIT_AUTO === "off") return "CUTS";
  try {
    return await getAutoEditMode(db);
  } catch {
    return "CUTS";
  }
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
  options: { measureSilences?: boolean; provider?: (() => ModelProvider) | null } = {},
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
    const mode = await autoMode(db);
    if ((mode === "FULL" || mode === "EDITOR") && l.takes.length === 1) {
      try {
        // EDITOR: the AI Editor writes the cut when a model is available; otherwise (no key, no
        // credit, cap reached) the free Full edit — never nothing.
        let provider: ModelProvider | null = null;
        if (mode === "EDITOR" && options.provider) {
          try {
            provider = options.provider();
          } catch (err) {
            console.warn("[full-edit] no model provider for the Editor — free Full edit instead:", err instanceof Error ? err.message : err);
          }
        }
        let fe = await computeFullEdit(db, storage, contentItemId, base, provider ? { useEditor: true } : {}, options.measureSilences ?? true, provider);
        if (!fe.ok && provider) {
          console.warn("[full-edit] the Editor failed — free Full edit instead:", fe.error);
          fe = await computeFullEdit(db, storage, contentItemId, base, {}, options.measureSilences ?? true);
        }
        if (fe.ok) {
          const row = await recordAutoFullEdit(
            db,
            { contentItemId, expectedLatestPlanId: l.latest.id, timeline: fe.timeline, durationSeconds: timelineDuration(fe.timeline), fullEdit: fe.stored },
            actor,
          );
          if (!row) return { status: "SKIPPED", reason: "Already up to date." };
          await logReadyLatency(db, contentItemId);
          return { status: "APPLIED", editPlanId: row.id, summary: fe.stored.summary, profileNote: fe.stored.choices.editorPlan ? "The Editor's cut (AI)." : "Full edit (free) — no AI." };
        }
        console.warn("[full-edit] fell back to the style cut:", fe.error);
      } catch (err) {
        // Graceful: one broken bot must never leave Chris with nothing — the cuts-only edit runs.
        console.warn("[full-edit] failed — falling back to the style cut:", err instanceof Error ? err.message : err);
      }
    }
    const { r, stored } = await compute(db, storage, contentItemId, base, options.measureSilences ?? true);
    if (!r.ok || !stored) return { status: "SKIPPED", reason: r.ok ? "Nothing to do." : r.message };
    const row = await recordAutoStyleCut(
      db,
      { contentItemId, expectedLatestPlanId: l.latest.id, timeline: r.timeline, durationSeconds: timelineDuration(r.timeline), styleCut: stored },
      actor,
    );
    if (!row) return { status: "SKIPPED", reason: "Already up to date." };
    await logReadyLatency(db, contentItemId);
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
  mode: "STYLE" | "PLAIN" | "FULL",
  actorId: string,
  choices: FullEditChoices = {},
  opts: { provider?: (() => ModelProvider) | null } = {},
): Promise<
  | { ok: true; editPlanId: string; timeline: EditTimeline; summary: string | null; profileNote: string | null; fullEdit?: FullEditReport | null }
  | { ok: false; error: string }
> {
  const l = await load(db, contentItemId);
  if ("error" in l) return { ok: false, error: l.error };
  if (mode === "FULL") {
    // Always from the plain take (keeping Chris's caption style/look): a full edit re-cuts everything.
    let provider: ModelProvider | null = null;
    if (choices.useEditor && !choices.editorPlan && opts.provider) provider = opts.provider();
    const fe = await computeFullEdit(db, storage, contentItemId, { ...l, current: plainTimeline(l.takes, l.current) }, choices, true, provider);
    if (!fe.ok) return { ok: false, error: fe.error };
    const row = await saveFullEditChoice(db, { contentItemId, timeline: fe.timeline, durationSeconds: timelineDuration(fe.timeline), actorId, fullEdit: fe.stored });
    return { ok: true, editPlanId: row.id, timeline: fe.timeline, summary: fe.stored.summary, profileNote: null, fullEdit: fe.report };
  }
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
