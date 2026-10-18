import { z } from "zod";

/**
 * Mini-movie Studio crew — typed outputs of /prompts/agents/FILM_*.md.
 *
 * The crew never chats: each specialist returns ONE of these artifacts, the orchestrator
 * (studio/pipeline.ts — deterministic code) persists it as a FilmArtifact row and hands the
 * next specialist exactly what it needs. Provenance is enforced in the TYPE (CLAUDE.md):
 * every judgment carries `evidence` with at least one item that points at a line, a shot, a
 * storyboard still, the DSL or a measured/calculated fact. Attention/virality numbers are
 * `kind: "ESTIMATE"` with an uncertainty — there is no field a view forecast could go in.
 *
 * Hard gates (VERIFICATION math/claims, TECHNICAL render failure) are NOT in these schemas —
 * they are computed by code (studio/deterministic.ts, studio/gates.ts) and can never be
 * averaged away by a creative score (studio/gates.ts' types make it unrepresentable).
 */

export const FilmEvidenceSchema = z.object({
  kind: z
    .enum(["LINE", "SHOT", "STILL", "DSL", "FACT", "CALC", "MEASURED", "REPORT"])
    .describe(
      "LINE = narration text; SHOT = a shot's plan; STILL = what a storyboard/render frame shows; DSL = a field of the film JSON; FACT = a fact Chris/brief gave; CALC = a computed number; MEASURED = a pixel/audio measurement; REPORT = another crew member's finding.",
    ),
  ref: z.string().min(1).describe("Shot id, line id (l3), still id (shotId@mid), DSL path, or report name."),
  detail: z.string().min(1).describe("What exactly is said / shown / computed there (quote it)."),
});
export type FilmEvidence = z.infer<typeof FilmEvidenceSchema>;
const Evidence = z.array(FilmEvidenceSchema).min(1);

export const EstimateSchema = z.object({
  kind: z.literal("ESTIMATE"),
  score: z.number().min(0).max(100).describe("0–100 relative estimate from this read — never a forecast of views."),
  uncertainty: z.enum(["LOW", "MEDIUM", "HIGH"]),
});
export type Estimate = z.infer<typeof EstimateSchema>;

// ---------------------------------------------------------------------------------------------
// FILM_DIRECTOR — brief

export const FilmBriefSchema = z.object({
  workingTitle: z.string().min(1).max(80),
  premise: z.string().min(1).describe("One sentence: what happens in the film."),
  audience: z.string().min(1),
  promise: z.string().min(1).describe("What the viewer gets for watching to the end."),
  tone: z.string().min(1),
  centralMetaphor: z.object({
    idea: z.string().min(1).describe("ONE physical metaphor the whole film lives in (e.g. 'the raise is a pile of gold coins')."),
    whyItFits: z.string().min(1),
    catalogRefs: z.array(z.string()).describe("Catalog ids that can show it (e.g. actor:COIN_STACK)."),
  }),
  keyNumbers: z.array(
    z.object({
      label: z.string().min(1),
      value: z.string().min(1),
      source: z.enum(["CHRIS", "PUBLIC_FACT", "HYPOTHETICAL", "DERIVED"]),
      note: z.string().nullable(),
    }),
  ),
  mustInclude: z.array(z.string()),
  doNotExpandInto: z.array(z.string()),
  targetSeconds: z.number().min(15).max(90),
  successCriteria: z.array(z.string()).min(1),
  risks: z.array(z.string()),
  uncertainty: z.string().describe("What the Director is unsure about (say 'none' only if true)."),
});
export type FilmBrief = z.infer<typeof FilmBriefSchema>;

// ---------------------------------------------------------------------------------------------
// FILM_HOOK

export const HOOK_MECHANISMS = ["CONTRADICTION", "LOSS", "CURIOSITY_GAP", "NUMBER", "QUESTION", "STAKES", "PATTERN_BREAK", "IMAGE_VS_LINE"] as const;

