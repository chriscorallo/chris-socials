import { claimKey, crewRoomView, isTechnicalOnlyBlock, flattenShots, studioStatusLabel, type CrewRoomView, type FilmArtifactRecord, type FilmRecord, type FilmVersionRecord, type MeaningFirstPass, type RenderResult, type StoryboardResult, type StudioFilm, type VerificationReport, type QualityIssue, type ContinuityIssue, type MeaningMatchReport } from "@chris/agents/studio";

/**
 * Pure view model for /studio/[id] (tested in view.test.ts): everything the phone shows, derived
 * from the film row + its append-only versions and artifacts. No I/O.
 */

export type StudioPhase = "crew" | "chatgpt" | "storyboard" | "rendering" | "ready" | "blocked" | "stopped" | "failed";

export interface StoryboardShotView {
  shotId: string;
  line: string | null;
  stillUrl: string | null;
  verdict: "MATCH" | "WEAK" | "MISMATCH" | null;
  verdictNote: string | null;
  fix: string | null;
  notes: string[];
}

export interface StudioFilmView {
  id: string;
  title: string;
  idea: string;
  phase: StudioPhase;
  statusLabel: string;
  statusMessage: string | null;
  step: string;
  iteration: number;
  maxIterations: number;
  roundTrips: number;
  pending: null | { kind: string; title: string; prompt: string; imageUrl: string | null; reason: string | null; lastErrors: string[]; repairMessage: string | null; optional: boolean; stepNumber: number; chars: number };
  crew: CrewRoomView;
  storyboard: StoryboardShotView[];
  storyboardIsSketch: boolean;
  facts: Array<{ key: string; lineId: string; text: string; source: string | null; confirmed: boolean }>;
  verification: { ok: boolean; summary: string } | null;
  render: { videoUrl: string | null; posterUrl: string | null; durationSeconds: number; loudnessLufs: number | null } | null;
  finalReports: Array<{ who: string; summary: string }>;
  versions: Array<{ version: number; origin: string; note: string; at: string; current: boolean }>;
  blockedReasons: string[];
  lastError: string | null;
  contentItemId: string | null;
  voiceId: string;
  aiMode: "CHATGPT" | "LOCAL";
  can: { approve: boolean; redo: boolean; edit: boolean; finalCheck: boolean; sendToVideos: boolean; resume: boolean };
  costUsd: 0;
}

const latest = <T>(arts: FilmArtifactRecord[], kind: string, versionId?: string | null): T | null => (arts.filter((a) => a.kind === kind && (versionId === undefined || a.versionId === versionId)).at(-1)?.payload as T) ?? null;

