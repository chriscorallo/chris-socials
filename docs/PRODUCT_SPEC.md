# Product Spec

**Source of truth:** `Chris_Content_Intelligence_Compact_Master_Spec.md` (repo root — kept
as the canonical spec file, referenced below by section number, e.g. §9). This document
condenses and organizes it; it does not replace it. If this document and the spec file ever
disagree, the spec file wins and the discrepancy must be logged in `/docs/DECISIONS.md`.

## What this is

An AI-operated creative production and intelligence system for the Chris Corallo personal
brand — not a scheduler, not a caption tool, not a generic AI dashboard (§ purpose). It plans,
researches, prepares, films-supports, edits, quality-checks, packages, publishes, measures,
and learns from short-form content, at a target operating volume of ~30 originals/week across
Instagram Reels, TikTok, and YouTube Shorts (~90 placements/week). **This volume is an
operational ceiling to test, not a permanent requirement** — the system must be able to
conclude later that fewer, better pieces produce superior marginal return.

## Objective function (non-negotiable)

> Maximize long-term attention, recognition, trust, audience quality, brand equity, and
> economic value of the Chris Corallo personal brand while preserving authenticity, factual
> integrity, creative quality, and sustainable production.

**Not:** maximize views on the next video. A video with fewer views can be more strategically
valuable if it produces stronger follower conversion, trust, or brand expansion. See
`/docs/AGENT_CONTRACTS.md` (Analytics Agent) for how this is operationalized against vanity
metrics.

## Product philosophy

> Eliminate everything that prevents Chris from being the valuable part.

Chris's time: thinking, learning, building expertise, living experiences worth discussing,
forming opinions, filming, relationships, actual business/career work, high-value creative
decisions.

The system's job: research prep, planning, content organization, repetitive editing,
rendering, captions/graphics, QC, scheduling, platform packaging, publishing, analytics,
comments, experimentation, learning, institutional memory.

Premium means: correct, intentional, reliable, context-aware, polished when appropriate,
**restrained when appropriate**, factually defensible, simple for Chris, scalable, and not
obviously AI-generated. Premium does **not** mean maximum complexity or maximum editing — the
Edit Planner must be able to conclude `DO NOTHING ELSE` (§10).

## Brand

Full identity, audience, ethos, pillars, and principles live in `/brand/BRAND_CONSTITUTION.md`.
Voice, tone, and AI philosophy live in `/brand/CHRIS_BRAIN.md`. This spec does not duplicate
them — every agent reads those files as required context (`/docs/AGENT_CONTRACTS.md`).

## Canonical weekly workflow (§9)

The system runs one recurring loop, in this order. Each numbered artifact below is a typed
entity — see `/docs/DATA_MODEL.md` for schema and `/docs/AGENT_CONTRACTS.md` for which
specialist produces it.

1. **Weekly Review** — collect prior metrics, audience response, experiments, production cost,
   human overrides.
2. **Weekly Programming Thesis** — one concise strategic truth binding the week.
3. **Portfolio Design** — ~30 videos built as one coherent portfolio (acquisition, authority,
   relationship, brand expansion, conversion, finance/personality balance, formats, production
   tiers, experiments, MHI alignment, evergreen/time-sensitive balance, production burden).
4. **Production Contract** — purpose, core idea, audience promise, topic, format, tier, target
   length, research depth, factual risk, experiment, platform opportunity, edit budget,
   required assets, scope, and a mandatory `DO_NOT_EXPAND_INTO` field.
5. **Research** — facts before scripts for factual finance content. Returns primary claim,
   facts, sources, numeric inputs, caveats, contradictory evidence, unsupported claims,
   confidence, and an explicit `STOP_RESEARCHING` signal.
6. **Claims Gate** — independent factual review: `PASS` / `PASS_WITH_REQUIRED_EDIT` / `BLOCK`.
7. **Script** — spoken delivery, one central promise, default `HOOK / BEAT 1 / BEAT 2 / BEAT 3
   / PAYOFF` structure when useful (not a forced formula).
8. **Creator Card** — only what Chris needs to film. No research burden while filming.
9. **Film Queue** — batched by physical setup (desk / standing / casual / walking / skit /
   special). No research required during normal filming unless the current claim becomes
   invalid.
10. **Raw Media Ingestion** — store originals permanently; generate transcript, technical
    metadata, scene/audio/visual analysis, take groups.
11. **Take Selection** — best usable take by accuracy, completeness, clarity, energy, pacing,
    framing, audio, runtime, editability. Alternatives preserved.
12. **Edit Plan** — the LLM decides, the renderer executes. Specifies cuts, captions, headline,
    typography, positions, punch-ins, reframing, graphics/charts, B-roll, music, SFX,
    transitions, AI-media requests, output duration, and platform variants.
