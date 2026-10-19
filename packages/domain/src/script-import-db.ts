import { createHash } from "node:crypto";
import type { ContentItem, ContentState, PrismaClient } from "@prisma/client";
import { z } from "zod";
import { recordAudit } from "./audit";
import { recordCreativeBrief } from "./creative-brief";
import { journalDecision } from "./decision-journal";
import { applyTransition } from "./state-machine";
import { createProductionContractAndAdvance } from "./production-contract";
import { commitPlanImport, listExistingPlanned, listPlannedVideos } from "./plan-import-db";
import { PRE_FILM_STATES } from "./plan-import/status";
import { dedupeKey, enabledPlatformsOf } from "./plan-import/preview";
import type { PostingPlanData } from "./posting-plan-core";
import { ymdInTz } from "./tz";
import { parseChatGptScripts, straightenQuotes, type ParsedScriptBlock } from "./script-import/parse";
import { videoCode } from "./script-import/match";
import { estimateSecondsAt, splitPlannedDescription, DEFAULT_SCRIPT_WPM } from "./script-import/prompt";

/**
 * Scripts from ChatGPT — the persistence half (the prompt / parser / matcher are the
 * browser-safe ./script-import). Chris pastes ChatGPT's answer; each script he confirms becomes
 * a NEW ScriptVersion on its planned video — never an overwrite (CLAUDE.md).
 *
 * Honesty rules, same as footage-first (see footage-first.ts):
 *  - authorType "IMPORTED", revisionNote names the source, and the raw pasted block is kept in
 *    the permanent AuditLog row (SCRIPT_IMPORTED) — provenance for every word;
 *  - the version has NO Claims Gate verdict, and isScriptVersionFilmable / the FACTUAL hard
 *    gate treat an unchecked non-agent script as unchecked (they never fall back to an older
 *    research verdict) — so the video still can't be posted until its claims are checked;
 *  - a planned video still in planning (IDEA … SCRIPTING) is walked to SCRIPTED with one
 *    transition per step, reason "Script imported from ChatGPT …" (IDEA -> SELECTED is HUMAN);
 *    a missing Production Contract is STANDARD research / MEDIUM risk — never the
 *    fact-check-exempt NONE/LOW combination.
 * Idempotent: the same script text for the same video is saved once (sha256 of the
 * normalized text, checked against every existing version), so re-pasting the same answer, a
 * double tap or a retry never duplicates. See docs/decisions-pending/chatgpt-scripts.md.
 */

export const SCRIPT_IMPORT_AUTHOR = "IMPORTED";
export const SCRIPT_IMPORT_SOURCE = "ChatGPT (pasted by Chris)";
export const SCRIPT_IMPORT_REASON = "Script imported from ChatGPT (pasted by Chris) — not fact-checked yet; the factual check is still required before posting";

/** Where an imported script came from — the copy-paste screen by default; the ChatGPT connector
 * passes its own (chatgpt-connector.ts). Lands in revisionNote, the audit row and transition reasons. */
export interface ScriptImportProvenance {
  source: string;
  reason: string;
  /** Extra AuditLog metadata (e.g. the connector grant id). */
  auditMetadata?: Record<string, unknown>;
}
const PASTE_PROVENANCE: ScriptImportProvenance = { source: SCRIPT_IMPORT_SOURCE, reason: SCRIPT_IMPORT_REASON };

/** A script can be added while the video isn't filmed yet (and while a fact-check block is being fixed). */
export const SCRIPT_IMPORTABLE_STATES: ReadonlySet<ContentState> = new Set<ContentState>([...PRE_FILM_STATES, "RESEARCH_BLOCKED"]);

/** Planning states the import walks forward to SCRIPTED. RESEARCHING (an AI run may be in
 * flight), RESEARCH_BLOCKED, SCRIPTED and READY_TO_FILM keep their state — they just gain a version. */