export const HookOptionSchema = z.object({
  id: z.string().min(1).describe("h1, h2, …"),
  line: z.string().min(1).max(120).describe("The spoken opening line (first 1–3 s)."),
  openingVisual: z.string().min(1).describe("What the very first frame shows, using catalog vocabulary."),
  catalogRefs: z.array(z.string()),
  mechanism: z.enum(HOOK_MECHANISMS),
  stopEstimate: EstimateSchema.describe("How likely a cold viewer stops scrolling — an estimate."),
  reasons: z.array(z.string()).min(1),
  risks: z.array(z.string()),
});
export type HookOption = z.infer<typeof HookOptionSchema>;

export const HookSetSchema = z.object({
  options: z.array(HookOptionSchema).min(5),
  recommendedId: z.string().min(1),
  rationale: z.string().min(1),
});
export type HookSet = z.infer<typeof HookSetSchema>;

// ---------------------------------------------------------------------------------------------
// FILM_SCREENWRITER

export const BEATS = ["HOOK", "SETUP", "ESCALATION", "TURN", "PAYOFF", "BUTTON"] as const;
export type Beat = (typeof BEATS)[number];

export const ScriptLineSchema = z.object({
  id: z.string().regex(/^l\d+$/).describe("l1, l2, … in speaking order."),
  beat: z.enum(BEATS),
  text: z.string().min(1).max(300).describe("Narration exactly as spoken and captioned."),
  say: z.string().nullable().describe("Pronunciation override for TTS (\"ten thousand dollars\" for \"$10,000\") or null."),
  intent: z.string().min(1).describe("What this line must make the viewer feel/understand."),
  visualIdea: z.string().min(1).describe("What the picture should LITERALLY show while this is said."),
});
export type ScriptLine = z.infer<typeof ScriptLineSchema>;

export const NUMBER_UNITS = ["USD", "PERCENT", "COUNT", "YEARS", "MONTHS", "OTHER"] as const;

export const ScriptNumberSchema = z.object({
  id: z.string().min(1).describe("n1, n2, …"),
  label: z.string().min(1),
  display: z.string().min(1).describe("Exactly as it appears on screen or in the line (\"$6,500\", \"35%\", \"two seventy\")."),
  value: z.number().describe("The numeric value (35 for 35%, 6500 for $6,500)."),
  unit: z.enum(NUMBER_UNITS),
  appearsIn: z.array(z.string()).describe("Line ids where it is said or shown."),
  source: z.enum(["CHRIS", "PUBLIC_FACT", "HYPOTHETICAL", "DERIVED"]),
});
export type ScriptNumber = z.infer<typeof ScriptNumberSchema>;

/** Restricted arithmetic the Verification step can re-compute deterministically. */
export const CALC_OPS = [
  "ADD", // inputs summed
  "SUBTRACT", // inputs[0] - inputs[1] - …
  "MULTIPLY",
  "DIVIDE", // inputs[0] / inputs[1]
  "PERCENT_OF", // inputs[0] % of inputs[1]
  "MONTHLY_FROM_ANNUAL", // inputs[0] / 12
  "ANNUAL_FROM_MONTHLY", // inputs[0] * 12
  "FUTURE_VALUE_MONTHLY", // monthly contribution inputs[0], annual rate % inputs[1], years inputs[2] — end-of-month deposits, monthly compounding
  "PERCENT_CHANGE", // (inputs[1] - inputs[0]) / inputs[0] * 100
] as const;
export type CalcOp = (typeof CALC_OPS)[number];

export const ScriptCalculationSchema = z.object({
  id: z.string().min(1).describe("c1, c2, …"),
  description: z.string().min(1),
  op: z.enum(CALC_OPS),
  inputs: z.array(z.number()).min(1),
  claimed: z.number().describe("The result the film says/shows."),
  approximate: z.boolean().describe("True when the line says 'about'/'roughly' (allows rounding)."),
  resultNumberId: z.string().nullable().describe("The ScriptNumber this calculation produces, if any."),
});
export type ScriptCalculation = z.infer<typeof ScriptCalculationSchema>;

export const ScriptClaimSchema = z.object({
  lineId: z.string().min(1),
  text: z.string().min(1),
  kind: z.enum(["FACT", "HYPOTHETICAL", "OPINION", "CHRIS_EXPERIENCE"]),
  sourceNote: z.string().nullable().describe("Where it comes from (Chris's brief, a public rule…) — null if unsourced."),
});
export type ScriptClaim = z.infer<typeof ScriptClaimSchema>;

