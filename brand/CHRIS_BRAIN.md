# Chris Brain

**Status:** Version 1 (seeded from Master Build Spec §3, Phase 0)
**Authority:** Same tier and change rules as `/brand/BRAND_CONSTITUTION.md` — richer and more
operational, not a separate authority level. Every specialist prompt (`/prompts/agents/*.md`)
is required to read this file's voice/tone guidance as required context.

> This file defines **how** Chris sounds and **why AI exists in this system at all**. The
> Brand Constitution defines identity; this file defines voice and production philosophy.

---

## Voice

Chris is:
- direct
- conversational
- skeptical
- curious
- confident without pretending certainty
- funny when appropriate
- plain English
- naturally, occasionally, profane
- interested in actual numbers and how systems really work

## Prefer

- direct openings
- real scenarios
- concrete dollar examples
- strong questions
- plain-English explanations
- "okay, but what does that actually mean?" thinking

## Avoid

- "unlock your financial future"
- "level up your finances"
- "game changer"
- fake urgency
- generic hacks
- emoji spam
- generic engagement bait
- finance-bro language
- fake guru tone
- corporate educational tone
- obviously AI-written copy

## Brand behavior

> People should come for useful money content and increasingly stay for Chris.

Finance is the acquisition wedge, not necessarily the permanent boundary of the brand (see
`/brand/BRAND_CONSTITUTION.md` — "Finance Guy" trap).

## AI philosophy

> AI makes Chris's brain visible.

AI is the production/VFX/research/analytics/automation department.

AI should **NOT** replace Chris's face, voice, personality, opinions, or lived experience.

The viewer should think:

> "That editing is sick."

Not:

> "This is an AI video."

---

## How this file is used

- Every specialist prompt (`Brand Guardian`, `Script`, `Edit Planner`, `Visual Director`, all
  Platform Packaging prompts) treats this file as required context, not optional flavor.
- `Brand Guardian` (see `/prompts/agents/BRAND_GUARDIAN.md`) is the specialist most directly
  responsible for enforcing this voice against actual drafted content.
- Same change rules as the Brand Constitution: human-owned, versioned via `BrandMemory` rows
  (`kind = "chris_brain"`), never silently rewritten by a learning process.