const WALKABLE: ReadonlySet<ContentState> = new Set<ContentState>(["IDEA", "SELECTED", "CONTRACTED", "RESEARCHED", "SCRIPTING"]);
const PATH: ContentState[] = ["IDEA", "SELECTED", "CONTRACTED", "RESEARCHING", "RESEARCHED", "SCRIPTING", "SCRIPTED"];

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Same words = same script (case, quotes, spacing and punctuation spacing ignored). */
export function scriptTextHash(text: string): string {
  return sha256(straightenQuotes(text).toLowerCase().replace(/\s+/g, " ").replace(/\s+([.,!?;:])/g, "$1").trim());
}

export interface ScriptImportTarget {
  id: string;
  code: string;
  title: string;
  ymd: string;
  time: string;
  state: ContentState;
  hook: string | null;
  notes: string | null;
  scriptCount: number;
  /** First words of the latest script, for "Replace (keeps the old version)". */
  latestScript: { excerpt: string; authorType: string } | null;
}

/**
 * Every dated, not-yet-filmed video (any date, so an older answer still matches), oldest
 * first, with its script status. Sequential queries (PGlite).
 */
export async function listScriptImportTargets(prisma: PrismaClient, opts: { tz: string }): Promise<ScriptImportTarget[]> {
  const planned = (await listPlannedVideos(prisma, { tz: opts.tz })).filter((v) => SCRIPT_IMPORTABLE_STATES.has(v.state));
  const ids = planned.map((v) => v.id);
  const versions = ids.length
    ? await prisma.scriptVersion.findMany({
        where: { contentItemId: { in: ids } },
        orderBy: { createdAt: "desc" },
        select: { contentItemId: true, spokenScript: true, authorType: true },
      })
    : [];
  const byItem = new Map<string, { count: number; latest: { spokenScript: string; authorType: string } }>();
  for (const v of versions) {
    const cur = byItem.get(v.contentItemId);
    if (cur) cur.count++;
    else byItem.set(v.contentItemId, { count: 1, latest: v });
  }
  return planned.map((v) => {
    const s = byItem.get(v.id);
    const { hook, notes } = splitPlannedDescription(v.description);
    const excerpt = s ? s.latest.spokenScript.replace(/\s+/g, " ").trim() : "";
    return {
      id: v.id,
      code: videoCode(v.id),
      title: v.title,
      ymd: v.ymd,
      time: v.time,
      state: v.state,
      hook,
      notes,
      scriptCount: s?.count ?? 0,
      latestScript: s ? { excerpt: excerpt.length > 140 ? `${excerpt.slice(0, 139)}…` : excerpt, authorType: s.latest.authorType } : null,
    };
  });
}

/** Planned, not filmed, no script yet — from `fromYmd` on (the Plan board's banner count). */
export async function countVideosNeedingScripts(prisma: PrismaClient, opts: { tz: string; fromYmd?: string }): Promise<number> {
  const targets = await listScriptImportTargets(prisma, { tz: opts.tz });
  return targets.filter((t) => t.scriptCount === 0 && PRE_FILM_STATES.has(t.state) && (!opts.fromYmd || t.ymd >= opts.fromYmd)).length;
}