export const FilmScriptSchema = z.object({
  title: z.string().min(1).max(80),
  logline: z.string().min(1).max(300),
  centralMetaphor: z.string().min(1),
  hookId: z.string().nullable().describe("The hook option this script opens with."),
  lines: z.array(ScriptLineSchema).min(3).max(40),
  numbers: z.array(ScriptNumberSchema),
  calculations: z.array(ScriptCalculationSchema),
  claims: z.array(ScriptClaimSchema),
  caveats: z.array(z.string()).describe("On-screen footnotes the numbers need (e.g. 'Hypothetical 7% return. Not a guarantee.')."),
  estimatedSeconds: z.number().min(5).max(120),
  voiceNotes: z.string(),
});
export type FilmScript = z.infer<typeof FilmScriptSchema>;

// ---------------------------------------------------------------------------------------------
// FILM_RETENTION (virality / retention)

export const RetentionReportSchema = z.object({
  hook: z.object({ stop: EstimateSchema, why: z.string().min(1), evidence: Evidence }),
  beats: z.array(
    z.object({
      ref: z.string().min(1).describe("Line id or shot id."),
      attention: EstimateSchema,
      dropOffRisk: z.enum(["LOW", "MEDIUM", "HIGH"]),
      why: z.string().min(1),
      evidence: Evidence,
    }),
  ),
  fixes: z.array(
    z.object({
      ref: z.string().min(1),
      kind: z.enum(["TIGHTEN_LINE", "ESCALATE_VISUAL", "CUT", "REORDER", "ADD_PAYOFF_EARLIER"]),
      suggestion: z.string().min(1),
      evidence: Evidence,
    }),
  ),
  rewatchShareSave: EstimateSchema,
  summary: z.string().min(1),
  caveat: z.string().min(1).describe("Always: these are estimates of a cold viewer's attention, not predictions of views."),
});
export type RetentionReport = z.infer<typeof RetentionReportSchema>;

// ---------------------------------------------------------------------------------------------
// FILM_CINEMATOGRAPHER

export const ShotNoteSchema = z.object({
  shotId: z.string().min(1),
  lineId: z.string().nullable(),
  depicts: z.string().min(1).describe("What the picture literally shows, in plain words."),
  catalogRefs: z.array(z.string()).min(1).describe("Catalog ids used (actor:BASELINE, action:SET.level, camera:CRANE_UP…)."),
});
export type ShotNote = z.infer<typeof ShotNoteSchema>;

/** The film DSL itself is NOT typed here: whatever comes back is parsed + validated by the
 * ENGINE's own validator (validateFilm) — never trusted as-is. */
const FilmDslSchema = z.record(z.string(), z.unknown()).describe("The complete film in the cinema DSL (a JSON object).");

export const ShotPlanSchema = z.object({
  film: FilmDslSchema,
  shotNotes: z.array(ShotNoteSchema).min(1),
  changeSummary: z.string().describe("What changed vs the previous version (or 'first draft')."),
});
export type ShotPlan = z.infer<typeof ShotPlanSchema>;

// ---------------------------------------------------------------------------------------------
// FILM_MEANING_MATCH — does the picture show what is said?

export const MeaningVerdictSchema = z.enum(["MATCH", "WEAK", "MISMATCH"]);
export type MeaningVerdict = z.infer<typeof MeaningVerdictSchema>;

export const ReplacementVisualSchema = z.object({
  description: z.string().min(1).describe("The concrete picture that would literally show the line."),
  catalogRefs: z.array(z.string()).min(1),
  dslHint: z.string().min(1).describe("How to express it in the DSL (actors/actions/camera)."),
});

export const MeaningCheckSchema = z
  .object({
    shotId: z.string().min(1),
    lineId: z.string().nullable(),
    line: z.string().describe("The narration as spoken (\"\" for a silent shot)."),
    meaning: z.string().min(1).describe("What the line means, literally and figuratively."),
    shown: z.string().min(1).describe("What the viewer actually sees while it is said."),
    verdict: MeaningVerdictSchema,
    evidence: Evidence,
    replacement: ReplacementVisualSchema.nullable(),
  })
  .superRefine((c, ctx) => {
    if (c.verdict !== "MATCH" && !c.replacement) {
      ctx.addIssue({ code: "custom", path: ["replacement"], message: `${c.verdict} needs a concrete replacement visual from the catalog.` });
    }
  });