13. **Render** — deterministic media tools (ffmpeg-class), not improvisation.
14. **Visual QA** — inspects the actual rendered file over time: face/eye/mouth obstruction,
    headline/caption collision, safe zones, cropping, legibility, contrast, chart/number
    accuracy, first-frame comprehension, artifacts, tier-appropriateness.
15. **Auto-Repair** — `EDIT → RENDER → INSPECT → FIX → RENDER → REINSPECT` with a hard
    iteration limit.
16. **Hard Gates** — `FACTUAL: PASS`, `TECHNICAL: PASS`, `BRAND: threshold`, `CREATIVE:
    threshold`. A single averaged score can never hide a catastrophic failure — see
    `/docs/ARCHITECTURE.md` (Authority Model).
17. **Platform Preview** — simulated IG/TikTok/YouTube safe areas; prefer one master render +
    lightweight variants over three fully separate edits.
18. **Weekly Assembly** — Content Vault backups cover a failed asset; one failure never blocks
    the whole week.
19. **Auto-Fill Week** — schedules by topic spacing, format spacing, tone, funnel role, active
    experiments, newsletter timing, platform evidence, content expiry.
20. **Platform Packaging** — generated only after the final render exists; IG/TikTok/YouTube
    each get distinct treatment.
21. **Preflight** — verifies file/version/hash, credentials, account, packaging, schedule,
    media spec, approval state, no active block, idempotency key.
22. **Publish + Verify** — stores platform, post ID, URL, timestamp, exact packaging used,
    media hash, and the raw platform response. A publish is not "done" until verified.
23. **Metric Snapshots** — where the platform actually supports it: T+1h / 6h / 24h / 72h /
    7d / 30d. Never fabricate an unavailable metric.
24. **Audience Intelligence** — classifies comments into questions, confusion, objections,
    disagreements, stories, requested topics, repeated language, sentiment, misconceptions;
    converts strong signals into future videos, script improvements, FAQ knowledge, newsletter
    ideas, community lessons.
25. **Performance Evaluation** — tracks attention, consumption, amplification, conversation,
    identity conversion, relationship, business outcome, production ROI — not views alone.
26. **Learning** — separates `OBSERVATION` from `CAUSAL CLAIM` from `EXPERIMENTAL EVIDENCE`;
    stores uncertainty explicitly.
27. **Next Week** — accepted learnings feed the next Weekly Programming Thesis.

## Production tiers (§10)

- **RAW** — minimal trim/audio/captions/framing.
- **FAST** — template-driven, high automation.
- **MEDIUM** — deliberate graphics/pacing.
- **HERO** — highest creative freedom; may include advanced compositing/VFX/generative media
  and manual Chris involvement.

The editor must be able to conclude `DO NOTHING ELSE`. Premium ≠ more editing.

## UI principle (§20)

Primary nav: `CALENDAR / CONTENT / ANALYTICS / LEARNINGS / IDEAS`.
Home: `THIS WEEK / PERFORMANCE / CREATIVE DIRECTOR / NEEDS YOU`.

The backend may track hundreds of metrics; Chris sees only what's materially actionable by
default. `NEEDS YOU` surfaces only: subjective creative choice, ambiguous factual nuance,
unresolved QC, platform issues, approval-required content, strategic decisions, or system
uncertainty above threshold. Avoid approval fatigue.

## Graceful failure (§21)

- Reference monitoring fails → production continues.
- One video fails → use a Content Vault backup.
- One platform fails → the others continue.
- Analytics delayed → publishing continues.
- AI-generated media fails → fall back to a non-generative asset.
- One model provider fails → fall back when safe.

## Autonomy levels (§23)

- **0 — Shadow:** AI recommends only; Chris runs the normal workflow.
- **1 — Assisted:** AI produces; Chris approves everything.
- **2 — Trusted routine:** selected RAW/FAST workflows need reduced review. Hard gates remain.
- **3 — Broader autonomy:** approved content classes may auto-schedule/publish.
- **4 — High autonomy:** only after demonstrated reliability, earned separately per subsystem.
  HERO/high-risk/ambiguous content may require human review permanently.

## Explicitly out of scope (§26)

Unless a validated need later proves otherwise: a full Premiere replacement, automated mass
commenting, follow/unfollow automation, spam engagement, auto-DMs, a large CRM, broad revenue
attribution, a native mobile app, custom foundation-model training, uncontrolled trend
scraping, hundreds of micro-agents, real-time agent interruption while Chris is filming.

## Final Test

Before any implementation or product decision:

> Does this make the system more capable, reliable, and intelligent while making Chris's real
> workflow simpler?

- Increases sophistication but increases Chris's friction → reconsider.
- Saves time but materially damages quality, authenticity, or brand identity → reconsider.
- Increases quality but consumes unreasonable human attention for negligible benefit →
  reconsider.

The product is **a premium AI creative organization in software** — not a dashboard full of
AI features.
