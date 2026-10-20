"use server";

import { prisma, creativeBriefTextFor, getLatestCreativeBrief, recordCreativeBrief, SERIES_LABEL } from "@chris/domain";
import { getBrandContextText, runHookPickerAgent, runFootageBriefAgent, scopeProvider, type HookPickCandidate } from "@chris/agents";
import type { EditorBrief } from "./context";
import { requireSession } from "../../../../lib/session";
import { getModelProvider } from "../../../../lib/model-provider";

/**
 * AI edit (the "AI" choice next to Full edit / Cuts only): Full edit as the base, then the AI
 * picks the opening line among the Full edit's hook candidates (this action), then the Motion
 * Designer redesigns the graphics (designVisualsAction). See /docs/DECISIONS.md ("AI edit").
 */
/**
 * AI edit, step 0: make sure the video has a Creative Brief. A video filmed from the in-app
 * script or the ChatGPT paste already has one; an older upload or footage-first video doesn't,
 * so the Footage Brief agent recovers it from the transcript (hooks and beats are sentences he
 * said). Recorded as a CreativeBrief row (source FOOTAGE) so every downstream bot — and the
 * free Full edit — follows it from now on.
 */
export async function ensureBriefAction(input: { contentItemId: string }): Promise<{ ok: true; brief: EditorBrief; created: boolean } | { ok: false; error: string }> {
  const session = await requireSession();
  const toEditor = (b: NonNullable<Awaited<ReturnType<typeof getLatestCreativeBrief>>>): EditorBrief => {
    const h = b.hooks[b.chosenHookIndex] ?? b.hooks[0]!;
    return { series: SERIES_LABEL[b.series], hook: h.text, onScreenText: h.onScreenText, objective: b.primaryObjective, source: b.source };
  };
  try {
    const existing = await getLatestCreativeBrief(prisma, input.contentItemId);
    if (existing) return { ok: true, brief: toEditor(existing), created: false };
    const item = await prisma.contentItem.findUnique({ where: { id: input.contentItemId }, select: { title: true } });
    const takes = await prisma.mediaAsset.findMany({
      where: { contentItemId: input.contentItemId, removedAt: null, transcript: { not: null } },
      orderBy: { createdAt: "asc" },
      select: { transcript: true, durationSeconds: true },
    });
    const transcript = takes.map((t) => t.transcript).join("\n\n").slice(0, 40_000);
    if (!transcript.trim()) return { ok: false, error: "This video has no transcript yet — captions appear once your words are transcribed." };
    const brief = await runFootageBriefAgent(scopeProvider(getModelProvider(), { contentItemId: input.contentItemId }), {
      transcript,
      title: item?.title ?? null,
      durationS: takes.reduce((a, t) => a + (t.durationSeconds ?? 0), 0) || null,
      brandContext: await getBrandContextText(prisma),
    });
    const row = await recordCreativeBrief(prisma, { contentItemId: input.contentItemId, source: "FOOTAGE", brief }, { actorId: session.user?.id ?? "system", actorType: "SYSTEM" });
    return { ok: true, brief: toEditor({ ...row.brief, id: row.id, source: row.source, createdAt: row.createdAt }), created: true };
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    const msg = err instanceof Error ? err.message : String(err);
    if (name === "SpendCapExceededError") return { ok: false, error: "Today's AI spending limit was reached — try again tomorrow." };
    if (/credit balance|billing|insufficient/i.test(msg)) return { ok: false, error: "The AI is out of credit — add credit in More → AI credit." };
    return { ok: false, error: "The AI couldn't write the plan for this video right now — try again." };
  }
}

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