const SaveItemSchema = z.object({
  /** The block exactly as pasted — re-parsed here, so what's saved is what the parser reads. */
  rawBlock: z.string().min(1).max(30_000),
  contentItemId: z.string().min(1).nullable().optional(),
  /** "Create as a new planned video" for a script with no planned video. */
  newVideo: z.object({ title: z.string().trim().min(1).max(300), ymd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).nullable().optional(),
  /** The video already has a script: add this one as the newest version (the old one is kept). */
  replace: z.boolean().optional(),
});

export const SaveImportedScriptsSchema = z.object({
  rawPaste: z.string().max(400_000),
  items: z.array(SaveItemSchema).min(1).max(200),
});
export type SaveImportedScriptsInput = z.input<typeof SaveImportedScriptsSchema>;

export type SaveScriptStatus = "saved" | "already-saved" | "has-script" | "not-importable" | "failed";

export interface SaveScriptOutcome {
  index: number;
  contentItemId: string | null;
  title: string;
  status: SaveScriptStatus;
  message: string;
  scriptVersionId?: string;
  createdVideo?: boolean;
}

export interface SaveImportedScriptsResult {
  batchId: string;
  saved: number;
  outcomes: SaveScriptOutcome[];
}

interface SaveOptions {
  tz: string;
  plan: Pick<PostingPlanData, "cadences"> | null;
  /** Chris's pace, for the stored speaking estimate. */
  wpm?: number;
  /** Target length range embedded in the prompt (stored as the version's target runtime). */
  targetSeconds?: { min: number; max: number };
  now?: Date;
}

export async function saveImportedScripts(
  prisma: PrismaClient,
  input: SaveImportedScriptsInput,
  actor: { actorId: string },
  opts: SaveOptions,
): Promise<SaveImportedScriptsResult> {
  const parsed = SaveImportedScriptsSchema.parse(input);
  const today = ymdInTz(opts.now ?? new Date(), opts.tz);
  const batchId = sha256(parsed.rawPaste || parsed.items.map((i) => i.rawBlock).join("\n")).slice(0, 24);
  const outcomes: SaveScriptOutcome[] = [];

  // Sequential on purpose (PGlite; and one bad script must not sink the rest).
  for (const [index, it] of parsed.items.entries()) {
    const block = parseChatGptScripts(it.rawBlock, { today }).blocks[0];
    const title = it.newVideo?.title ?? block?.title ?? "Script";
    try {
      if (!block || !block.spokenScript.trim()) {
        outcomes.push({ index, contentItemId: it.contentItemId ?? null, title, status: "failed", message: "Couldn't read a script in that block." });
        continue;
      }
      let contentItemId = it.contentItemId ?? null;
      let createdVideo = false;
      if (!contentItemId && it.newVideo) {
        contentItemId = await createPlannedVideoForScript(prisma, it.newVideo, block, actor, opts);
        createdVideo = true;
      }
      if (!contentItemId) {
        outcomes.push({ index, contentItemId: null, title, status: "failed", message: "Pick a video for this script first." });
        continue;
      }
      const r = await saveImportedScript(prisma, { contentItemId, block, replace: !!it.replace, batchId }, actor, opts);
      outcomes.push({ index, contentItemId, title: r.title, status: r.status, message: r.message, scriptVersionId: r.scriptVersionId, createdVideo });
    } catch (err) {
      outcomes.push({ index, contentItemId: it.contentItemId ?? null, title, status: "failed", message: err instanceof Error ? err.message : String(err) });
    }
  }

  const saved = outcomes.filter((o) => o.status === "saved").length;
  await recordAudit(prisma, {
    actor: actor.actorId,
    actorType: "HUMAN",
    action: "SCRIPTS_IMPORTED_FROM_CHATGPT",
    entityType: "ScriptImport",
    entityId: batchId,
    after: {
      source: SCRIPT_IMPORT_SOURCE,
      items: parsed.items.length,
      saved,
      alreadySaved: outcomes.filter((o) => o.status === "already-saved").length,
      skipped: outcomes.filter((o) => o.status === "has-script" || o.status === "not-importable").length,
      failed: outcomes.filter((o) => o.status === "failed").length,
      createdVideos: outcomes.filter((o) => o.createdVideo).length,
    },
    metadata: { rawPasteSha256: sha256(parsed.rawPaste), rawPasteExcerpt: parsed.rawPaste.slice(0, 2000) },
  });
  return { batchId, saved, outcomes };
}

/** A script with no planned video → a new planned video through the normal plan-import path. */
async function createPlannedVideoForScript(
  prisma: PrismaClient,
  video: { title: string; ymd: string },
  block: ParsedScriptBlock,
  actor: { actorId: string },
  opts: SaveOptions,
): Promise<string> {
  const platforms = enabledPlatformsOf(opts.plan);
  await commitPlanImport(
    prisma,
    {
      sourceKind: "TEXT",
      sourceRef: "Scripts from ChatGPT",
      rawInput: block.raw,
      rows: [{ title: video.title, ymd: video.ymd, time: null, platforms, hook: block.hook, notes: null, format: null, pillar: null }],
    },
    actor,
    { tz: opts.tz, plan: opts.plan },
  );
  // Created now, or already planned under the same title that day (plan import's duplicate check).
  const key = dedupeKey(video.title, video.ymd);
  const hit = (await listExistingPlanned(prisma, opts.tz)).find((e) => dedupeKey(e.title, e.ymd) === key);
  if (!hit?.contentItemId) throw new Error("Couldn't create the new planned video.");
  return hit.contentItemId;
}

export async function saveImportedScript(
  prisma: PrismaClient,
  input: { contentItemId: string; block: ParsedScriptBlock; replace: boolean; batchId?: string },
  actor: { actorId: string },
  opts: Pick<SaveOptions, "wpm" | "targetSeconds"> & { provenance?: ScriptImportProvenance } = {},
): Promise<{ status: SaveScriptStatus; message: string; title: string; scriptVersionId?: string }> {
  const { block } = input;
  const prov = opts.provenance ?? PASTE_PROVENANCE;
  const item = await prisma.contentItem.findUniqueOrThrow({ where: { id: input.contentItemId } });
  if (!SCRIPT_IMPORTABLE_STATES.has(item.currentState)) {
    return { status: "not-importable", title: item.title, message: "Already filmed — the script wasn't changed." };
  }
  const spokenScript = block.spokenScript.trim();
  const hash = scriptTextHash(spokenScript);
  const versions = await prisma.scriptVersion.findMany({
    where: { contentItemId: item.id },
    orderBy: { createdAt: "desc" },
    select: { id: true, spokenScript: true, authorType: true },
  });
  const same = versions.find((v) => scriptTextHash(v.spokenScript) === hash);
  if (same) {
    // Finish a walk an interrupted earlier save didn't complete (no-op otherwise).
    if (versions[0]?.id === same.id) await walkToScripted(prisma, item, actor, prov.reason);
    return { status: "already-saved", title: item.title, message: "This script is already saved.", scriptVersionId: same.id };
  }
  const latest = versions[0] ?? null;
  if (latest && !input.replace) {
    return { status: "has-script", title: item.title, message: "Already has a script — skipped." };
  }

  const contract = await prisma.productionContract.findUnique({ where: { contentItemId: item.id } });
  const wpm = opts.wpm && opts.wpm > 60 ? opts.wpm : DEFAULT_SCRIPT_WPM;
  const note = `Imported from ${prov.source}${block.checks.length ? ` · ${block.checks.length} claim${block.checks.length === 1 ? "" : "s"} marked [CHECK]` : ""}`;
  const row = await prisma.scriptVersion.create({
    data: {
      contentItemId: item.id,
      researchPacketId: null,
      spokenScript,
      beats: [
        ...(block.hook ? [{ label: "Hook", text: block.hook }] : []),
        ...(block.cta ? [{ label: "CTA", text: block.cta }] : []),
      ],
      intendedPauses: [],
      emphasizedWords: [],
      visualBeats: block.onScreen,
      requiredFactualCaveats: [],
      // What ChatGPT was asked for (the prompt's length target), else the contract's maximum.
      targetRuntimeSeconds: opts.targetSeconds?.max ?? contract?.targetLengthMaxSeconds ?? 70,
      estimatedSpeakingRuntimeSeconds: estimateSecondsAt(block.wordCount, wpm),
      followUpIdeas: [],
      authorType: SCRIPT_IMPORT_AUTHOR,
      revisedFromId: latest?.id ?? null,
      revisionNote: note,
    },
  });

  // The Creative Brief ChatGPT wrote with the script (Content Intelligence output format). A
  // brief that doesn't validate never blocks the script — it just isn't recorded.
  if (block.brief) {
    await recordCreativeBrief(prisma, { contentItemId: item.id, scriptVersionId: row.id, source: "CHATGPT", brief: block.brief }, { actorId: actor.actorId }).catch(() => undefined);
  }

  await recordAudit(prisma, {
    actor: actor.actorId,
    actorType: "HUMAN",
    action: "SCRIPT_IMPORTED",
    entityType: "ContentItem",
    entityId: item.id,
    before: latest ? { scriptVersionId: latest.id, authorType: latest.authorType } : undefined,
    after: { scriptVersionId: row.id, revisedFromId: latest?.id ?? null, sha256: hash, words: block.wordCount },
    metadata: {
      ...prov.auditMetadata,
      source: prov.source,
      batchId: input.batchId ?? null,
      rawBlock: block.raw,
      header: { number: block.number, ymd: block.ymd, title: block.title, code: block.code },
      checks: block.checks,
      onScreen: block.onScreen,
      cta: block.cta,
    },
  });

  // Replacing an agent-written script is an override of a specialist (ARCHITECTURE.md: journal it).
  if (latest?.authorType === "AGENT") {
    await journalDecision(prisma, {
      question: `Which script wording should "${item.title}" use?`,
      selectedDecision: `Script imported from ChatGPT (ScriptVersion ${row.id})`,
      alternatives: [`Agent version ${latest.id}`],
      rationale: `Chris chose Replace for a script from ${prov.source} (the agent version is kept in the history).`,
      decisionOwner: actor.actorId,
      agentOrModel: "SCRIPT",
      userOverride: true,
      evidenceIds: [latest.id, row.id],
    });
  }

  await walkToScripted(prisma, item, actor, prov.reason, contract != null);
  return {
    status: "saved",
    title: item.title,
    message: latest ? "Saved as a new version (the old one is kept)." : "Saved.",
    scriptVersionId: row.id,
  };
}

/** IDEA … SCRIPTING → SCRIPTED, one honest transition per step (per-step idempotency keys). */
async function walkToScripted(prisma: PrismaClient, item: ContentItem, actor: { actorId: string }, reason: string, hasContract?: boolean) {
  const fresh = await prisma.contentItem.findUniqueOrThrow({ where: { id: item.id } });
  let state = fresh.currentState;
  if (!WALKABLE.has(state)) return;
  const key = (to: ContentState) => `script-import:${item.id}:${to}`;
  if (state === "IDEA") {
    await applyTransition(prisma, { contentItemId: item.id, to: "SELECTED", actorType: "HUMAN", actorId: actor.actorId, reason, idempotencyKey: key("SELECTED") });
    state = "SELECTED";
  }
  if (state === "SELECTED") {
    const existing = hasContract ?? (await prisma.productionContract.findUnique({ where: { contentItemId: item.id } })) != null;
    if (existing) throw new Error(`"${item.title}" has a contract but is still SELECTED — open it to continue.`);
    await createProductionContractAndAdvance(
      prisma,
      {
        contentItemId: item.id,
        purpose: "Script imported from ChatGPT",
        primaryIdea: item.title,
        audiencePromise: "As written in the imported script (to be confirmed)",
        topic: item.title,
        format: item.format?.trim() || "Talking head",
        productionTier: "FAST",
        targetLengthMinSeconds: 15,
        targetLengthMaxSeconds: 90,
        // NOT the fact-check-exempt NONE/LOW: the FACTUAL hard gate must still pass before posting.
        researchDepth: "STANDARD",
        factualRisk: "MEDIUM",
        scope: "What the imported script says",
        doNotExpandInto: "Claims that aren't in the script",
      },
      actor,
    );
    state = "CONTRACTED";
  }
  for (const to of PATH.slice(PATH.indexOf(state) + 1)) {
    await applyTransition(prisma, { contentItemId: item.id, to, actorType: "SYSTEM", actorId: actor.actorId, reason, idempotencyKey: key(to) });
  }
}
