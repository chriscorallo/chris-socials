import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  prisma,
  createContentItem,
  applyTransition,
  createMediaAsset,
  analyzeMediaAsset,
  recordTakeSelection,
  recordEditPlan,
  recordTranscript,
  getLatestEditPlan,
  setFlag,
  parseSubjectTrackRecord,
} from "@chris/domain";
import { MockModelProvider } from "@chris/agents";
import { LocalFsStorageAdapter, EditTimelineSchema, visualRect, intersectionArea, type SubjectTrackAnalysis } from "@chris/media";
import { designMotionForContentItem, MOTION_AUTO_DESIGN_FLAG } from "../motion-design-job";
import { trackSubjectForMediaAsset } from "../subject-track-job";

const SPOKEN = "If you save twenty percent of your income you hit 24,500 dollars in three years here are the rules".split(" ");
const words = Array.from({ length: 40 }, (_, i) => ({ word: SPOKEN[i % SPOKEN.length]!, start: i * 0.5, end: i * 0.5 + 0.4 }));
const HEAD = { x: 0.3, y: 0.15, w: 0.4, h: 0.15 };

function fakeAnalyzer(calls: string[], fail = false) {
  return async (path: string): Promise<SubjectTrackAnalysis> => {
    calls.push(path);
    if (fail) throw new Error("detector exploded");
    return {
      track: Array.from({ length: 61 }, (_, i) => ({ t: i / 3, box: HEAD })),
      source: { width: 1080, height: 1920 },
      framesAnalyzed: 61,
      framesWithFace: 61,
      fps: 3,
      model: "fake-tracker",
    };
  };
}

const designerResponse = {
  rationale: "Show the number when he says it; the rules as a list.",
  theme: null,
  visuals: [
    {
      template: "NUMBER_COUNTER",
      props: { value: 24500, from: 0, prefix: "$", suffix: "", decimals: 0, label: "in three years" },
      start: 5.0,
      end: 8.0,
      palette: "BRAND",
      enter: "AUTO",
      exit: "AUTO",
      enterSfx: "TICK",
      anchorText: "you hit 24,500 dollars",
      importance: 5,
      rationale: "The number is the point.",
    },
    {
      template: "STAT_CARD",
      props: { value: "$31K", label: "average", sublabel: null, trend: "UP" },
      start: 12,
      end: 14,
      palette: "BRAND",
      enter: "AUTO",
      exit: "AUTO",
      enterSfx: null,
      anchorText: "here are the rules",
      importance: 2,
      rationale: "Invented number — must be rejected.",
    },
  ],
};

