"use server";

import { prisma, creativeBriefTextFor } from "@chris/domain";
import { getBrandContextText, runHookPickerAgent, scopeProvider, type HookPickCandidate } from "@chris/agents";
import { requireSession } from "../../../../lib/session";
import { getModelProvider } from "../../../../lib/model-provider";

/**
 * AI edit (the "AI" choice next to Full edit / Cuts only): Full edit as the base, then the AI
 * picks the opening line among the Full edit's hook candidates (this action), then the Motion
 * Designer redesigns the graphics (designVisualsAction). See /docs/DECISIONS.md ("AI edit").
 */
export async function aiPickHookAction(input: {
  contentItemId: string;
  candidates: HookPickCandidate[];
}): Promise<{ ok: true; chosenIndex: number; reason: string } | { ok: false; error: string }> {
  await requireSession();
  try {
    const takes = await prisma.mediaAsset.findMany({
      where: { contentItemId: input.contentItemId, removedAt: null, transcript: { not: null } },
      orderBy: { createdAt: "asc" },
      select: { transcript: true },
    });
    const transcript = takes.map((t) => t.transcript).join("\n\n").slice(0, 40_000) || "(no transcript)";
    const pick = await runHookPickerAgent(scopeProvider(getModelProvider(), { contentItemId: input.contentItemId }), {
      candidates: input.candidates.map((c) => ({ index: c.index, text: c.text, score: c.score, reason: c.reason })),
      transcript,
      brandContext: await getBrandContextText(prisma),
      creativeBrief: await creativeBriefTextFor(prisma, input.contentItemId),
    });
    return { ok: true, chosenIndex: pick.chosenIndex, reason: pick.reason };
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    const msg = err instanceof Error ? err.message : String(err);
    if (name === "SpendCapExceededError") return { ok: false, error: "Today's AI spending limit was reached — try again tomorrow." };
    if (/credit balance|billing|insufficient/i.test(msg)) return { ok: false, error: "The AI is out of credit — add credit in More → AI credit." };
    if (name === "HookPickInvalidError") return { ok: false, error: msg };
    return { ok: false, error: "The AI couldn't pick a hook right now — try again." };
  }
}
