import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { prisma, createContentItemFromFootage, createMediaAsset, analyzeMediaAsset, createStarterEdit, getLatestEditPlan } from "@chris/domain";
import { planToTimeline } from "@chris/media";
import { finalTranscriptFor } from "./content-steps";

// The card is a client component: render it on the server with the server action stubbed.
vi.mock("../app/content/[id]/caption-actions", () => ({ saveCaptionAction: async () => ({ ok: false, error: "stub" }) }));
const { CaptionEditor } = await import("../app/components/CaptionEditor");

const actor = { actorId: "chris" };
const WORDS = ["Most", "people", "budget", "backwards.", "Um,", "so", "anyway,", "let", "me", "ramble", "for", "a", "while."].map((word, i) => ({ word, start: i, end: i + 0.8 }));

async function seed(opts: { render: boolean; cutTo?: number }) {
  const it = await createContentItemFromFootage(prisma, { title: `Captions ${Date.now()}` }, actor);
  const asset = await createMediaAsset(prisma, { contentItemId: it.id, kind: "RAW_TAKE", storageKey: `raw/${it.id}/t.mp4`, originalFilename: "t.mp4", mimeType: "video/mp4", sizeBytes: 1 }, actor);
  await analyzeMediaAsset(prisma, asset.id, { durationSeconds: 13, width: 1080, height: 1920, frameRate: 30, hasAudio: true, videoCodec: "h264", audioCodec: "aac" }, actor);
  await prisma.mediaAsset.update({ where: { id: asset.id }, data: { transcript: WORDS.map((w) => w.word).join(" "), transcriptWords: WORDS } });
  await createStarterEdit(prisma, it.id, actor);
  const plan = (await getLatestEditPlan(prisma, it.id))!;
  if (opts.cutTo != null) {
    // The finished edit keeps only the first seconds of the take (a condensed cut).
    const timeline = planToTimeline(plan.plan as never, { mediaAssetId: asset.id, sourceWordsAvailable: true });
    timeline.clips = [{ ...timeline.clips[0]!, sourceStart: 0, sourceEnd: opts.cutTo }];
    await prisma.editPlan.update({ where: { id: plan.id }, data: { plan: { ...(plan.plan as object), timeline } as never } });
  }
  if (opts.render) await prisma.render.create({ data: { contentItemId: it.id, editPlanId: plan.id, status: "SUCCESS", storageKey: `renders/${it.id}.mp4`, durationSeconds: 13, width: 1080, height: 1920 } });
  return it.id;
}

describe("finalTranscriptFor — captions describe the finished cut, not the raw take", () => {
  it("uses only the words that survive the rendered edit", async () => {
    const id = await seed({ render: true, cutTo: 4 });
    expect(await finalTranscriptFor(id)).toBe("Most people budget backwards.");
  });

  it("falls back to the take's transcript before anything is rendered", async () => {
    const id = await seed({ render: false });
    expect(await finalTranscriptFor(id)).toContain("ramble for a while.");
  });
});

describe("CaptionEditor", () => {
  it("shows a YouTube title + description, and IG/TikTok captions", () => {
    const html = renderToStaticMarkup(
      createElement(CaptionEditor, {
        contentItemId: "item-1",
        platforms: ["INSTAGRAM", "YOUTUBE"],
        initial: [
          { platform: "INSTAGRAM", caption: "Your budget is upside down.", title: null, hashtags: ["budgeting"], source: "AI" },
          { platform: "YOUTUBE", caption: "Why most budgets fail.", title: "You're budgeting backwards", hashtags: [], source: "OWNER_EDIT" },
        ],
      }),
    );
    expect(html).toContain("Your budget is upside down.");
    expect(html).toContain("#budgeting");
    expect(html).toContain("You&#x27;re budgeting backwards");
    expect(html).toContain("Description");
    expect(html).toContain("Your text");
    expect(html).not.toContain("caption-TIKTOK");
  });

  it("an app the AI couldn't write for says why and offers empty fields to type", () => {
    const html = renderToStaticMarkup(
      createElement(CaptionEditor, { contentItemId: "item-1", platforms: ["TIKTOK"], initial: [], missing: [{ platform: "TIKTOK", reason: "the AI is out of credit" }] }),
    );
    expect(html).toContain("the AI is out of credit");
    expect(html).toContain("won&#x27;t post without it");
    expect(html).toContain("Not written yet");
  });
});