export function buildStudioFilmView(film: FilmRecord, versions: FilmVersionRecord[], arts: FilmArtifactRecord[], validatedFilm: StudioFilm | null): StudioFilmView {
  const vid = film.currentVersionId;
  const phase: StudioPhase =
    film.status === "NEEDS_CHATGPT" ? "chatgpt" : film.status === "NEEDS_CHRIS" ? "storyboard" : film.status === "RENDERING" ? "rendering" : film.status === "READY" ? "ready" : film.status === "BLOCKED" ? "blocked" : film.status === "STOPPED" ? "stopped" : film.status === "FAILED" ? "failed" : "crew";
  const sb = latest<StoryboardResult>(arts, "STORYBOARD", vid);
  const mmAuto = latest<MeaningFirstPass>(arts, "MEANING_MATCH_AUTO", vid);
  const mmReview = latest<MeaningMatchReport>(arts, "MEANING_MATCH", vid);
  const cont = latest<{ issues: ContinuityIssue[] }>(arts, "CONTINUITY", vid)?.issues ?? [];
  const qual = latest<{ issues: QualityIssue[] }>(arts, "QUALITY_AUTO", vid)?.issues ?? [];
  const storyboard: StoryboardShotView[] = validatedFilm
    ? flattenShots(validatedFilm).map(({ shot }) => {
        const auto = mmAuto?.report.checks.find((c) => c.shotId === shot.id) ?? null;
        const rev = mmReview?.checks.find((c) => c.shotId === shot.id) ?? null;
        const worst = [auto, rev].filter(Boolean).sort((a, b) => ({ MISMATCH: 0, WEAK: 1, MATCH: 2 })[a!.verdict] - ({ MISMATCH: 0, WEAK: 1, MATCH: 2 })[b!.verdict])[0] ?? null;
        const ruleNote = auto?.evidence.find((e) => e.ref.startsWith("rule:") && e.detail !== "the shot shows it")?.detail ?? null;
        return {
          shotId: shot.id,
          line: shot.line ?? null,
          stillUrl: sb?.stills.find((s) => s.shotId === shot.id)?.url ?? null,
          verdict: worst?.verdict ?? null,
          // A loose (similarity-only) match is advisory — one short line, no essay on a phone.
          verdictNote: !worst || worst.verdict === "MATCH" ? null : worst.verdict === "WEAK" && worst === auto ? "Only loosely shows the line." : (worst === auto ? ruleNote : null) ?? worst.shown,
          fix: !worst || worst.verdict === "MATCH" || (worst.verdict === "WEAK" && worst === auto) ? null : (worst.replacement?.description ?? null),
          notes: [...cont.filter((c) => c.toShot === shot.id).map((c) => c.detail), ...qual.filter((q) => q.shotId === shot.id && q.severity !== "INFO").map((q) => q.detail)],
        };
      })
    : [];
  const ver = latest<VerificationReport>(arts, "VERIFICATION", vid);
  const confirmed = new Set(film.confirmedClaims);
  const facts = (ver?.claimsToConfirm ?? []).map((c) => ({ key: claimKey(c.lineId, c.text), lineId: c.lineId, text: c.text, source: c.sourceNote, confirmed: confirmed.has(claimKey(c.lineId, c.text)) }));
  const render = latest<RenderResult>(arts, "RENDER", vid);
  const finalReports = ["QUALITY_RENDER_AUTO", "QUALITY_RENDER", "ANALYSIS"].flatMap((k) => {
    const a = arts.filter((x) => x.kind === k && x.versionId === vid).at(-1);
    return a ? [{ who: k === "ANALYSIS" ? "Analysis (first-time viewer)" : k === "QUALITY_RENDER" ? "Quality (ChatGPT, on the frames)" : "Quality (automatic, measured)", summary: a.summary }] : [];
  });
  const firstPackIndex = (kind: string) => (kind === "WRITE" ? 1 : kind === "REVIEW" ? 2 : kind === "FINAL" ? 3 : 0);
  const atReview = film.step === "STORYBOARD_REVIEW" && film.status === "NEEDS_CHRIS";
  return {
    id: film.id,
    title: film.title,
    idea: film.idea,
    phase,
    statusLabel: studioStatusLabel(film),
    statusMessage: film.statusMessage,
    step: film.step,
    iteration: film.iteration,
    maxIterations: film.limits.maxIterations,
    roundTrips: film.counters.roundTrips,
    pending: film.pending
      ? { kind: film.pending.kind, title: film.pending.title, prompt: film.pending.prompt, imageUrl: film.pending.imageUrl, reason: film.pending.reason ?? null, lastErrors: film.pending.lastErrors ?? [], repairMessage: film.pending.repairMessage ?? null, optional: film.pending.kind === "FINAL", stepNumber: firstPackIndex(film.pending.kind), chars: film.pending.prompt.length }
      : null,
    crew: crewRoomView(film, arts),
    storyboard,
    storyboardIsSketch: !!sb?.stills[0]?.url.startsWith("data:image/svg"),
    facts,
    verification: ver ? { ok: ver.gate.status === "PASS", summary: facts.length && facts.every((f) => f.confirmed) ? `${ver.summary.replace(/;? ?\d+ facts? for Chris to confirm\.?$/, "")}; facts confirmed by you.` : ver.summary } : null,
    render: render ? { videoUrl: render.videoUrl, posterUrl: render.posterUrl, durationSeconds: render.durationSeconds, loudnessLufs: render.loudnessLufs } : null,
    finalReports,
    versions: versions.map((v) => ({ version: v.version, origin: v.origin, note: v.note, at: v.createdAt.toISOString(), current: v.id === vid })).reverse(),
    blockedReasons: film.blockedReasons,
    lastError: film.lastError,
    contentItemId: film.contentItemId,
    voiceId: film.voiceId,
    aiMode: film.aiMode,
    can: {
      approve: atReview,
      redo: atReview || film.status === "READY",
      edit: atReview,
      finalCheck: film.status === "READY" && !film.pending,
      sendToVideos: film.status === "READY" && !film.contentItemId,
      resume: film.status === "FAILED" || film.status === "STOPPED" || (film.status === "BLOCKED" && isTechnicalOnlyBlock(film.blockedReasons)),
    },
    costUsd: 0,
  };
}