export type MeaningCheck = z.infer<typeof MeaningCheckSchema>;

export const MeaningMatchReportSchema = z.object({
  checks: z.array(MeaningCheckSchema).min(1),
  summary: z.string().min(1),
});
export type MeaningMatchReport = z.infer<typeof MeaningMatchReportSchema>;

// ---------------------------------------------------------------------------------------------
// FILM_COHESION

const SeveritySchema = z.enum(["MINOR", "MAJOR"]);

export const CohesionReportSchema = z.object({
  metaphor: z.object({ holds: z.boolean(), notes: z.string().min(1), evidence: Evidence }),
  world: z.object({ consistent: z.boolean(), notes: z.string().min(1), evidence: Evidence }).describe("Look, palette, motifs, sets."),
  storyLogic: z.object({ clear: z.boolean(), notes: z.string().min(1), evidence: Evidence }),
  pacingArc: z.object({ notes: z.string().min(1), evidence: Evidence }),
  ending: z.object({ lands: z.boolean(), why: z.string().min(1), evidence: Evidence }),
  issues: z.array(z.object({ severity: SeveritySchema, ref: z.string().min(1), problem: z.string().min(1), fix: z.string().min(1), evidence: Evidence })),
  score: EstimateSchema,
});
export type CohesionReport = z.infer<typeof CohesionReportSchema>;

// ---------------------------------------------------------------------------------------------
// FILM_CONTINUITY (vision half — the deterministic half is studio/deterministic.ts)

export const CONTINUITY_KINDS = ["OBJECT_POPS_IN", "OBJECT_AFTER_EXIT", "COUNT_MISMATCH", "SCREEN_DIRECTION", "LIGHTING_JUMP", "SCALE_JUMP", "POSITION_JUMP", "NUMBER_MISMATCH", "OTHER"] as const;
export type ContinuityKind = (typeof CONTINUITY_KINDS)[number];

export const ContinuityIssueSchema = z.object({
  kind: z.enum(CONTINUITY_KINDS),
  fromShot: z.string().nullable(),
  toShot: z.string().min(1),
  severity: SeveritySchema,
  detail: z.string().min(1),
  fix: z.string().min(1),
  evidence: Evidence,
});
export type ContinuityIssue = z.infer<typeof ContinuityIssueSchema>;

export const ContinuityVisionReportSchema = z.object({
  issues: z.array(ContinuityIssueSchema),
  summary: z.string().min(1),
});
export type ContinuityVisionReport = z.infer<typeof ContinuityVisionReportSchema>;

// ---------------------------------------------------------------------------------------------
// FILM_QUALITY (storyboard stills / rendered frames)

export const QUALITY_KINDS = ["SAFE_ZONE", "LEGIBILITY", "COMPOSITION", "LIGHTING", "ARTIFACT", "EMPTY_FRAME", "TEXT_COLLISION", "CROP", "OTHER"] as const;

export const QualityIssueSchema = z.object({
  shotId: z.string().min(1),
  kind: z.enum(QUALITY_KINDS),
  severity: z.enum(["INFO", "MINOR", "MAJOR", "BLOCKING"]),
  detail: z.string().min(1),
  fix: z.string().min(1),
  evidence: Evidence,
});
export type QualityIssue = z.infer<typeof QualityIssueSchema>;

export const QualityReportSchema = z.object({
  stage: z.enum(["STORYBOARD", "RENDER"]),
  perShot: z.array(z.object({ shotId: z.string().min(1), composition: EstimateSchema, legibility: EstimateSchema, note: z.string() })),
  issues: z.array(QualityIssueSchema),
  premiumBar: z.object({ verdict: z.enum(["BELOW", "AT", "ABOVE"]), why: z.string().min(1), evidence: Evidence }),
  verdict: z.enum(["PASS", "REVISE"]),
  topFixes: z.array(z.string()),
});
export type QualityReport = z.infer<typeof QualityReportSchema>;

// ---------------------------------------------------------------------------------------------
// FILM_DIRECTOR — decision after the reviews

