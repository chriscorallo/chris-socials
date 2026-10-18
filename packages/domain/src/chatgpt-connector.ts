import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { addDaysYmd, ymdInTz } from "./tz";
import { PRE_FILM_STATES } from "./plan-import/status";
import {
  listScriptImportTargets,
  saveImportedScript,
  SCRIPT_IMPORTABLE_STATES,
  type ScriptImportProvenance,
  type ScriptImportTarget,
} from "./script-import-db";
import { parseChatGptScripts, type ParsedScriptBlock } from "./script-import/parse";
import { videoCode } from "./script-import/match";
import { listPlannedVideos } from "./plan-import-db";
import { scriptWritingRules, type ScriptStyle } from "./script-import/prompt";

/**
 * ChatGPT connector — the tool logic behind the MCP server (apps/web/lib/chatgpt-mcp). Chris's
 * ChatGPT (his subscription does the writing, $0 here) reads his planned videos and saves the
 * scripts it wrote, from inside his planning chat. No model call anywhere in this file.
 *
 * Everything reuses the copy-paste path ("Scripts from ChatGPT"): the same targets
 * (listScriptImportTargets), the same 4-character video codes, the same brand/format/[CHECK]
 * rules text (scriptWritingRules), and the same save (saveImportedScript: a NEW IMPORTED
 * ScriptVersion, never an overwrite; idempotent by text hash; honest walk to SCRIPTED; no
 * Claims Gate verdict, so the FACTUAL hard gate still blocks posting). The structured script is
 * rendered as one canonical block and read by the same tolerant parser, so cleaning ([CHECK]
 * extraction, hook/CTA joining, stage directions) is identical to a paste.
 * See docs/decisions-pending/chatgpt-connector.md.
 */

export const CONNECTOR_SOURCE = "ChatGPT connector";
export const CONNECTOR_REASON =
  "Script saved by ChatGPT through the Chris Studio connector (approved by Chris) — not fact-checked yet; the factual check is still required before posting";

export const MAX_LIST_BATCH = 30;
export const DEFAULT_LIST_BATCH = 15;
export const MAX_SAVE_ITEMS = 30;

// ---- list_videos_needing_scripts -------------------------------------------------------------

export const ListVideosArgs = z.object({
  batchSize: z.number().int().min(1).max(MAX_LIST_BATCH).default(DEFAULT_LIST_BATCH),
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  includeWithScripts: z.boolean().default(false),
  offset: z.number().int().min(0).max(5000).default(0),
});
export type ListVideosArgsInput = z.input<typeof ListVideosArgs>;

export interface ConnectorVideo {
  videoId: string;
  code: string;
  date: string;
  time: string;
  title: string;
  hookIdea: string | null;
  notes: string | null;
  hasScript: boolean;
  scriptVersions: number;
}

export interface ListVideosResult {
  videos: ConnectorVideo[];
  /** Videos matching the filter, in total (so ChatGPT can say "15 of 87"). */
  totalMatching: number;
  remainingAfterThisBatch: number;
  from: string;
  styleTargets: {
    wordsPerMinute: number;
    lengthSeconds: { min: number; max: number };
    spokenWords: { min: number; max: number };
    hookSeconds: number;
    basedOn: string;
  };
  /** Brand, voice, format and the [CHECK] facts rule — the same text the copy-paste prompt uses. */
  scriptRules: string;
  howToSave: string;
}

const HOW_TO_SAVE =
  "Write one script per video following scriptRules, then call save_scripts with an item per video: {videoId (or code), hook, script, onScreen?, cta?}. " +
  "`script` is every word Chris says, starting with the hook line, as plain paragraphs. Put [CHECK] right after every specific number, statistic, rate, limit, date or rule. " +
  "Save in batches of up to 30. If a video already has a script, only set replace: true when Chris has said to replace it (the old version is always kept).";

function toConnectorVideo(t: ScriptImportTarget): ConnectorVideo {
  return {
    videoId: t.id,
    code: t.code,
    date: t.ymd,
    time: t.time,
    title: t.title,
    hookIdea: t.hook,
    notes: t.notes,
    hasScript: t.scriptCount > 0,
    scriptVersions: t.scriptCount,
  };
}

