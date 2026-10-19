import { describe, it, expect, afterEach } from "vitest";
import {
  prisma,
  analyzeMediaAsset,
  createContentItemFromFootage,
  createMediaAsset,
  createStarterEdit,
  getLatestEditPlan,
  getDirectorAiAvailability,
  recordSubjectTrack,
  recordTakeUnderstanding,
  ANTHROPIC_CREDIT_ERROR_RE,
} from "@chris/domain";
import { MockModelProvider } from "@chris/agents";
import { EditTimelineSchema, expandFaceToProtectedRegion } from "@chris/media";
import { readDirectorRecord } from "@chris/media/director";
import { askDirectorAi, directorMessagesView, directorState, prepareDirectorTurn, submitDirectorAnswer, undoDirectorChange } from "./server";

/**
 * Director chat against the throwaway DB: the conversation is stored append-only, every applied
 * answer is a NEW EditPlan version (undo = another new version), misfits change nothing and are
 * logged with the fix-up message, a double paste applies once, and the paid path is refused
 * without AI credit (and, with a key, goes through the same parser — MockModelProvider only).
 */

const actor = { actorId: "chris" };
const FACE = { x: 0.335, y: 0.2, w: 0.33, h: 0.2 };

async function video(title: string) {
  const it = await createContentItemFromFootage(prisma, { title }, actor);
  const asset = await createMediaAsset(prisma, { contentItemId: it.id, kind: "RAW_TAKE", storageKey: `raw/${it.id}/take.mp4`, originalFilename: "take.mp4", mimeType: "video/mp4", sizeBytes: 1 }, actor);
  await analyzeMediaAsset(prisma, asset.id, { durationSeconds: 9, width: 1080, height: 1920, frameRate: 30, hasAudio: true, videoCodec: "h264", audioCodec: "aac" }, actor);
  await recordSubjectTrack(prisma, asset.id, Array.from({ length: 28 }, (_, i) => ({ t: i / 3, box: expandFaceToProtectedRegion(FACE) })), { actorId: "job", actorType: "JOB" });
  const samples = Array.from({ length: 36 }, (_, i) => {
    const t = i * 0.25;
    const happy = t >= 1 && t < 3.5;
    return { t, face: FACE, probs: happy ? [0.02, 0.96, 0.01, 0, 0, 0, 0, 0.01] : [0.95, 0.02, 0.01, 0, 0.01, 0, 0, 0.01], motion: 0.03 };
  });
  await recordTakeUnderstanding(
    prisma,
    {
      mediaAssetId: asset.id,
      data: { version: 1, mediaAssetId: asset.id, durationS: 9, stepS: 0.25, source: { width: 1080, height: 1920 }, model: { id: "test", license: "MIT", source: "test" }, samples, sprite: { key: null, cols: 10, rows: 2, cellW: 180, cellH: 320, stepS: 0.5, count: 18 } },
      spriteKey: `understanding/${it.id}/${asset.id}.jpg`,
      model: "test",
    },
    { actorId: "job" },
  );
  await createStarterEdit(prisma, it.id, actor);
  return { id: it.id, assetId: asset.id };
}

const CHRIS = "The check hits when I smile — paycheck on the left — then 2-3 seconds later rent shows up on the right. End with 'well that was a fun 11 seconds'.";
const ANSWER = `Here you go:
\`\`\`json
{"reply":"Paycheck on your smile, rent on the right, then the line. I used $2,400 and $1,450.","operations":[
 {"op":"addGraphic","ref":"paycheck","presetId":"pay-received-500","start":{"expression":"happy"},"end":3.3,"placement":"LEFT","props":{"title":"Paycheck","items":[{"text":"Amount","value":2400}]},"sfx":"CASH"},
 {"op":"addGraphic","ref":"rent","presetId":"notif-banner-received","start":{"expression":"happy","offset":2.4},"end":7,"placement":"RIGHT","lines":"Rent payment — -$1,450 · Landlord"},
 {"op":"addText","ref":"ending","text":"well that was a fun 11 seconds","start":7.3,"end":"end","placement":"BOTTOM"}
]}
\`\`\``;

afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
});

