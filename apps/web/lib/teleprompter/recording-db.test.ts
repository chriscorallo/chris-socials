import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, copyFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { prisma, createContentItem, openRecordingSession, finishRecordingSession, nextActionFor } from "@chris/domain";
import { FFMPEG_PATH } from "@chris/media";

/**
 * Segmented recording against the real (throwaway) database, through the same upload tail the
 * local route and the Blob registration use (registerUploadedRawTake + segment fields):
 * idempotent part registration on retry, refusal after Finish (and no stray take left), the
 * prompter's draft view, the "Continue: …" list and the video cards' "Continue filming".
 * docs/decisions-pending/segmented-recording-drafts.md
 */
const run = promisify(execFile);
const actor = { actorId: "chris" };
let dir: string;
let clip: string;
const saved: Record<string, string | undefined> = {};
const ENV = { TRANSCRIPTION: "off", SUBJECT_TRACKING: "off", PERSON_MATTE: "off", RENDER_MODE: "inline" } as const;

type IngestMod = typeof import("../ingest-upload");
type DataMod = typeof import("./data");
let ingest: IngestMod;
let data: DataMod;
let cards: typeof import("../video-cards");

beforeAll(async () => {
  for (const [k, v] of Object.entries(ENV)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  dir = await mkdtemp(join(tmpdir(), "chris-rec-web-"));
  saved.STORAGE_LOCAL_DIR = process.env.STORAGE_LOCAL_DIR;
  process.env.STORAGE_LOCAL_DIR = join(dir, "storage");
  clip = join(dir, "part.mp4");
  await run(FFMPEG_PATH, ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=180x320:r=30:d=2", "-f", "lavfi", "-i", "sine=f=220:d=2", "-c:v", "libx264", "-preset", "veryfast", "-c:a", "aac", "-shortest", clip]);
  ingest = await import("../ingest-upload");
  data = await import("./data");
  cards = await import("../video-cards");
}, 60_000);
afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await rm(dir, { recursive: true, force: true });
});

async function upload(contentItemId: string, recordingSessionId: string, key: string, index: number) {
  const { storage } = await import("../storage");
  const storageKey = `raw/${contentItemId}/${Date.now()}-${key}.mp4`;
  const local = join(dir, `${key}-${Math.random().toString(36).slice(2)}.mp4`);
  await copyFile(clip, local);
  await storage.put(storageKey, await readFile(local));
  return ingest.registerUploadedRawTake({
    contentItemId,
    storageKey,
    originalFilename: `${key}.mp4`,
    mimeType: "video/mp4",
    sizeBytes: 100,
    localPath: local,
    actorId: "chris",
    segment: ingest.parseSegmentMeta((k) => ({ recordingSessionId, segmentKey: key, segmentIndex: String(index), segmentSeconds: "2", scriptStart: "0", scriptEnd: String(0.2 * (index + 1)) })[k] ?? null),
  });
}

describe("segmented recording (web, database)", () => {
  it("registers parts idempotently, shows the draft, refuses parts after Finish without leaving a stray take", async () => {
    const item = await createContentItem(prisma, { title: `Draft web ${Math.random().toString(36).slice(2, 6)}` }, actor);
    const { session } = await openRecordingSession(prisma, { contentItemId: item.id }, actor);
    const a = await upload(item.id, session.id, "w1", 0);
    const retry = await upload(item.id, session.id, "w1", 0); // the response was lost; the phone retries
    expect(retry.id).toBe(a.id);
    await upload(item.id, session.id, "w2", 1);
    expect(await prisma.mediaAsset.count({ where: { contentItemId: item.id, kind: "RAW_TAKE" } })).toBe(2);
    const analysed = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: a.id } });
    expect(analysed.durationSeconds).toBeGreaterThan(1.5);

    const draft = await data.loadPrompterDraft(prisma, item.id);
    expect(draft).toMatchObject({ recordingSessionId: session.id, contentItemId: item.id });
    expect(draft!.segments.map((s) => s.key)).toEqual(["w1", "w2"]);
    expect(draft!.segments[0]!.url).toMatch(/^\/api\/media\/raw\//);
    expect(draft!.scriptPosition).toBeCloseTo(0.4);

    const picks = await data.listPrompterDraftPicks(prisma);
    expect(picks.find((p) => p.id === item.id)?.label).toMatch(/^2 parts · 0:0\d filmed$/);
    const card = (await cards.loadVideoCards({ limit: 500 })).find((c) => c.id === item.id)!;
    expect(card.draft).toMatchObject({ parts: 2 });
    expect(card.next.kind).toBe("CONTINUE_FILMING");
    expect(nextActionFor(card.state).kind).toBe("START_EDIT"); // what it would be without the draft

    await finishRecordingSession(prisma, { recordingSessionId: session.id, contentItemId: item.id }, actor);
    await expect(upload(item.id, session.id, "late", 2)).rejects.toThrow(/refused/);
    expect(await prisma.mediaAsset.count({ where: { contentItemId: item.id, kind: "RAW_TAKE" } })).toBe(2);
    expect(await data.loadPrompterDraft(prisma, item.id)).toBeNull();
  }, 60_000);

  it("parses segment fields defensively", () => {
    expect(ingest.parseSegmentMeta(() => null)).toBeNull();
    const m = ingest.parseSegmentMeta((k) => ({ recordingSessionId: "s", segmentKey: "k", segmentIndex: "1.5", segmentSeconds: "abc" })[k] ?? null);
    expect(m).toEqual({ recordingSessionId: "s", clientKey: "k", segmentIndex: null, durationSeconds: null, scriptPositionStart: null, scriptPositionEnd: null });
  });
});