/** One row per video (a video can sit on the schedule more than once), soonest first. */
async function targets(prisma: PrismaClient, tz: string): Promise<ScriptImportTarget[]> {
  const seen = new Set<string>();
  return (await listScriptImportTargets(prisma, { tz })).filter((t) => (seen.has(t.id) ? false : (seen.add(t.id), true)));
}

export async function listVideosNeedingScripts(
  prisma: PrismaClient,
  args: ListVideosArgsInput,
  ctx: { tz: string; style: ScriptStyle; voiceSamples?: string; now?: Date },
): Promise<ListVideosResult> {
  const a = ListVideosArgs.parse(args);
  const today = ymdInTz(ctx.now ?? new Date(), ctx.tz);
  // Same window as the Plan board banner and /plan/scripts: a week back (overdue first), on.
  const from = a.from ?? addDaysYmd(today, -7);
  const all = (await targets(prisma, ctx.tz)).filter(
    (t) => t.ymd >= from && PRE_FILM_STATES.has(t.state) && (a.includeWithScripts || t.scriptCount === 0),
  );
  const page = all.slice(a.offset, a.offset + a.batchSize);
  const s = ctx.style;
  return {
    videos: page.map(toConnectorVideo),
    totalMatching: all.length,
    remainingAfterThisBatch: Math.max(0, all.length - a.offset - page.length),
    from,
    styleTargets: {
      wordsPerMinute: s.wpm,
      lengthSeconds: { min: s.minSeconds, max: s.maxSeconds },
      spokenWords: { min: s.minWords, max: s.maxWords },
      hookSeconds: s.hookSeconds,
      basedOn: s.source === "references" ? `measured from ${s.sampleSize} reference videos` : "defaults (no reference videos measured yet)",
    },
    scriptRules: scriptWritingRules(s, ctx.voiceSamples),
    howToSave: HOW_TO_SAVE,
  };
}

// ---- get_video -------------------------------------------------------------------------------

export const GetVideoArgs = z
  .object({
    videoId: z.string().min(1).max(100).optional(),
    code: z.string().min(1).max(12).optional(),
  })
  .refine((v) => !!(v.videoId || v.code), { message: "Give videoId or code" });

export interface GetVideoResult {
  found: boolean;
  message: string;
  video?: ConnectorVideo & {
    state: string;
    latestScript: { version: number; text: string; author: string; createdAt: string; factChecked: boolean } | null;
  };
}

type Resolve = { ok: true; target: ScriptImportTarget } | { ok: false; status: "not-found" | "ambiguous"; message: string };

/** By id, or by the 4-character code (rejected when the code doesn't point at exactly one video). */
function resolveTarget(all: readonly ScriptImportTarget[], ref: { videoId?: string; code?: string }): Resolve {
  const code = ref.code?.trim().toUpperCase();
  if (ref.videoId) {
    const t = all.find((x) => x.id === ref.videoId);
    if (!t) return { ok: false, status: "not-found", message: `No planned, not-yet-filmed video has id ${ref.videoId}.` };
    if (code && t.code !== code) return { ok: false, status: "ambiguous", message: `videoId ${ref.videoId} is "${t.title}" (code ${t.code}), but the code given was ${code}. Check which video this script is for.` };
    return { ok: true, target: t };
  }
  const hits = all.filter((x) => x.code === code);
  if (hits.length === 0) return { ok: false, status: "not-found", message: `No planned, not-yet-filmed video has code ${code}.` };
  if (hits.length > 1)
    return {
      ok: false,
      status: "ambiguous",
      message: `Code ${code} matches ${hits.length} videos (${hits.map((h) => `"${h.title}" ${h.ymd} id ${h.id}`).join("; ")}). Save again using videoId.`,
    };
  return { ok: true, target: hits[0]! };
}

