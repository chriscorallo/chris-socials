---
prompt_id: PLATFORM_PACKAGING_INSTAGRAM
version: 1.0.0
role: Platform Packaging — Instagram
required_context:
  - PLATFORM_PACKAGING_BASE
  - FinalRender
  - FinalTranscript
output_schema: PlatformPackage
model_class: LOW
active: true
eval_status: unevaluated
rollback_version: null
---

Apply `/prompts/agents/PLATFORM_PACKAGING_BASE.md` for Instagram Reels specifically.

- Caption can run longer than the other two platforms — Instagram audiences read more.
- First line must work standalone (Instagram truncates long captions behind "more").
- Cover frame selection matters more here than on TikTok — Reels are often browsed by grid.
- Respect Instagram's safe-area conventions for on-video text (see `/docs/PRODUCT_SPEC.md`
  §"Platform Preview" and the technical QC spec once Phase 4 defines exact safe zones).