describe("motion design job (real DB, mocked model + tracker)", () => {
  let storageDir: string;
  let storage: LocalFsStorageAdapter;

  beforeAll(async () => {
    storageDir = await mkdtemp(join(tmpdir(), "chris-motion-"));
    storage = new LocalFsStorageAdapter({ baseDir: storageDir });
  });
  afterAll(async () => {
    await rm(storageDir, { recursive: true, force: true });
  });

  async function makeEditPlannedItem() {
    const item = await createContentItem(prisma, { title: "Motion design test" }, { actorId: "test-user" });
    for (const to of ["SELECTED", "CONTRACTED", "RESEARCHING", "RESEARCHED", "SCRIPTING", "SCRIPTED", "READY_TO_FILM", "FILMED"] as const) {
      await applyTransition(prisma, { contentItemId: item.id, to, actorType: "SYSTEM" });
    }
    await prisma.researchPacket.create({
      data: {
        contentItemId: item.id,
        primaryClaim: "Saving 20% builds a $24,500 cushion in three years.",
        facts: [],
        citations: [],
        numericInputs: [{ label: "Target cushion", value: "$24,500", sourceUrl: "https://example.gov", asOfDate: "2026" }],
        caveats: [],
        confidence: 0.9,
        contradictoryEvidence: [],
        prohibitedClaims: [],
        contentSafeWording: "",
        status: "READY",
        stopResearching: true,
      },
    });
    await prisma.scriptVersion.create({
      data: {
        contentItemId: item.id,
        spokenScript: "If you save 20% of your income you hit $24,500 in three years.",
        beats: [],
        intendedPauses: [],
        emphasizedWords: [],
        visualBeats: [],
        requiredFactualCaveats: [],
        targetRuntimeSeconds: 20,
        estimatedSpeakingRuntimeSeconds: 20,
        followUpIdeas: [],
      },
    });
    const storageKey = `raw/${item.id}/take-1.mp4`;
    await storage.put(storageKey, Buffer.from("not really a video — the tracker is mocked"));
    const asset = await createMediaAsset(
      prisma,
      { contentItemId: item.id, kind: "RAW_TAKE", storageKey, originalFilename: "take-1.mp4", mimeType: "video/mp4", sizeBytes: 10 },
      { actorId: "chris" },
    );
    await analyzeMediaAsset(
      prisma,
      asset.id,
      { durationSeconds: 20, width: 1080, height: 1920, frameRate: 30, hasAudio: true, videoCodec: "h264", audioCodec: "aac" },
      { actorId: "chris" },
    );
    await recordTranscript(prisma, { mediaAssetId: asset.id, text: SPOKEN.join(" "), words, source: "LOCAL_WHISPER" }, { actorId: "job" });
    const selection = await recordTakeSelection(
      prisma,
      { contentItemId: item.id, selectedMediaAssetId: asset.id, confidence: 0.9, reason: "Only take." },
      { actorId: "chris" },
    );
    await recordEditPlan(
      prisma,
      {
        contentItemId: item.id,
        takeSelectionId: selection.id,
        productionTier: "MEDIUM",
        targetDurationSeconds: 20,
        plan: {
          segments: [{ startSeconds: 0, endSeconds: 20 }],
          targetDimensions: { width: 1080, height: 1920 },
          textOverlays: [],
          captions: { enabled: true, style: "CLEAN", position: "LOWER" },
          normalizeAudio: true,
          bRollRequests: [],
          musicTrack: null,
          sfxEvents: [],
          transitions: [],
          targetDurationSeconds: 20,
          productionTier: "MEDIUM",
          doNothingElse: false,
          rationale: "Keep it all.",
        },
      },
      { actorId: "chris" },
    );
    return { item, asset };
  }

  it("HUMAN: tracks the take, designs visuals, saves a new plan version with plan.timeline.visuals", async () => {
    const { item, asset } = await makeEditPlannedItem();
    const before = await getLatestEditPlan(prisma, item.id);
    const calls: string[] = [];
    const provider = new MockModelProvider(() => designerResponse);

    const res = await designMotionForContentItem(prisma, storage, provider, item.id, { actorId: "chris" }, { analyze: fakeAnalyzer(calls) });
    expect(res.status, res.errorMessage).toBe("SUCCESS");
    expect(calls).toHaveLength(1);
    expect(provider.calls[0]!.promptId).toBe("MOTION_DESIGNER");

    // Subject track persisted + audited.
    const stored = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: asset.id } });
    expect(parseSubjectTrackRecord(stored.subjectTrack)).toHaveLength(61);

    // New plan version, old one kept; state unchanged.
    const after = await getLatestEditPlan(prisma, item.id);
    expect(after!.id).not.toBe(before!.id);
    expect(after!.id).toBe(res.editPlanId);
    const timeline = EditTimelineSchema.parse((after!.plan as { timeline: unknown }).timeline);
    expect(timeline.visuals.map((v) => v.template)).toEqual(["NUMBER_COUNTER"]);
    // The model returned no theme -> the topic preset is saved on the timeline.
    expect(res.themeSource).toBe("FALLBACK");
    expect(timeline.motionTheme).toEqual(res.motionTheme);
    expect(timeline.motionTheme?.name).toBeTruthy();
    const head = { x: HEAD.x * 1080, y: HEAD.y * 1920, width: HEAD.w * 1080, height: HEAD.h * 1920 };
    expect(intersectionArea(visualRect(timeline.visuals[0]!, timeline.canvas), head)).toBe(0);
    expect((await prisma.contentItem.findUniqueOrThrow({ where: { id: item.id } })).currentState).toBe("EDIT_PLANNED");
    expect(await prisma.editPlan.count({ where: { contentItemId: item.id } })).toBe(2);

    // The invented number was rejected and the run is audit-logged with the reason.
    expect(res.rejectedVisuals![0]!.reason).toMatch(/FACTUAL: 31000/);
    const audits = await prisma.auditLog.findMany({ where: { entityId: item.id, action: { in: ["MOTION_DESIGN_RUN", "MEDIA_ASSET_SUBJECT_TRACKED"] } } });
    expect(audits.map((a) => a.action).sort()).toEqual(["MEDIA_ASSET_SUBJECT_TRACKED", "MOTION_DESIGN_RUN"]);
    expect(JSON.stringify(audits.find((a) => a.action === "MOTION_DESIGN_RUN")!.after)).toContain("FACTUAL");

    // Second run: the take already has a track, so the tracker isn't run again; the visual
    // from the first run is kept (and not duplicated in time).
    const res2 = await designMotionForContentItem(prisma, storage, provider, item.id, { actorId: "chris" }, { analyze: fakeAnalyzer(calls) });
    expect(res2.status).toBe("SUCCESS");
    expect(calls).toHaveLength(1);
    expect(res2.visuals!.filter((v) => v.template === "NUMBER_COUNTER")).toHaveLength(1);
  }, 60000);

  it("AUTO: only with the feature flag on, only on a fresh edit, recorded as a SYSTEM re-plan", async () => {
    const { item } = await makeEditPlannedItem();
    const provider = new MockModelProvider(() => designerResponse);
    await setFlag(prisma, { key: MOTION_AUTO_DESIGN_FLAG, enabled: false, actor: "test", actorType: "SYSTEM" });
    const off = await designMotionForContentItem(prisma, storage, provider, item.id, { actorId: "pipeline" }, { trigger: "AUTO", analyze: fakeAnalyzer([]) });
    expect(off.status).toBe("SKIPPED");
    expect(provider.calls).toHaveLength(0);

    await setFlag(prisma, { key: MOTION_AUTO_DESIGN_FLAG, enabled: true, actor: "test", actorType: "SYSTEM" });
    try {
      const on = await designMotionForContentItem(prisma, storage, provider, item.id, { actorId: "pipeline" }, { trigger: "AUTO", analyze: fakeAnalyzer([]) });
      expect(on.status, on.errorMessage).toBe("SUCCESS");
      const row = await getLatestEditPlan(prisma, item.id);
      expect(row!.revisionReason).toMatch(/^Motion Designer: 1 visual/);
      const audit = await prisma.auditLog.findFirst({ where: { entityId: item.id, action: "EDIT_PLAN_REPLANNED" } });
      expect(audit!.actorType).toBe("SYSTEM");
    } finally {
      await setFlag(prisma, { key: MOTION_AUTO_DESIGN_FLAG, enabled: false, actor: "test", actorType: "SYSTEM" });
    }
  }, 60000);

  it("a tracker failure degrades to assumed framing (with warnings), never blocks", async () => {
    const { item } = await makeEditPlannedItem();
    const provider = new MockModelProvider(() => designerResponse);
    const res = await designMotionForContentItem(prisma, storage, provider, item.id, { actorId: "chris" }, { analyze: fakeAnalyzer([], true) });
    expect(res.status).toBe("SUCCESS");
    expect(res.warnings!.join(" ")).toMatch(/Subject tracking failed/);
    expect(res.placementWarnings!.map((w) => w.code)).toContain("NO_SUBJECT_TRACK");
  }, 60000);

  it("trackSubjectForMediaAsset stores the track and keeps the old one on failure", async () => {
    const { asset } = await makeEditPlannedItem();
    const ok = await trackSubjectForMediaAsset(prisma, storage, asset.id, { actorId: "job" }, { analyze: fakeAnalyzer([]) });
    expect(ok).toMatchObject({ status: "SUCCESS", samples: 61, coverage: 1 });
    const failed = await trackSubjectForMediaAsset(prisma, storage, asset.id, { actorId: "job" }, { analyze: fakeAnalyzer([], true) });
    expect(failed.status).toBe("FAILED");
    const row = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: asset.id } });
    expect(parseSubjectTrackRecord(row.subjectTrack)).toHaveLength(61);
  }, 60000);
});