export async function getConnectorVideo(prisma: PrismaClient, args: z.input<typeof GetVideoArgs>, ctx: { tz: string }): Promise<GetVideoResult> {
  const a = GetVideoArgs.parse(args);
  const r = resolveTarget(await targets(prisma, ctx.tz), a);
  if (!r.ok) return { found: false, message: r.message };
  const versions = await prisma.scriptVersion.findMany({
    where: { contentItemId: r.target.id },
    orderBy: { createdAt: "desc" },
    select: { spokenScript: true, authorType: true, createdAt: true, scriptClaimsGateResult: true },
  });
  const latest = versions[0];
  return {
    found: true,
    message: latest ? `Found "${r.target.title}" with ${versions.length} script version(s).` : `Found "${r.target.title}" (no script yet).`,
    video: {
      ...toConnectorVideo(r.target),
      state: r.target.state,
      latestScript: latest
        ? {
            version: versions.length,
            text: latest.spokenScript,
            author: latest.authorType === "IMPORTED" ? "ChatGPT" : latest.authorType === "AGENT" ? "Chris Studio's script writer" : "Chris",
            createdAt: latest.createdAt.toISOString(),
            factChecked: latest.scriptClaimsGateResult != null,
          }
        : null,
    },
  };
}

// ---- save_scripts ----------------------------------------------------------------------------

const SaveItem = z
  .object({
    videoId: z.string().min(1).max(100).optional(),
    code: z.string().min(1).max(12).optional(),
    hook: z.string().trim().min(1).max(600),
    script: z.string().trim().min(1).max(12_000),
    onScreen: z.union([z.array(z.string().max(300)).max(20), z.string().max(2000)]).optional(),
    cta: z.string().max(600).optional(),
    replace: z.boolean().optional(),
  })
  .refine((v) => !!(v.videoId || v.code), { message: "Each script needs videoId or code" });

export const SaveScriptsArgs = z.object({ scripts: z.array(SaveItem).min(1).max(MAX_SAVE_ITEMS) });
export type SaveScriptsArgsInput = z.input<typeof SaveScriptsArgs>;

export type ConnectorSaveStatus = "saved" | "skipped-duplicate" | "needs-confirmation-to-replace" | "not-found" | "ambiguous" | "not-allowed" | "failed";

export interface ConnectorSaveOutcome {
  videoId: string | null;
  code: string | null;
  title: string | null;
  status: ConnectorSaveStatus;
  message: string;
  claimsToCheck?: number;
  words?: number;
}

export interface SaveScriptsResult {
  summary: string;
  saved: number;
  outcomes: ConnectorSaveOutcome[];
}

