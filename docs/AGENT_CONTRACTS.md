# Agent Contracts

Every specialist below is a prompt file under `/prompts/agents/` (see `/prompts/README.md`
for the registry format) plus, from the phase noted, a typed input/output contract in
`packages/agents`. None of these agents are autonomous chat participants — each is invoked by
the Creative Director or by a deterministic job with a specific artifact to produce, per
`/docs/ARCHITECTURE.md`'s orchestration pattern.

## Shared rules (apply to every agent — not repeated per row)

From `/prompts/shared/SYSTEM_BASE.md` and spec §12:

1. Authority hierarchy is fixed: hard constraints → explicit Chris decision → Brand
   Constitution → current strategic objective → Creative Director instruction → strong
   first-party Chris evidence → specialist domain principles → reference creator
   observations → generic industry assumptions. Never reversed.
2. Structured output only — typed JSON/schema, not unrestricted prose for downstream parsing.
3. State uncertainty explicitly; never fabricate missing facts, sources, or metrics.
4. Never overclaim causality — observation, principle, and experimental evidence are distinct.
5. Never expand scope beyond the assigned artifact (see `DO_NOT_EXPAND_INTO` on Production
   Contracts).
6. Never copy a reference creator's identity, language, or creative signature as a substitute
   for Chris's own.
7. Premium quality means the correct decision, not maximum complexity.

## Shared inputs every creative agent gets (2026-10-19, Content Intelligence)

- **The Operator** — `/prompts/shared/CREATOR_OPERATOR.md` (+ `_CORE.md`): the persona every
  creative agent works as — the creator who built a multi-million-follower brand from short
  videos alone: what they know about attention (first line = promise with tension, re-hook every
  7–10 s, say it once), interest (specific, "you", the moment nobody thought about), engagement
  earned not asked, virality as a byproduct, trust as the compounding asset, weak material as the
  job (find the angle, invent the framing never the facts), and coherence (every line follows the
  one before). Appended with the playbook per the same `content_intelligence` flag (FULL = whole
  persona, CORE = the short form). The free ChatGPT script prompt carries `OPERATOR_GUIDANCE`.
- **The Editor's orchestration rules** — `/prompts/shared/EDITOR_ORCHESTRATION.md`: how the screen
  is run second by second (one lead at a time; fixed anchors; timing tied to words and held for
  the idea; motion felt not seen; the screen says what the words can't; the editor's check).
  Appended for the agents that own the screen: EDITOR, VISUAL_STRATEGIST, MOTION_DESIGNER,
  VIEWER_PANEL, FLOW_CHECK.
- **The playbook** — `/prompts/shared/CONTENT_INTELLIGENCE.md` (Chris's "Content Intelligence
  Engine" master strategy: series, hook families, story arc with a real-or-null midpoint,
  objective-based endings, evidence standards, editorial scorecard). Each agent prompt's
  frontmatter declares `content_intelligence: FULL | CORE | NONE`; `buildSystemPrompt` appends
  the full playbook, the CORE excerpt (`CONTENT_INTELLIGENCE_CORE.md`), or nothing after
  SYSTEM_BASE. FULL: Script, Research, Brand Guardian, Creative Director, Weekly Strategist,
  Adversarial Evaluator, Hook Picker, Visual Strategist, Viewer Panel, Production Director.
  CORE: Platform Packaging, Motion Designer, Director Chat, Edit Planner, Take Selector,
  Analytics, Learning, Weekly Review, Experiment. NONE: Claims Gate, Visual QA, the Studio crew.
