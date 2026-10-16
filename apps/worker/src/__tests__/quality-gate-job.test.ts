import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  prisma,
  Prisma,
  createContentItem,
  applyTransition,
  applyPipelineResult,
  createMediaAsset,
  analyzeMediaAsset,
  recordTakeSelection,
  recordEditPlan,
  getLatestQCReport,
  getQCIssuesForReport,
} from "@chris/domain";
import { MockModelProvider } from "@chris/agents";
import { FFMPEG_PATH, LocalFsStorageAdapter } from "@chris/media";
import { renderContentItem } from "../render-job";
import { runQualityGateForContentItem } from "../quality-gate-job";

/**
 * The real proof of Phase 4's acceptance criterion (/docs/PHASE_PLAN.md): a full ContentItem
 * is driven through the real pipeline (Research -> Claims Gate -> Script -> Brand Guardian
 * results persisted, real media ingested, real ffmpeg render) and the Quality Gate combines
 * all four hard gates deterministically. Only the Visual QA agent call is mocked (no API key
 * in this environment, and the agent's own contract is separately proven in
 * packages/agents/src/__tests__/media-agents.test.ts) — frame extraction is real ffmpeg
 * against a real rendered file.
 */
const DEV_FONT_PATH = "/System/Library/Fonts/Supplemental/Arial.ttf";

function runFfmpegRaw(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG_PATH, args);
    let stderr = "";
    proc.stderr.on("data", (c) => (stderr += c.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => (code === 0 ? resolve() : reject(new Error(stderr.slice(-1000)))));
  });
}

const HIGH_SCORE_BRAND_REPORT = {
  brandScore: 90,
  voiceScore: 88,
  originalityScore: 80,
  strategicFit: "Strong fit with the current thesis.",
  risks: [],
  requiredChanges: [],
  optionalImprovements: [],
};

const PASSING_CLAIMS_GATE_RESULT = {
  claims: [],
  result: "PASS" as const,
  requiredEdits: [],
  blockReason: null,
};