describe("director chat (server)", () => {
  it("message → pack → pasted answer → a NEW version with a change list; a double paste applies once", async () => {
    const { id } = await video("Director: paycheck");
    const before = (await getLatestEditPlan(prisma, id))!;
    const state = await directorState(prisma, id);
    expect(state.missing).toEqual([]);
    expect(state.takes[0]!.sprite?.url).toMatch(/^\/api\/director\/sprite\/understanding\//);
    expect(state.ai.available).toBe(false);
    expect(state.ai.reason).toMatch(/Needs AI credit/);

    const turn = await prepareDirectorTurn(prisma, { itemId: id, message: CHRIS, clientKey: "k1", actorId: "chris" });
    const again = await prepareDirectorTurn(prisma, { itemId: id, message: CHRIS, clientKey: "k1", actorId: "chris" });
    expect(again.messageId).toBe(turn.messageId);
    expect(turn.pack).toContain(CHRIS);
    expect(turn.pack).toMatch(/starts smiling/);
    expect(turn.sheet?.cells.length).toBe(18);
    expect((await directorState(prisma, id)).pendingMessage?.id).toBe(turn.messageId);

    const r = await submitDirectorAnswer(prisma, { itemId: id, replyToId: turn.messageId, text: ANSWER, provider: "FREE_CHATGPT", actorId: "chris" });
    if (!r.ok) throw new Error(r.errors.join("; "));
    expect(r.changes.map((c) => c.text).join("\n")).toMatch(/Added: Paycheck \+\$2,400/);
    const after = (await getLatestEditPlan(prisma, id))!;
    expect(after.id).not.toBe(before.id);
    expect(after.revisionReason).toMatch(/^Finishing edit by Chris: Director chat — Added: Paycheck/);
    const tl = EditTimelineSchema.parse((after.plan as { timeline: unknown }).timeline);
    expect(tl.visuals.map((v) => v.id)).toEqual(["dc-paycheck", "dc-rent"]);
    const rec = readDirectorRecord(after.plan)!;
    expect(rec.owner.every((o) => o.by === "Chris via Director chat")).toBe(true);

    const dup = await submitDirectorAnswer(prisma, { itemId: id, replyToId: turn.messageId, text: ANSWER, provider: "FREE_CHATGPT", actorId: "chris" });
    expect(dup.ok && dup.alreadyApplied).toBe(true);
    expect((await getLatestEditPlan(prisma, id))!.id).toBe(after.id);

    const view = await directorMessagesView(prisma, id);
    expect(view.map((m) => m.kind)).toEqual(["MESSAGE", "APPLIED"]);
    expect(view[1]!.reply).toMatch(/Paycheck on your smile/);
    expect(view[1]!.undoable).toBe(true);
    expect(await prisma.auditLog.count({ where: { entityId: id, action: "DIRECTOR_EDIT_APPLIED" } })).toBe(1);
  });

  it("a misfit answer changes nothing and is logged with the fix-up message; undo is a new version", async () => {
    const { id } = await video("Director: misfit");
    const turn = await prepareDirectorTurn(prisma, { itemId: id, message: CHRIS, clientKey: "k2", actorId: "chris" });
    const base = (await getLatestEditPlan(prisma, id))!;
    const bad = await submitDirectorAnswer(prisma, { itemId: id, replyToId: turn.messageId, text: '{"reply":"x","operations":[{"op":"addGraphic","ref":"a","presetId":"nope","start":20}]}', provider: "FREE_CHATGPT", actorId: "chris" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.repairMessage).toMatch(/Fix exactly these problems/);
    expect((await getLatestEditPlan(prisma, id))!.id).toBe(base.id);
    const view = await directorMessagesView(prisma, id);
    expect(view.at(-1)).toMatchObject({ kind: "REJECTED" });
    expect(view.at(-1)!.errors!.join(" ")).toMatch(/isn't a graphic|after the end/);

    const ok = await submitDirectorAnswer(prisma, { itemId: id, replyToId: turn.messageId, text: ANSWER, provider: "FREE_CHATGPT", actorId: "chris" });
    if (!ok.ok) throw new Error(ok.errors.join());
    const undo = await undoDirectorChange(prisma, { itemId: id, appliedMessageId: ok.appliedMessageId, actorId: "chris" });
    if (!undo.ok) throw new Error(undo.error);
    const latest = (await getLatestEditPlan(prisma, id))!;
    expect(latest.id).not.toBe(base.id);
    expect(latest.revisionReason).toMatch(/undo/);
    expect(EditTimelineSchema.parse((latest.plan as { timeline: unknown }).timeline).visuals).toHaveLength(0);
    // every version is still there (append-only)
    expect(await prisma.editPlan.count({ where: { contentItemId: id } })).toBeGreaterThanOrEqual(3);
    const v2 = await directorMessagesView(prisma, id);
    expect(v2.find((m) => m.kind === "APPLIED")!.undoable).toBe(false);
  });

  it("the paid path is gated on AI credit; with it, Claude's answer goes through the same parser (mock only)", async () => {
    const { id } = await video("Director: AI");
    const turn = await prepareDirectorTurn(prisma, { itemId: id, message: CHRIS, clientKey: "k3", actorId: "chris" });
    const mock = new MockModelProvider(() => ({ reply: "Done by AI.", operations_json: JSON.stringify([{ op: "addText", ref: "ending", text: "well that was a fun 11 seconds", start: 7.3, end: "end" }]) }));
    const refused = await askDirectorAi(prisma, mock, { itemId: id, messageId: turn.messageId, imageBase64: null, actorId: "chris" });
    expect(refused.ok).toBe(false);
    expect(mock.calls).toHaveLength(0);

    process.env.ANTHROPIC_API_KEY = "test-key-never-used";
    const avail = await getDirectorAiAvailability(prisma, { apiKeySet: true, capUsd: 5 }, new Date(), ANTHROPIC_CREDIT_ERROR_RE);
    expect(avail.available).toBe(true);
    const r = await askDirectorAi(prisma, mock, { itemId: id, messageId: turn.messageId, imageBase64: "aGVsbG8=", actorId: "chris" });
    if (!r.ok) throw new Error(r.errors.join());
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]!.promptId).toBe("DIRECTOR_CHAT");
    expect(mock.calls[0]!.images).toHaveLength(1);
    expect(mock.calls[0]!.userPrompt).toContain(CHRIS);
    const view = await directorMessagesView(prisma, id);
    expect(view.at(-1)).toMatchObject({ kind: "APPLIED", provider: "AI" });

    const off = await getDirectorAiAvailability(prisma, { apiKeySet: true, capUsd: 0 }, new Date(), ANTHROPIC_CREDIT_ERROR_RE);
    expect(off.available).toBe(false);
  });
});
