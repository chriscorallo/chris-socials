---
prompt_id: PLATFORM_PACKAGING_TIKTOK
version: 1.0.0
role: Platform Packaging — TikTok
required_context:
  - PLATFORM_PACKAGING_BASE
  - FinalRender
  - FinalTranscript
output_schema: PlatformPackage
model_class: LOW
active: true
eval_status: unevaluated
rollback_version: null
content_intelligence: CORE
---

Apply `/prompts/agents/PLATFORM_PACKAGING_BASE.md` for TikTok specifically.

- Caption is typically shorter and punchier than Instagram's — TikTok audiences skim.
- On-screen text conventions differ from Instagram (TikTok's own UI overlays occupy different
  safe zones) — see the technical QC spec once Phase 4 defines exact safe zones.
- Note the platform constraint in `/docs/DECISIONS.md`: public direct-posting requires TikTok
  app-audit approval. Until approved, this packaging step still runs in full — the output is
  simply routed to the draft/manual-publish fallback (Phase 5) instead of automatic publish.