describe("runQualityGateForContentItem (real ffmpeg render, real state machine, mocked Visual QA)", () => {
  let storageDir: string;
  let storage: LocalFsStorageAdapter;
  let fixtureBytes: Buffer;

  beforeAll(async () => {
    storageDir = await mkdtemp(join(tmpdir(), "chris-quality-gate-storage-"));
    storage = new LocalFsStorageAdapter({ baseDir: storageDir });

    const genDir = await mkdtemp(join(tmpdir(), "chris-quality-gate-fixture-"));
    const fixturePath = join(genDir, "fixture.mp4");
    await runFfmpegRaw([
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=640x480:duration=6:rate=30",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=1000:duration=6",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      fixturePath,
    ]);
    fixtureBytes = await readFile(fixturePath);
    await rm(genDir, { recursive: true, force: true });
  }, 30000);

  afterAll(async () => {
    await rm(storageDir, { recursive: true, force: true });
  });

  async function makeRenderedItem(textOverlays: unknown[] = []) {
    const item = await createContentItem(prisma, { title: "Quality gate job test idea" }, {
      actorId: "test-user",
    });
    for (const to of ["SELECTED", "CONTRACTED", "RESEARCHING"] as const) {
      await applyTransition(prisma, { contentItemId: item.id, to, actorType: "SYSTEM" });
    }

    // Real pipeline persistence — not a shortcut. This is what makes claimsGateResult and
    // brandGuardianReport genuinely available to the Quality Gate job later, exactly as they
    // would be after a real Research -> Script pipeline run (Phase 2).
    await applyPipelineResult(
      prisma,
      item.id,
      {
        status: "READY",
        research: {
          primaryClaim: "A test claim.",
          facts: [],
          citations: [],
          numericInputs: [],
          calculationNotes: null,
          caveats: [],
          confidence: 0.9,
          contradictoryEvidence: [],
          prohibitedClaims: [],
          contentSafeWording: "A test claim, safely worded.",
          status: "READY",
          stopResearching: true,
        },
        claimsGateResult: PASSING_CLAIMS_GATE_RESULT,
        script: {
          spokenScript: "Here's the point, made clearly.",
          beats: [],
          intendedPauses: [],
          emphasizedWords: [],
          visualBeats: [],
          requiredFactualCaveats: [],
          targetRuntimeSeconds: 6,
          estimatedSpeakingRuntimeSeconds: 6,
          followUpIdeas: [],
        },
        brandGuardianReport: HIGH_SCORE_BRAND_REPORT,
      },
      { actorId: "chris" },
    );

    for (const to of ["READY_TO_FILM", "FILMED"] as const) {
      await applyTransition(prisma, { contentItemId: item.id, to, actorType: "SYSTEM" });
    }

    const storageKey = `raw/${item.id}/take-1.mp4`;
    await storage.put(storageKey, fixtureBytes);
    const asset = await createMediaAsset(
      prisma,
      {
        contentItemId: item.id,
        kind: "RAW_TAKE",
        storageKey,
        originalFilename: "take-1.mp4",
        mimeType: "video/mp4",
        sizeBytes: fixtureBytes.byteLength,
      },
      { actorId: "chris" },
    );
    await analyzeMediaAsset(
      prisma,
      asset.id,
      {
        durationSeconds: 6,
        width: 640,
        height: 480,
        frameRate: 30,
        hasAudio: true,
        videoCodec: "h264",
        audioCodec: "aac",
        transcript: "Here's the point, made clearly.",
      },
      { actorId: "chris" },
    );
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
        productionTier: "FAST",
        targetDurationSeconds: 4,
        plan: {
          segments: [{ startSeconds: 1, endSeconds: 5 }],
          targetDimensions: { width: 1080, height: 1920 },
          textOverlays,
          normalizeAudio: true,
          bRollRequests: [],
          musicTrack: null,
          sfxEvents: [],
          transitions: [],
          targetDurationSeconds: 4,
          productionTier: "FAST",
          doNothingElse: false,
          rationale: "Trim to the strongest 4 seconds.",
        },
      },
      { actorId: "chris" },
    );

    const renderResult = await renderContentItem(
      prisma,
      storage,
      item.id,
      { fontPath: DEV_FONT_PATH },
      { actorId: "chris" },
    );
    expect(renderResult.status).toBe("SUCCESS");

    return { item };
  }

  it(
    "an all-clean render passes every gate and lands the item at READY",
    async () => {
      const { item } = await makeRenderedItem();
      const cleanVisualQA = new MockModelProvider(() => ({
        issues: [],
        overallImpression: "Clean render, no defects observed.",
      }));

      const result = await runQualityGateForContentItem(
        prisma,
        storage,
        cleanVisualQA,
        item.id,
        { actorId: "chris" },
        { maxFrames: 3 },
      );

      expect(result.overallStatus).toBe("PASS");
      expect(result.gates).toEqual({ factual: "PASS", technical: "PASS", brand: "PASS", creative: "PASS" });

      const updated = await prisma.contentItem.findUniqueOrThrow({ where: { id: item.id } });
      expect(updated.currentState).toBe("READY");

      const qcReport = await getLatestQCReport(prisma, item.id);
      expect(qcReport?.id).toBe(result.qcReportId);
      const issues = await getQCIssuesForReport(prisma, result.qcReportId);
      expect(issues).toEqual([]);
    },
    30000,
  );

  it(
    "FACTUAL fails closed: no Claims Gate verdict on record BLOCKs instead of silently passing",
    async () => {
      const { item } = await makeRenderedItem();
      // Simulates the old gate-skip path (research advanced without a Claims Gate run).
      await prisma.researchPacket.updateMany({
        where: { contentItemId: item.id },
        data: { claimsGateResult: Prisma.DbNull },
      });
      const cleanVisualQA = new MockModelProvider(() => ({ issues: [], overallImpression: "Clean." }));

      const result = await runQualityGateForContentItem(
        prisma,
        storage,
        cleanVisualQA,
        item.id,
        { actorId: "chris" },
        { maxFrames: 2 },
      );

      expect(result.gates.factual).toBe("BLOCK");
      expect(result.overallStatus).toBe("BLOCK");
      expect(result.reasons.join(" ")).toMatch(/No Claims Gate verdict/);
      const updated = await prisma.contentItem.findUniqueOrThrow({ where: { id: item.id } });
      expect(updated.currentState).toBe("QC_REPAIR");
    },
    30000,
  );

  it(
    "a BLOCKING Visual QA finding escalates TECHNICAL to BLOCK and routes to QC_REPAIR",
    async () => {
      const { item } = await makeRenderedItem();
      const blockingVisualQA = new MockModelProvider(() => ({
        issues: [
          {
            category: "FACE_OBSTRUCTION",
            description: "The caption fully covers the speaker's mouth for the whole clip.",
            severity: "BLOCKING",
            timestampSeconds: 1.0,
            recommendedRepair: "Move the caption to the TOP of frame.",
          },
        ],
        overallImpression: "One blocking defect: caption over mouth throughout.",
      }));

      const result = await runQualityGateForContentItem(
        prisma,
        storage,
        blockingVisualQA,
        item.id,
        { actorId: "chris" },
        { maxFrames: 3 },
      );

      expect(result.overallStatus).toBe("BLOCK");
      expect(result.gates.technical).toBe("BLOCK");
      expect(result.gates.factual).toBe("PASS"); // proves this isn't blanket-BLOCKing every gate

      const updated = await prisma.contentItem.findUniqueOrThrow({ where: { id: item.id } });
      expect(updated.currentState).toBe("QC_REPAIR");

      const issues = await getQCIssuesForReport(prisma, result.qcReportId);
      expect(issues.some((i) => i.source === "VISUAL_QA" && i.severity === "BLOCKING")).toBe(true);
    },
    30000,
  );

  it(
    "weak brand/voice scores BLOCK the BRAND gate even with a clean Visual QA report",
    async () => {
      const item = await createContentItem(prisma, { title: "Weak brand fit idea" }, {
        actorId: "test-user",
      });
      for (const to of ["SELECTED", "CONTRACTED", "RESEARCHING"] as const) {
        await applyTransition(prisma, { contentItemId: item.id, to, actorType: "SYSTEM" });
      }
      await applyPipelineResult(
        prisma,
        item.id,
        {
          status: "READY",
          research: {
            primaryClaim: "A test claim.",
            facts: [],
            citations: [],
            numericInputs: [],
            calculationNotes: null,
            caveats: [],
            confidence: 0.9,
            contradictoryEvidence: [],
            prohibitedClaims: [],
            contentSafeWording: "A test claim, safely worded.",
            status: "READY",
            stopResearching: true,
          },
          claimsGateResult: PASSING_CLAIMS_GATE_RESULT,
          script: {
            spokenScript: "Off-voice script.",
            beats: [],
            intendedPauses: [],
            emphasizedWords: [],
            visualBeats: [],
            requiredFactualCaveats: [],
            targetRuntimeSeconds: 6,
            estimatedSpeakingRuntimeSeconds: 6,
            followUpIdeas: [],
          },
          brandGuardianReport: {
            ...HIGH_SCORE_BRAND_REPORT,
            brandScore: 40,
            voiceScore: 35,
          },
        },
        { actorId: "chris" },
      );
      for (const to of ["READY_TO_FILM", "FILMED"] as const) {
        await applyTransition(prisma, { contentItemId: item.id, to, actorType: "SYSTEM" });
      }
      const storageKey = `raw/${item.id}/take-1.mp4`;
      await storage.put(storageKey, fixtureBytes);
      const asset = await createMediaAsset(
        prisma,
        {
          contentItemId: item.id,
          kind: "RAW_TAKE",
          storageKey,
          originalFilename: "take-1.mp4",
          mimeType: "video/mp4",
          sizeBytes: fixtureBytes.byteLength,
        },
        { actorId: "chris" },
      );
      await analyzeMediaAsset(
        prisma,
        asset.id,
        {
          durationSeconds: 6,
          width: 640,
          height: 480,
          frameRate: 30,
          hasAudio: true,
          videoCodec: "h264",
          audioCodec: "aac",
          transcript: "Off-voice script.",
        },
        { actorId: "chris" },
      );
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
          productionTier: "FAST",
          targetDurationSeconds: 4,
          plan: {
            segments: [{ startSeconds: 1, endSeconds: 5 }],
            targetDimensions: { width: 1080, height: 1920 },
            textOverlays: [],
            normalizeAudio: true,
            bRollRequests: [],
            musicTrack: null,
            sfxEvents: [],
            transitions: [],
            targetDurationSeconds: 4,
            productionTier: "FAST",
            doNothingElse: false,
            rationale: "Trim to the strongest 4 seconds.",
          },
        },
        { actorId: "chris" },
      );
      await renderContentItem(prisma, storage, item.id, { fontPath: DEV_FONT_PATH }, { actorId: "chris" });

      const cleanVisualQA = new MockModelProvider(() => ({ issues: [], overallImpression: "Clean." }));
      const result = await runQualityGateForContentItem(
        prisma,
        storage,
        cleanVisualQA,
        item.id,
        { actorId: "chris" },
        { maxFrames: 3 },
      );

      expect(result.overallStatus).toBe("BLOCK");
      expect(result.gates.brand).toBe("BLOCK");
      expect(result.gates.technical).toBe("PASS"); // proves BRAND alone drives the BLOCK, nothing else
      expect(result.reasons.some((r) => r.toLowerCase().includes("brand"))).toBe(true);
    },
    30000,
  );

  it(
    "overlapping same-position text overlays BLOCK on the deterministic collision check alone",
    async () => {
      const { item } = await makeRenderedItem([
        { text: "Headline", startSeconds: 0, endSeconds: 3, position: "BOTTOM", style: "HEADLINE" },
        { text: "Caption", startSeconds: 1, endSeconds: 4, position: "BOTTOM", style: "CAPTION" },
      ]);
      const cleanVisualQA = new MockModelProvider(() => ({ issues: [], overallImpression: "Clean." }));

      const result = await runQualityGateForContentItem(
        prisma,
        storage,
        cleanVisualQA,
        item.id,
        { actorId: "chris" },
        { maxFrames: 3 },
      );

      expect(result.overallStatus).toBe("BLOCK");
      expect(result.gates.technical).toBe("BLOCK");

      const issues = await getQCIssuesForReport(prisma, result.qcReportId);
      expect(issues.some((i) => i.source === "OVERLAY_COLLISION" && i.severity === "BLOCKING")).toBe(true);
    },
    30000,
  );
});
