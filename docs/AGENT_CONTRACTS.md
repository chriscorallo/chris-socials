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

## Roster

| Agent | Role | Authority level | Primary input(s) | Output artifact | Model class | Can hard-BLOCK? |
|---|---|---|---|---|---|---|
| Creative Director | Owns weekly coherence and long-term brand direction; resolves specialist conflicts | 2 (Creative Director) | Brand Constitution, Strategic Memory, recent performance, active experiments, weekly slate | `WeeklyProgrammingThesis` decision record | HIGH | No — cannot bypass hard gates |
| Weekly Strategist | Builds the coherent ~30-video weekly portfolio | 3 (Specialist) | `WeeklyProgrammingThesis`, historical evidence, production constraints | `WeeklySlate` + per-idea allocation | HIGH | No |
| Research Agent | Gathers enough reliable info to safely film a specific claim | 3 | `ProductionContract` | `ResearchPacket` (status: `READY` / `NEEDS_MORE_RESEARCH` / `UNSUPPORTED` / `OUT_OF_SCOPE`) | MEDIUM | No (feeds the gate, doesn't gate itself) |
| Claims Gate | Independently reviews factual claims | 2 (Hard Gate) | `ResearchPacket`, `ScriptVersion` | `ClaimsGateResult` (`PASS` / `PASS_WITH_REQUIRED_EDIT` / `BLOCK`) | HIGH | **Yes** |
| Reference Intelligence | Studies external creators for transferable principles | 3 | `ReferenceContent`, Chris historical data | `ReferenceObservation` (observed / likely principle / transferability / risks / test required) | MEDIUM | No |
| Script Agent | Writes Chris-native spoken scripts | 3 | `ResearchPacket` (when factual), `ProductionContract` | `ScriptVersion` | MEDIUM | No |
| Brand Guardian | Protects voice, identity, originality, strategic fit | 3 (but its threshold is a hard gate input) | `ScriptVersion` / `Render`, Brand Constitution, Chris Brain | Brand/Voice/Originality/Strategic-Fit scores + required changes | MEDIUM | No directly — feeds the `BRAND: threshold` hard gate |
| Production Director | Assigns production tier, batches filming, builds Creator Cards | 3 | `WeeklySlate`, physical setup constraints | `CreatorCard` per idea, filming order | LOW/MEDIUM | No |
| Take Selector | Chooses the strongest usable take | 3 | `RawTake` set (transcript, technical + performance signals) | `TakeSelection` (selected + backup + defects) | MEDIUM (vision) | No |
| Edit Planner | Deterministic editorial decision-maker; does not render | 3 | `TakeSelection`, `ProductionContract`, asset library | `EditPlan` | HIGH/MEDIUM | No |
| Motion Designer | Proposes animated explainer graphics (motion-contract templates) timed to the transcript; numbers grounded in research/script by code, placement solved deterministically | 3 | `EditTimeline`, timestamped transcript, `ResearchPacket`, gated `ScriptVersion`, `ProductionContract` tier | `MotionDesignerOutput` -> `TimelineVisual[]` (+ `rejectedVisuals`) | MEDIUM | No |
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