- **The Creative Brief** (`CreativeBrief`, one append-only row per revision; `formatCreativeBrief`
  → prompt text) — written by the Script Agent (v2.0.0) or the free ChatGPT script import, then
  read by Hook Picker, Visual Strategist, Viewer Panel ("did it deliver the plan?"), Platform
  Packaging (captions serve the ending objective), Director Chat, Edit Planner, Take Selector
  (which now also gets the script), Analytics (judges the brief's "what to test"), and the free
  Full edit (planned hook preferred, midpoint/payoff/ending sentences protected from length
  trims). Absent brief = the agent works from the footage as before — or, on the AI edit, the
  **Footage Brief** agent recovers one from the take first (source `FOOTAGE`), so older and
  footage-first videos follow the playbook too.

## Roster

| Agent | Role | Authority level | Primary input(s) | Output artifact | Model class | Can hard-BLOCK? |
|---|---|---|---|---|---|---|
| Creative Director | Owns weekly coherence and long-term brand direction; resolves specialist conflicts | 2 (Creative Director) | Brand Constitution, Strategic Memory, recent performance, active experiments, weekly slate | `WeeklyProgrammingThesis` decision record | HIGH | No — cannot bypass hard gates |
| Weekly Strategist | Builds the coherent ~30-video weekly portfolio | 3 (Specialist) | `WeeklyProgrammingThesis`, historical evidence, production constraints, `PlanContext` (optional — Chris's ChatGPT planning conversation via `getActivePlanContext`, ≤ 12 000 chars ≈ 3K tokens, stated intent only) | `WeeklySlate` + per-idea allocation | HIGH | No |
| Research Agent | Gathers enough reliable info to safely film a specific claim | 3 | `ProductionContract` | `ResearchPacket` (status: `READY` / `NEEDS_MORE_RESEARCH` / `UNSUPPORTED` / `OUT_OF_SCOPE`) | MEDIUM | No (feeds the gate, doesn't gate itself) |
| Claims Gate | Independently reviews factual claims | 2 (Hard Gate) | `ResearchPacket`, `ScriptVersion` | `ClaimsGateResult` (`PASS` / `PASS_WITH_REQUIRED_EDIT` / `BLOCK`) | HIGH | **Yes** |
| Reference Intelligence | Studies external creators for transferable principles | 3 | `ReferenceContent`, Chris historical data | `ReferenceObservation` (observed / likely principle / transferability / risks / test required) | MEDIUM | No |
| Script Agent | Writes Chris-native spoken scripts | 3 | `ResearchPacket` (when factual), `ProductionContract`, `PlanContext` (optional — ≤ 6 000 chars ≈ 1.5K tokens; intent/audience/offer only, never a source of facts) | `ScriptVersion` | MEDIUM | No |
| Brand Guardian | Protects voice, identity, originality, strategic fit | 3 (but its threshold is a hard gate input) | `ScriptVersion` / `Render`, Brand Constitution, Chris Brain | Brand/Voice/Originality/Strategic-Fit scores + required changes | MEDIUM | No directly — feeds the `BRAND: threshold` hard gate |
| Production Director | Assigns production tier, batches filming, builds Creator Cards | 3 | `WeeklySlate`, physical setup constraints | `CreatorCard` per idea, filming order | LOW/MEDIUM | No |
| Take Selector | Chooses the strongest usable take | 3 | `RawTake` set (transcript, technical + performance signals) | `TakeSelection` (selected + backup + defects) | MEDIUM (vision) | No |
| Edit Planner | Deterministic editorial decision-maker; does not render | 3 | `TakeSelection`, `ProductionContract`, asset library | `EditPlan` | HIGH/MEDIUM | No |
| Motion Designer | Proposes animated explainer graphics (motion-contract templates, incl. `GRAPHIC` = graphics-library preset + base component filled with this video's data; prompt 1.2.0) timed to the transcript and one per-video motion theme fitted to the topic; optional single-moment `focus` ("Suggest with AI" in the editor library); numbers grounded in research/script by code, placement solved deterministically; adapts to Chris's learned motion taste | 3 | `EditTimeline`, timestamped transcript, `ResearchPacket`, gated `ScriptVersion`, `ProductionContract` tier, `MotionTasteProfile` (learned from his editor diffs) | `MotionDesignerOutput` -> `TimelineVisual[]` + `MotionTheme` (+ `rejectedVisuals`) | MEDIUM | No |
| Visual Director | Evaluates visual storytelling and restraint | 3 | `Render`, weekly slate context | Recommendations (only when materially improving) | MEDIUM | No |
| Visual QA | Finds machine-actionable visual defects in the actual render | 3 (feeds hard gate) | `Render` (sampled frames + temporal transitions) | `QCReport` / `QCIssue` list (severity: `INFO/MINOR/MAJOR/BLOCKING`) | MEDIUM (vision) | Feeds `TECHNICAL`/`BRAND` hard gate, doesn't itself issue BLOCK |
| Platform Packaging (Instagram / TikTok / YouTube) | Packages the *final* video per platform; cannot change the underlying claim | 3 | Final `Render`, transcript | `PlatformPackage` per platform | LOW/MEDIUM | No |
| Scheduler | Places `READY` content coherently on the calendar | 3 | `WeeklySlate`, `ScheduleEntry` history, platform quota state | `ScheduleEntry` assignments | LOW | No |
| Analytics Agent | Evaluates performance without vanity-metric bias | 3 | `PerformanceSnapshot` series | Performance evaluation (attention/consumption/amplification/conversation/identity/relationship/business/ROI) | MEDIUM | No |
| Audience Intelligence | Turns comments into first-party research | 3 | `Comment` batch | `AudienceInsight` | LOW/MEDIUM | No |
| Experiment Agent | Designs practical tests, identifies confounders | 3 | Weekly slate, prior experiment results | `Experiment` / `ExperimentVariant` | MEDIUM | No |
| Learning Agent | Proposes durable beliefs from evidence | 4 (Learning System — proposal only) | `EvidenceEntry` set | `BeliefProposal` (never writes `Belief` directly) | HIGH | No — cannot self-promote |
| Adversarial Evaluator | Actively looks for meaningful weaknesses | 3 (independent second opinion) | Any artifact under review | Critique / risk list | HIGH | No — advisory |
| Taste Learner | Learns from Chris's edits/rejections | 4 (Learning System) | `TasteFeedback` | Updated `ChrisAcceptanceProbability` (never a universal rule from one data point) | MEDIUM | No |
| Weekly Review / Learning Council | Produces the executive brief + candidate learnings | 2/3 (Creative-Director-adjacent) | Full week's episodic data | Weekly brief, candidate `BeliefProposal`s | HIGH | No |
| Active Week Monitor | Surfaces only materially actionable live-week events | 3 | Live production/publishing state | `NEEDS YOU` queue entries | LOW | No |
| Viewer Panel ("Watch it like a new viewer") | Simulates a first-time viewer (cold, or an existing follower) on TikTok / Reels / Shorts watching one whole video: hook verdict, beat-by-beat feeling + attention + scroll-away risk, drop-offs, craft checks (cut rhythm vs cadence, cuts without purpose, picture/graphic vs words, captions, level jumps, music vs voice, ending/loop/CTA), story clarity, engagement ESTIMATES, verdict tier, top fixes — every judgment with timestamped evidence. Also run on reference videos to learn why they work | 3 (advisory only — never a gate input, never averaged into one) | Latest successful `Render` (or a reference video): sampled frames incl. both sides of every cut, word-timed transcript, the `EditPlan` timeline's facts, measured audio (packages/media), optional reference `StyleProfile`; Brand Constitution only for Chris's own videos (to keep fixes in his voice) | `ViewerReview` (zod, `packages/agents/src/viewer-panel-schema.ts`) → `ViewerReview` row | HIGH (vision) | No |
| **The Editor** (`EDITOR`, v2 2026-10-21) | Writes the cut of a filmed take — not a trim, a build: the lean transcript in story order (HOOK → SETUP → TENSION → TURN → PAYOFF → ENDING) from lines Chris said (ids only; filler trimmed inside a line via `keepWords`), what was cut and why, **a headline on every beat** (every payoff number in a headline), what each beat needs the viewer to see (or nothing), **emphasis words** for the punch-ins, the pacing, a cold-viewer read-through of at least two sentences. v2 is write → critique → revise once: the draft is read against the checklist by the deterministic half (`editorPlanChecklist`) and by the Critique (below); any finding gets one revision; the plan carries its `review` (verdict, findings, revised). The deterministic Full edit executes the plan word-exactly (`planFromEditor`) and the **Screen Orchestrator** (`packages/media/src/screen/`, deterministic) places everything from it; the plan is stored with the edit so re-applies never ask again. Runs automatically on upload (auto-edit mode EDITOR, default; falls back to the free Full edit without a model) and as the AI edit's first step. Gets the Operator, the playbook, the Editor orchestration rules and the StyleModel digest (`editorDigest`: what his references and his own edits do, ≤ 10 lines, a range never a quota) | 3 | Title, Creative Brief, numbered transcript lines with timings, reference length, style digest | `EditorPlan` (zod, `packages/media/src/full-edit/editor-plan.ts`) | HIGH (+ one more HIGH when revised) | No |
| The Editor's Critique (`EDITOR_CRITIQUE`) | The second editor in the room: reads the Editor's draft as a cold viewer against the checklist (HEADLINE_PER_BEAT, HOOK_STANDS_ALONE, TENSION_ADDS, NUMBER_IS_PAYOFF, ENDING_SERVES_OBJECTIVE, DEPENDENT_LINE, COLD_VIEWER, EMPHASIS_WORDS), confirms or dismisses what the deterministic checklist found, names at most 8 findings each with the line and a one-sentence fix; never rewrites the cut, never adds words. A failed critique call leaves the draft with the deterministic findings (it must never cost the cut) | 3 | The take's numbered lines, the draft plan, the deterministic findings | `EditorCritique` (zod, `packages/agents/src/editor-agent.ts`) | MEDIUM | No |
| Flow Check (`FLOW_CHECK`, AI edit read-through) | Hears the kept lines in output order as a cold viewer and returns the junctions that don't follow — a "so"/"that" pointing at a cut line, a reveal before its setup, a fragment, a repeat — with ONE surgical fix each (RESTORE a cut line / DROP the dependent / NONE); never the hook (reports `hookProblem` instead); names the one quotable line. The editor applies fixes as Full-edit `forceKeep`/`forceDrop` and re-cuts (≤ 4 fixes) | 3 | `FullEditReport.kept` (output order) + `removed`, hook sentence ids, brief | `FlowCheck` (zod, `packages/agents/src/flow-check-agent.ts`) | MEDIUM | No |
| Footage Brief (`FOOTAGE_BRIEF`, AI edit step 0) | Recovers the Creative Brief from a filmed take that has none on record: hooks and story beats are sentences he said (never invented), series by mechanism, ending objective read off the filmed ending, every stated number listed as unverified. Recorded as a `CreativeBrief` row (source FOOTAGE) so the free Full edit, hook picker, visual strategist, captions and viewer check all follow it | 3 | Transcript, title, length, brand context + full playbook | `ScriptCreativeBrief` (zod, `packages/agents/src/schemas.ts`) → `CreativeBrief` row | MEDIUM | No |
| Plan Importer (optional "Clean up with AI") | Restructures Chris's pasted video plan into rows when the deterministic parser can't; transcribes, never invents (code drops titles/hooks not in the text) | 3 | Raw plan text, today/start date, enabled platforms | `PlanImporterResult` (rows for the import preview — nothing is created until Chris confirms) | MEDIUM | No |
| Director chat (`DIRECTOR_CHAT`; free path = Chris's own ChatGPT answering the same pack) | Turns Chris's description of a video (often face-driven, no speech) into edit instructions; follow-ups are deltas | 3 (Chris's message is authority 1 inside it) | Chris's message + conversation, previous applied instructions, word timings, approximate FER+ expression timeline + events, face/free-space layout, labelled frames image, current edit ids, graphics vocabulary | `DirectorAnswer` (zod, `@chris/media/director` schema.ts; paid wire = `reply` + `operations_json`) → applied deterministically as a new EditPlan version | MEDIUM (vision) — only with AI credit; default $0 via ChatGPT | No |

### Mini-movie Studio crew (2026-10-18 — `$0`; see `docs/decisions-pending/studio-crew.md`)

One deterministic orchestrator (`packages/agents/src/studio/pipeline.ts`) drives the crew; the
creative members run as **two ChatGPT copy-paste round trips** (WRITE, REVIEW — each section of the
answer is that member's own typed artifact) or the optional free local model; never a billed
provider (`FreeModelProvider` only). Schemas: `packages/agents/src/studio/schemas.ts`.

| Agent | Role | Authority level | Primary input(s) | Output artifact | Model class | Can hard-BLOCK? |
|---|---|---|---|---|---|---|
| Film Director (`FILM_DIRECTOR`) | Owns the brief and the good-enough / revise / stop call; reconciles reports by the authority hierarchy | 2/3 (Creative-Director tier for one film; a code guard makes it stricter-only) | Chris's idea/length/look/narrator, BrandConstitution, ChrisBrain, all crew reports | `FilmBrief`, `DirectorDecision` → guarded `FinalDecision` | HIGH (via ChatGPT / local) | No — cannot approve over a gate (type-enforced) |
| Hook (`FILM_HOOK`) | ≥ 5 opening line + first-frame options, scored as estimates | 3 | FilmBrief, catalog, ChrisBrain | `HookSet` | MEDIUM | No |
| Screenwriter (`FILM_SCREENWRITER`) | Narration in Chris's voice, one metaphor, numbers/calculations/claims declared | 3 | FilmBrief, HookSet, BrandConstitution, ChrisBrain | `FilmScript` | MEDIUM | No |
| Cinematographer (`FILM_CINEMATOGRAPHER`) | Shots that literally show each line, catalog vocabulary only | 3 | FilmScript, FilmBrief, engine catalog + DSL reference | `ShotPlan` (film DSL) | MEDIUM | No |
| Meaning-Match (`FILM_MEANING_MATCH`) | Does each picture show what's said? | 3 (rule MISMATCHes force a revision while rounds remain) | Storyboard contact sheet, DSL + script, first pass | `MeaningMatchReport` | DETERMINISTIC + LOCAL_EMBEDDING first pass; HIGH vision second pass | No (forces revision, not a gate) |
| Cohesion (`FILM_COHESION`) | One world, one metaphor, story logic, ending | 3 | DSL + script, contact sheet, brief | `CohesionReport` | MEDIUM | No |
| Retention (`FILM_RETENTION`) | Cold-viewer attention per beat (estimates), drop-off fixes | 3 (advisory) | Script + DSL, contact sheet, reference pacing | `RetentionReport` | MEDIUM | No |
| Quality (`FILM_QUALITY`) | Premium bar on a phone: safe zones, legibility, framing, lighting, loudness | 3 (measured BLOCKING on the render feeds TECHNICAL) | Contact sheet / rendered frames, automatic findings | `QualityReport` + deterministic `QualityIssue[]` | DETERMINISTIC + MEDIUM vision | Feeds TECHNICAL gate |
| Verification (code) | Recompute every on-screen/said number; trace every number; Chris confirms facts; fact-check BLOCK | 2 (Hard Gate) | FilmScript, film DSL, FactCheck | `VerificationReport` | DETERMINISTIC | **Yes** |
| Continuity (code) | Objects/counts/screen direction/lighting consistent | 3 | film DSL | `ContinuityIssue[]` | DETERMINISTIC | No |
| Fact check (reuses `CLAIMS_GATE` rules/shape) | Independent factual review of the film's lines | 2 (BLOCK feeds Verification) | Script, claims | `FactCheck` (= `ClaimsGateResult` fields) | HIGH via ChatGPT — never billed | Via Verification |
| Analysis (`FILM_ANALYSIS`, Viewer Panel idea) | First-time viewer read of the finished film | 3 (advisory, optional) | Rendered-frame contact sheet, script | `FinalPackResponse.analysis` | HIGH (via ChatGPT / local) | No |

## Notes

- "Authority level" refers to `/docs/ARCHITECTURE.md`'s hierarchy (1 = Human Owner, 2 = Hard
  Gate / Creative Director tier, 3 = Specialist, 4 = Learning System). Only Claims Gate sits at
  the true Hard Gate tier with unilateral BLOCK power; everything else either feeds a gate or
  advises the Creative Director.
- Model class follows `/docs/ARCHITECTURE.md`'s routing table (HIGH / MEDIUM / LOW /
  DETERMINISTIC). Technical QC itself is not listed here because it is deterministic code, not
  an agent — see `/docs/PHASE_PLAN.md` Phase 4.
- Every agent's prompt file under `/prompts/agents/` names its `required_context` in
  frontmatter; that list must match the "Primary input(s)" column above.
