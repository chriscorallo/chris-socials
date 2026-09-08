"use server";

import { redirect } from "next/navigation";
import { prisma, recordAudienceInsight } from "@chris/domain";
import { runAudienceIntelligenceAgent, getBrandContextText } from "@chris/agents";
import { requireSession } from "../../lib/session";
import { getModelProvider } from "../../lib/model-provider";

/**
 * Spec §9 step 24 — Audience Intelligence classifies real comments across every video, not
 * one at a time ("only surface a pattern once it recurs across multiple comments/videos").
 * This deliberately re-analyzes every ingested comment currently in the system each run,
 * rather than tracking a "processed" flag per comment — a reasonable simplification given
 * comment volume at this system's actual scale; each run's insights are their own new,
 * timestamped row (episodic memory), not an overwrite of the last run's. Requires
 * ANTHROPIC_API_KEY.
 */
export async function runAudienceIntelligence() {
  const session = await requireSession();

  try {
    const comments = await prisma.comment.findMany({ orderBy: { ingestedAt: "desc" }, take: 200 });
    if (comments.length === 0) {
      throw new Error("No comments ingested yet — ingest comments on a published item first.");
    }
    const brandContext = await getBrandContextText(prisma);

    const result = await runAudienceIntelligenceAgent(getModelProvider(), {
      comments: comments.map((c) => ({ platform: c.platform, authorHandle: c.authorHandle, text: c.text })),
      brandContext,
    });

    // Sequential, not Promise.all — see /docs/DECISIONS.md.
    for (const insight of result.insights) {
      await recordAudienceInsight(
        prisma,
        {
          category: insight.category,
          description: insight.description,
          supportingCommentCount: insight.supportingCommentCount,
          exampleQuotes: insight.exampleQuotes,
          actionableSuggestion: insight.actionableSuggestion,
        },
        { actorId: session.user!.id! },
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown audience-intelligence error";
    redirect(`/analytics?audienceError=${encodeURIComponent(message)}`);
  }

  redirect("/analytics");
}