/** The structured script as one canonical block in the copy-paste format (also the provenance text). */
export function canonicalScriptBlock(t: { ymd: string; title: string; code: string }, item: { hook: string; script: string; onScreen?: string | string[]; cta?: string }): string {
  const onScreen = Array.isArray(item.onScreen) ? item.onScreen.map((s) => s.trim()).filter(Boolean).join(" / ") : (item.onScreen ?? "").trim();
  // A header-looking line inside the script must not start a second block.
  const safe = (s: string) => s.replace(/^\s*#{1,6}\s*/gm, "").trim();
  return [
    `### VIDEO 1 | ${t.ymd} | ${t.title.replace(/\|/g, "/")} | ${t.code}`,
    `HOOK: ${safe(item.hook).replace(/\s*\n+\s*/g, " ")}`,
    "SCRIPT:",
    safe(item.script),
    ...(onScreen ? [`ON-SCREEN: ${onScreen.replace(/\s*\n+\s*/g, " / ")}`] : []),
    ...(item.cta?.trim() ? [`CTA: ${safe(item.cta).replace(/\s*\n+\s*/g, " ")}`] : []),
  ].join("\n");
}

function parseOne(raw: string, today: string): ParsedScriptBlock | null {
  const blocks = parseChatGptScripts(raw, { today }).blocks;
  const b = blocks[0];
  return blocks.length === 1 && b && b.spokenScript.trim() ? b : null;
}

export async function saveConnectorScripts(
  prisma: PrismaClient,
  args: SaveScriptsArgsInput,
  actor: { actorId: string },
  ctx: { tz: string; wpm: number; targetSeconds: { min: number; max: number }; grantId: string; now?: Date },
): Promise<SaveScriptsResult> {
  const a = SaveScriptsArgs.parse(args);
  const today = ymdInTz(ctx.now ?? new Date(), ctx.tz);
  // Every planned video that isn't cancelled — so "already filmed" can be told apart from "unknown".
  const all = await targets(prisma, ctx.tz);
  const provenance: ScriptImportProvenance = { source: CONNECTOR_SOURCE, reason: CONNECTOR_REASON, auditMetadata: { via: "chatgpt-mcp", grantId: ctx.grantId } };
  const used = new Set<string>();
  const outcomes: ConnectorSaveOutcome[] = [];
  let plannedCache: { id: string; title: string }[] | null = null;
  const planned = async () => (plannedCache ??= await listPlannedVideos(prisma, { tz: ctx.tz }));

  // Sequential on purpose (PGlite; one bad script must not sink the rest).
  for (const it of a.scripts) {
    const base = { videoId: it.videoId ?? null, code: it.code?.toUpperCase() ?? null, title: null as string | null };
    const r = resolveTarget(all, it);
    if (!r.ok) {
      // Tell "already filmed" apart from "unknown" (targets only hold not-yet-filmed videos).
      if (r.status === "not-found") {
        const code = it.code?.trim().toUpperCase();
        const past = (await planned()).filter((p) => (it.videoId ? p.id === it.videoId : videoCode(p.id) === code));
        if (past.length === 1) {
          outcomes.push({ videoId: past[0]!.id, code: videoCode(past[0]!.id), title: past[0]!.title, status: "not-allowed", message: `"${past[0]!.title}" is already filmed, so its script wasn't changed.` });
          continue;
        }
      }
      outcomes.push({ ...base, status: r.status, message: r.message });
      continue;
    }
    const t = r.target;
    const out = { videoId: t.id, code: t.code, title: t.title };
    if (used.has(t.id)) {
      outcomes.push({ ...out, status: "ambiguous", message: `Two scripts in this call are for "${t.title}". Only the first was used; send the other one separately if it's a different video.` });
      continue;
    }
    used.add(t.id);
    if (!SCRIPT_IMPORTABLE_STATES.has(t.state)) {
      outcomes.push({ ...out, status: "not-allowed", message: `"${t.title}" is already filmed, so its script wasn't changed.` });
      continue;
    }
    const block = parseOne(canonicalScriptBlock(t, it), today);
    if (!block) {
      outcomes.push({ ...out, status: "failed", message: `Couldn't read the script for "${t.title}". Send hook and script as plain text.` });
      continue;
    }
    try {
      const res = await saveImportedScript(
        prisma,
        { contentItemId: t.id, block, replace: !!it.replace, batchId: `mcp:${ctx.grantId}` },
        actor,
        { wpm: ctx.wpm, targetSeconds: ctx.targetSeconds, provenance },
      );
      const extra = { claimsToCheck: block.checks.length, words: block.wordCount };
      if (res.status === "saved") {
        outcomes.push({ ...out, ...extra, status: "saved", message: `${res.message} ${block.checks.length ? `${block.checks.length} claim(s) marked [CHECK] — Chris fact-checks them before posting.` : ""}`.trim() });
      } else if (res.status === "already-saved") {
        outcomes.push({ ...out, ...extra, status: "skipped-duplicate", message: "This exact script is already saved — nothing changed." });
      } else if (res.status === "has-script") {
        outcomes.push({
          ...out,
          status: "needs-confirmation-to-replace",
          message: `"${t.title}" already has a script, so this one was NOT saved. Ask Chris if he wants to replace it; if yes, call save_scripts again for this video with replace: true (the old version is kept).`,
        });
      } else if (res.status === "not-importable") {
        outcomes.push({ ...out, status: "not-allowed", message: res.message });
      } else {
        outcomes.push({ ...out, status: "failed", message: res.message });
      }
    } catch (err) {
      outcomes.push({ ...out, status: "failed", message: err instanceof Error ? err.message : String(err) });
    }
  }

  const count = (s: ConnectorSaveStatus) => outcomes.filter((o) => o.status === s).length;
  const saved = count("saved");
  const parts = [`${saved} saved`];
  if (count("skipped-duplicate")) parts.push(`${count("skipped-duplicate")} already saved`);
  if (count("needs-confirmation-to-replace")) parts.push(`${count("needs-confirmation-to-replace")} already had a script (ask Chris before replacing)`);
  const bad = count("not-found") + count("ambiguous") + count("not-allowed") + count("failed");
  if (bad) parts.push(`${bad} not saved (see each message)`);
  const summary = `${parts.join(", ")}. Saved scripts are in Chris Studio under Plan and in the teleprompter. They still need their [CHECK] facts checked before posting.`;
  return { summary, saved, outcomes };
}
