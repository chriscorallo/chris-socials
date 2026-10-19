"use server";

import { revalidatePath } from "next/cache";
import { prisma, getLatestPlatformPackage, recordPlatformPackage, validatePackageText, normalizeHashtag } from "@chris/domain";
import { requireSession } from "../../../lib/session";
import { runPackagingStep } from "../../../lib/content-steps";

/**
 * Captions for each app — the text that goes into Instagram's caption, TikTok's caption and
 * YouTube's title + description when the video posts. Written by the packaging agents (LOW
 * routing class: a fraction of a cent per video) as part of Finish, editable by Chris; every
 * save is a NEW PlatformPackage row (version history), and publishing always uses the latest.
 * See /docs/DECISIONS.md ("Captions at Finish").
 */

export type CaptionPlatform = "INSTAGRAM" | "TIKTOK" | "YOUTUBE";
const PLATFORMS: CaptionPlatform[] = ["INSTAGRAM", "TIKTOK", "YOUTUBE"];

export interface CaptionView {
  platform: CaptionPlatform;
  caption: string;
  title: string | null;
  hashtags: string[];
  /** "AI" | "OWNER_EDIT" — who wrote the text currently in use. */
  source: string;
}

function toView(pkg: { platform: string; caption: string; title: string | null; hashtags: unknown; metadata: unknown }): CaptionView {
  const meta = (pkg.metadata ?? null) as Record<string, unknown> | null;
  return {
    platform: pkg.platform as CaptionPlatform,
    caption: pkg.caption,
    title: pkg.title,
    hashtags: Array.isArray(pkg.hashtags) ? (pkg.hashtags as string[]) : [],
    source: typeof meta?.source === "string" ? meta.source : "AI",
  };
}

function plainCaptionError(err: unknown): string {
  const name = err instanceof Error ? err.name : "";
  const msg = err instanceof Error ? err.message : String(err);
  if (name === "SpendCapExceededError") return "today's AI spending limit was reached";
  if (/credit balance|billing|insufficient|quota/i.test(msg)) return "the AI is out of credit";
  if (/api[_ ]?key|authentication|x-api-key|401/i.test(msg)) return "the AI isn't set up";
  if (name === "PlatformPackageRequiresRenderError") return "the video has to pass its check first";
  return "the AI couldn't write them right now";
}

/**
 * Finish step: write captions for every chosen app that doesn't have any yet (existing ones —
 * including Chris's edits — are kept, never overwritten). Never fails the Finish: an app the
 * AI couldn't write for comes back in `missing` so Chris can type it himself.
 */
export async function writeCaptionsAction(input: {
  contentItemId: string;
  platforms: string[];
}): Promise<{ captions: CaptionView[]; missing: { platform: CaptionPlatform; reason: string }[] }> {
  const session = await requireSession();
  const actor = { actorId: session.user!.id! };
  const wanted = PLATFORMS.filter((p) => input.platforms.includes(p));
  const results = await Promise.all(
    wanted.map(async (platform) => {
      const existing = await getLatestPlatformPackage(prisma, input.contentItemId, platform);
      if (existing) return { platform, view: toView(existing) };
      try {
        const pkg = await runPackagingStep(input.contentItemId, platform, actor);
        return { platform, view: toView(pkg) };
      } catch (err) {
        return { platform, reason: plainCaptionError(err) };
      }
    }),
  );
  revalidatePath(`/content/${input.contentItemId}`);
  return {
    captions: results.flatMap((r) => ("view" in r && r.view ? [r.view] : [])),
    missing: results.flatMap((r) => ("reason" in r && r.reason ? [{ platform: r.platform, reason: r.reason }] : [])),
  };
}

/** Chris edits (or types from scratch) one app's text. Checked against that app's limits first. */
export async function saveCaptionAction(input: {
  contentItemId: string;
  platform: string;
  caption: string;
  title: string | null;
  hashtags: string;
}): Promise<{ ok: true; caption: CaptionView } | { ok: false; error: string }> {
  const session = await requireSession();
  const platform = PLATFORMS.find((p) => p === input.platform);
  if (!platform) return { ok: false, error: "Unknown app." };
  const caption = input.caption.trim();
  if (!caption) return { ok: false, error: platform === "YOUTUBE" ? "Write a description." : "Write a caption." };
  const title = platform === "YOUTUBE" ? (input.title ?? "").trim() || null : null;
  if (platform === "YOUTUBE" && !title) return { ok: false, error: "Write a title." };
  const hashtags = [...new Set(input.hashtags.split(/[\s,]+/).map((h) => normalizeHashtag(h)).filter((h): h is string => !!h))];
  const problems = validatePackageText(platform, { caption, title, hashtags });
  if (problems.length > 0) return { ok: false, error: problems.join(" ") };
  try {
    const previous = await getLatestPlatformPackage(prisma, input.contentItemId, platform);
    const prevMeta = (previous?.metadata ?? null) as Record<string, unknown> | null;
    const pkg = await recordPlatformPackage(
      prisma,
      {
        contentItemId: input.contentItemId,
        platform,
        caption,
        title,
        hashtags,
        coverFrameSeconds: previous?.coverFrameSeconds ?? null,
        metadata: { ...(prevMeta ?? {}), source: "OWNER_EDIT", editedFromPackageId: previous?.id ?? null },
      },
      { actorId: session.user!.id! },
    );
    revalidatePath(`/content/${input.contentItemId}`);
    return { ok: true, caption: toView(pkg) };
  } catch (err) {
    return { ok: false, error: `Couldn't save: ${plainCaptionError(err)}.` };
  }
}
