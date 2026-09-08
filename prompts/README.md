# Prompt Registry

Prompts are version-controlled Markdown files, not a database table (see
`/docs/DECISIONS.md` for why). `packages/prompts` loads and validates every file under
`/prompts/shared/` and `/prompts/agents/` against the format below.

## File format

Every prompt file starts with YAML frontmatter, then the prompt body as Markdown:

```markdown
---
prompt_id: SCRIPT
version: 1.0.0
role: Script Agent
required_context:
  - BrandConstitution
  - ChrisBrain
  - ProductionContract
  - ResearchPacket
output_schema: ScriptVersion
model_class: MEDIUM
active: true
eval_status: unevaluated
rollback_version: null
---

<prompt body>
```

### Required fields

| Field | Meaning |
|---|---|
| `prompt_id` | Stable identifier, matches the agent's row in `/docs/AGENT_CONTRACTS.md` |
| `version` | Semantic version. Bump on any substantive change to the prompt body |
| `role` | Human-readable role name |
| `required_context` | Artifact/document types this prompt needs as input — must match `/docs/AGENT_CONTRACTS.md`'s "Primary input(s)" column |
| `output_schema` | Name of the typed output shape this prompt must produce |
| `model_class` | One of `HIGH`, `MEDIUM`, `LOW`, `DETERMINISTIC` — per `/docs/ARCHITECTURE.md`'s routing table |
| `active` | Whether this version is the one currently in use |
| `eval_status` | `unevaluated` \| `passed` \| `failed` — see `/docs/EVALUATION_PLAN.md`'s prompt-eval rule (enforced starting Phase 2) |
| `rollback_version` | The previous `version` string to revert to if this one fails evaluation, or `null` for the first version |

## Authoring rules

- **Never silently mutate an active prompt.** To change a prompt: write a new version block
  (or a new file revision), set the new one's `active: true`, set the old one's `active:
  false` and leave it in git history — the rollback path is "flip `active` back," not "revert
  and lose the diff."
- Exactly one version per `prompt_id` may have `active: true` at a time. The loader rejects
  the registry if it finds zero or more than one.
- A prompt cannot move from `active: false` to `active: true` with `eval_status:
  unevaluated` once evals exist (Phase 2+) — see `/docs/EVALUATION_PLAN.md`.
- Prompt bodies follow the shared rules in `/prompts/shared/SYSTEM_BASE.md` — every
  specialist prompt is loaded *together with* `SYSTEM_BASE.md`, not instead of it.

## Files

- `/prompts/shared/SYSTEM_BASE.md` — shared system prompt every specialist receives first.
- `/prompts/agents/*.md` — one file per role in `/docs/AGENT_CONTRACTS.md`'s roster.