export const RevisionSchema = z.object({
  target: z.enum(["HOOK", "SCRIPT", "SHOTS"]),
  refs: z.array(z.string()).describe("Line ids / shot ids this applies to (empty = whole film)."),
  instruction: z.string().min(1).describe("A concrete, self-contained instruction the specialist can apply."),
  because: Evidence.describe("The report findings this revision answers (kind REPORT, ref = report:shot)."),
});
export type Revision = z.infer<typeof RevisionSchema>;

export const DirectorDecisionSchema = z.object({
  decision: z.enum(["APPROVE", "REVISE", "STOP"]),
  rationale: z.string().min(1),
  revisions: z.array(RevisionSchema),
  overruled: z
    .array(z.object({ report: z.string().min(1), ref: z.string().min(1), why: z.string().min(1) }))
    .describe("Specialist findings the Director chose NOT to act on, with why (never a hard gate)."),
  notesForChris: z.string().describe("One or two plain sentences for the crew room."),
});
export type DirectorDecision = z.infer<typeof DirectorDecisionSchema>;

// ---------------------------------------------------------------------------------------------
// Round-trip packs ($0: answered by Chris's ChatGPT, or the optional local model). Each pack's
// answer is ONE JSON object holding several crew members' artifacts — so a film needs two
// round trips (WRITE, REVIEW), not one per crew member. Each section is still that crew
// member's own typed artifact and is persisted as its own FilmArtifact row.

export const WritePackResponseSchema = z.object({
  brief: FilmBriefSchema,
  hooks: HookSetSchema,
  script: FilmScriptSchema,
  shots: ShotPlanSchema,
});
export type WritePackResponse = z.infer<typeof WritePackResponseSchema>;

/** CLAIMS_GATE-shaped fact check (same field names as ClaimsGateResultSchema) — the Claims Gate
 * contract reused through a free ChatGPT round trip, never a billed call. */
export const FactCheckSchema = z.object({
  claims: z.array(
    z.object({
      claimText: z.string().min(1),
      sourceSupport: z.string(),
      evidenceStrength: z.enum(["WEAK", "MODERATE", "STRONG"]),
      freshnessConcern: z.boolean(),
      numericConsistency: z.boolean(),
      omittedCaveatRisk: z.boolean(),
      overstatesEvidence: z.boolean(),
    }),
  ),
  result: z.enum(["PASS", "PASS_WITH_REQUIRED_EDIT", "BLOCK"]),
  requiredEdits: z.array(z.string()),
  blockReason: z.string().nullable(),
});
export type FactCheck = z.infer<typeof FactCheckSchema>;

export const ReviewPackResponseSchema = z.object({
  meaningMatch: MeaningMatchReportSchema,
  cohesion: CohesionReportSchema,
  retention: RetentionReportSchema,
  quality: QualityReportSchema,
  factCheck: FactCheckSchema,
  director: DirectorDecisionSchema,
  /** Required when director.decision is REVISE: the whole revised film (+ script if lines/numbers changed). */
  revisedFilm: FilmDslSchema.nullable(),
  revisedScript: FilmScriptSchema.nullable(),
});
export type ReviewPackResponse = z.infer<typeof ReviewPackResponseSchema>;

export const FixPackResponseSchema = z.object({
  film: FilmDslSchema,
  script: FilmScriptSchema.nullable(),
  changeSummary: z.string().min(1),
});
export type FixPackResponse = z.infer<typeof FixPackResponseSchema>;

/** Optional last round trip on the rendered film: vision quality + a first-time-viewer read
 * (the VIEWER_PANEL idea, condensed so it fits one ChatGPT answer). */
export const FinalPackResponseSchema = z.object({
  quality: QualityReportSchema,
  analysis: z.object({
    verdict: z.enum(["BAD", "OKAY", "GOOD", "GREAT", "EXCEPTIONAL"]),
    headline: z.string().min(1),
    hook: z.object({ stop: EstimateSchema, why: z.string().min(1), evidence: Evidence }),
    dropOffs: z.array(z.object({ ref: z.string().min(1), why: z.string().min(1), evidence: Evidence })),
    topFixes: z.array(z.string()),
    caveat: z.string().min(1),
  }),
});
export type FinalPackResponse = z.infer<typeof FinalPackResponseSchema>;
