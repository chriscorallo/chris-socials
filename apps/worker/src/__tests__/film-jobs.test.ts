import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  prisma,
  acquireHeavyJobLease,
  claimQueuedHeavyJob,
  enqueueHeavyJob,
  finishHeavyJob,
  getHeavyJob,
  listOnlineRenderWorkers,
  markRenderWorkerOffline,
  recordRenderWorkerHeartbeat,
} from "@chris/domain";
import { FFMPEG_PATH, LocalFsStorageAdapter } from "@chris/media";
import { assembleFilm, resolveFilm, type Film } from "@chris/cinema";
import { runFfmpeg } from "../../../../packages/cinema/src/audio/ffmpeg";
import { executeHeavyJob, runHeavyJobRecorded } from "../heavy-jobs";
import { filmRenderId, heavyJobSubject, parseHeavyJobArgs } from "../heavy-job-kinds";
import { filmPassthroughPlan, type CinemaEngine } from "../film-jobs";

/**
 * The mini-movie jobs against the throwaway database + local storage, with a fake picture engine
 * (ffmpeg-made frames instead of Chrome/WebGL, a sine instead of Kokoro) and the REAL assembly
 * and the REAL registration render: film-render → ContentItem RENDERED; chunked (sandbox-mode)
 * renders that queue parts and claim them back; storyboard; Chris's voice → narration lines;
 * the Mac worker's queue targeting and heartbeat.
 */

const W = 270;
const H = 480;

function film(id = "jobfilm", narration: Film["narration"] = undefined, shotSeconds = 1.5): Film {
  const cam = { rig: "HOLD" as const, target: [0, 1, 0] as [number, number, number], from: { distance: 6 }, lens: { focalLength: 32 } };
  return {
    dsl: 1,
    id,
    title: "Job film",
    format: { width: W, height: H, fps: 30 },
    look: "GOLD_STUDIO",
    ...(narration ? { narration } : {}),
    cast: [{ id: "c", kind: "COIN_STACK", visible: true }],
    scenes: [{ id: "s", set: { kind: "INFINITY_STUDIO" }, shots: [{ id: "a", duration: shotSeconds, ...(narration ? { line: "Your raise is gone." } : {}), camera: cam }, { id: "b", duration: shotSeconds, camera: cam }] }],
  };
}

/** Lossless gray frames whose level encodes the global frame index (never black: QC checks the opening). */
function encodeFrames(path: string, from: number, count: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG_PATH, ["-hide_banner", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "gray", "-s", `${W}x${H}`, "-r", "30", "-i", "-", "-c:v", "libx264", "-qp", "0", "-preset", "ultrafast", "-pix_fmt", "yuv420p", path]);
    p.on("error", reject);
    p.on("close", (c) => (c === 0 ? resolve() : reject(new Error(`ffmpeg ${c}`))));
    for (let i = 0; i < count; i++) p.stdin.write(Buffer.alloc(W * H, 60 + (((from + i) * 3) % 150)));
    p.stdin.end();
  });
}

function fakeEngine(calls: { frames: Array<[number, number]>; narration: unknown[] }): CinemaEngine {
  return {
    async prepareFilm(o) {
      calls.narration.push(o.narration ?? null);
      const rf = resolveFilm(o.film, null);
      await mkdir(o.workDir, { recursive: true });
      const audioPath = join(o.workDir, "mix.wav");
      await runFfmpeg(["-f", "lavfi", "-i", `sine=frequency=220:sample_rate=48000:duration=${rf.durationSeconds.toFixed(6)}`, "-ac", "2", audioPath]);
      return { film: o.film, clips: null, lines: o.narration ?? {}, rf, audioPath, mix: null, stagesMs: {} };
    },
    async renderFilmFrames(o) {
      const [a, b] = o.frameRange!;
      calls.frames.push([a, b]);
      await mkdir(join(o.outPath, ".."), { recursive: true });
      await encodeFrames(o.outPath, a, b - a + 1);
      o.onProgress?.(1, b - a + 1);
      return { frames: b - a + 1, width: W, height: H, ms: 1 };
    },
    assembleFilm,
    async renderStoryboard(o) {
      const rf = resolveFilm(o.film, o.clips ?? null);
      await mkdir(o.outDir, { recursive: true });
      const shots = [];
      for (const rs of rf.shots) {
        const frame = Math.round((rs.startFrame + rs.endFrame) / 2);
        const path = join(o.outDir, `f-${frame}.jpg`);
        await runFfmpeg(["-f", "lavfi", "-i", `color=c=0x553311:s=${W}x${H}:d=0.1`, "-frames:v", "1", path]);
        shots.push({ shotId: rs.shot.id, index: rs.index, sceneId: rs.sceneId, startSec: rs.startSec, endSec: rs.endSec, purpose: null, line: rs.shot.line ?? null, words: rs.words.map((w) => ({ word: w.raw, start: w.start, end: w.end })), stills: [{ frame, time: frame / 30, path }] });
      }
      return { shots, sheet: join(o.outDir, "none.jpg"), stills: shots.map((s) => s.stills[0]!.path), timingMeasured: false, durationSeconds: rf.durationSeconds, ms: 5 };
    },
    async narrationFromRecording(o) {
      const path = join(o.outDir, "a.wav");
      await runFfmpeg(["-f", "lavfi", "-i", "sine=frequency=200:sample_rate=24000:duration=1.2", path]);
      return {
        lines: { a: { path, durationSeconds: 1.2, words: [{ word: "Your", start: 0.1, end: 0.3 }, { word: "raise", start: 0.3, end: 0.6 }, { word: "is", start: 0.6, end: 0.7 }, { word: "gone.", start: 0.7, end: 1.1 }], heard: "Your raise is gone." } },
        report: { ok: true, matchedRatio: 1, missedWords: [], extraWords: [], shots: [], problems: [] },
      };
    },
    async narrateFilm() {
      return {};
    },
  };
}

describe("mini-movie jobs", () => {
  let dir: string;
  let storage: LocalFsStorageAdapter;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "chris-film-jobs-"));
    storage = new LocalFsStorageAdapter({ baseDir: join(dir, "store") });
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const ctx = (engine: CinemaEngine, extra: Record<string, unknown> = {}) => ({ db: prisma, storage, actor: { actorId: "chris" }, cinema: engine, film: { pollMs: 50, workRoot: join(dir, "work") }, ...extra });

  it("validates film job args and gives every request a stable id/lease", () => {
    const a = parseHeavyJobArgs("film-render", { film: film(), tier: "FINAL", chunks: 3, junk: 1 });
    expect(a).toEqual({ film: film(), tier: "FINAL", chunks: 3 });
    expect(() => parseHeavyJobArgs("film-render", { tier: "FINAL" })).toThrow(/film/);
    expect(() => parseHeavyJobArgs("film-render", { film: film(), tier: "ULTRA" })).toThrow(/tier/);
    expect(() => parseHeavyJobArgs("film-storyboard", { film: film(), stillsPerShot: 9 })).toThrow(/stillsPerShot/);
    expect(filmRenderId(a)).toBe(filmRenderId({ ...a }));
    expect(filmRenderId(a)).not.toBe(filmRenderId({ ...a, tier: "PREVIEW" }));
    expect(heavyJobSubject("film-render", a)).toMatch(/^film:fr-/);
    expect(heavyJobSubject("film-render-chunk", { renderId: "fr-x", chunkIndex: 2 })).toBe("film:fr-x:chunk:2");
    expect(filmPassthroughPlan(39.6, "T").captions.enabled).toBe(false);
  });

  it("renders a film and registers it as a video through the normal path (→ RENDERED, schedulable after the gates)", async () => {
    const calls = { frames: [] as Array<[number, number]>, narration: [] as unknown[] };
    const out = await executeHeavyJob("film-render", { film: film("reg-film"), tier: "PREVIEW" }, ctx(fakeEngine(calls)));
    expect(out.error ?? null).toBeNull();
    expect(out.ok).toBe(true);
    const r = out.result as { contentItemId: string; frames: number; videoKey: string; state: string; renderStatus: string; chunks: number };
    expect(r.frames).toBe(90);
    expect(r.chunks).toBe(1);
    expect(calls.frames).toEqual([[0, 89]]);
    expect(r.state).toBe("RENDERED");
    expect(r.renderStatus).toBe("SUCCESS");
    const item = await prisma.contentItem.findUniqueOrThrow({ where: { id: r.contentItemId } });
    expect(item.format).toBe("Mini-movie");
    const take = await prisma.mediaAsset.findFirstOrThrow({ where: { contentItemId: item.id, kind: "RAW_TAKE" } });
    expect(take.storageKey).toBe(`raw/${item.id}/film-${filmRenderId({ film: film("reg-film"), tier: "PREVIEW" })}.mp4`);
    const transitions = await prisma.contentStateTransition.findMany({ where: { contentItemId: item.id }, orderBy: { createdAt: "asc" } });
    expect(transitions.map((t) => t.toState)).toEqual(expect.arrayContaining(["FILMED", "MEDIA_INGESTED", "TAKE_SELECTED", "EDIT_PLANNED", "EDITING", "RENDERED"]));
    const contract = await prisma.productionContract.findFirstOrThrow({ where: { contentItemId: item.id } });
    expect(contract.factualRisk).not.toBe("LOW"); // the factual gate still applies before publishing
    const render = await prisma.render.findFirstOrThrow({ where: { contentItemId: item.id } });
    expect(render.status).toBe("SUCCESS");
    expect((await storage.get(r.videoKey)).byteLength).toBeGreaterThan(1000);
    // idempotent: the same request returns the finished render, renders nothing, registers nothing new
    const again = await executeHeavyJob("film-render", { film: film("reg-film"), tier: "PREVIEW" }, ctx(fakeEngine(calls)));
    expect((again.result as { reused: boolean; contentItemId: string }).reused).toBe(true);
    expect(calls.frames).toHaveLength(1);
    expect(await prisma.contentItem.count({ where: { format: "Mini-movie", title: "Job film" } })).toBe(1);
  }, 120_000);

  it("in the cloud, splits the picture into chunk jobs, renders them (claiming queued parts) and assembles frame-exactly", async () => {
    const calls = { frames: [] as Array<[number, number]>, narration: [] as unknown[] };
    const args = { film: film("chunked", undefined, 3), tier: "FINAL" as const, chunks: 3, register: false };
    const lease = await acquireHeavyJobLease(prisma, { contentItemId: heavyJobSubject("film-render", args), jobKind: "film-render", args, mode: "sandbox", actorId: "chris", maxConcurrentSandboxes: 50 });
    if (!lease.acquired) throw new Error("no lease");
    const out = await runHeavyJobRecorded(lease.jobRunId, "film-render", args, ctx(fakeEngine(calls)));
    expect(out.error ?? null).toBeNull();
    const r = out.result as { frames: number; chunks: number; renderId: string };
    expect(r.chunks).toBe(3);
    expect(r.frames).toBe(180);
    expect(calls.frames.sort((x, y) => x[0] - y[0])).toEqual([[0, 59], [60, 119], [120, 179]]);
    // the queued parts were claimed and finished, not left waiting
    const parts = await prisma.jobRun.findMany({ where: { kind: { startsWith: `heavy:film:${r.renderId}:chunk:` } } });
    expect(parts).toHaveLength(2);
    expect(parts.every((p) => p.status === "SUCCEEDED")).toBe(true);
    expect((await getHeavyJob(prisma, lease.jobRunId))!.status).toBe("SUCCEEDED");
  }, 120_000);

  it("a chunk job renders its frame range from the manifest (another worker's view)", async () => {
    const calls = { frames: [] as Array<[number, number]>, narration: [] as unknown[] };
    const args = { film: film("parts"), tier: "PREVIEW" as const, chunks: 2, register: false };
    const lease = await acquireHeavyJobLease(prisma, { contentItemId: heavyJobSubject("film-render", args), jobKind: "film-render", args, mode: "sandbox", actorId: "chris", maxConcurrentSandboxes: 50 });
    if (!lease.acquired) throw new Error("no lease");
    // a second worker takes part 1 while the parent renders part 0
    const parent = runHeavyJobRecorded(lease.jobRunId, "film-render", args, ctx(fakeEngine(calls)));
    let claimed = null;
    for (let i = 0; i < 100 && !claimed; i++) {
      claimed = await claimQueuedHeavyJob(prisma, { kinds: ["film-render-chunk"] });
      if (!claimed) await new Promise((r) => setTimeout(r, 20));
    }
    if (claimed) {
      const o = await runHeavyJobRecorded(claimed.jobRunId, "film-render-chunk", claimed.args, ctx(fakeEngine(calls)));
      expect(o.ok).toBe(true);
    }
    const done = await parent;
    expect(done.ok).toBe(true);
    expect((done.result as { frames: number }).frames).toBe(90);
  }, 120_000);

  it("storyboard: stills per shot with timing and the narration each shot covers", async () => {
    const f = film("sb", { engine: "KOKORO", voice: "af_heart" });
    const out = await executeHeavyJob("film-storyboard", { film: f }, ctx(fakeEngine({ frames: [], narration: [] })));
    expect(out.ok).toBe(true);
    const r = out.result as { shots: Array<{ shotId: string; line: string | null; words: unknown[]; stills: Array<{ key: string; frame: number }>; startSec: number; endSec: number }> };
    expect(r.shots.map((s) => s.shotId)).toEqual(["a", "b"]);
    expect(r.shots[0]!.line).toBe("Your raise is gone.");
    expect(r.shots[0]!.words).toHaveLength(4);
    expect(r.shots[1]!.line).toBeNull();
    for (const s of r.shots) expect((await storage.get(s.stills[0]!.key)).byteLength).toBeGreaterThan(100);
  });

  it("Chris's voice: align an upload, then render with it (engine CHRIS)", async () => {
    const calls = { frames: [] as Array<[number, number]>, narration: [] as unknown[] };
    const f = film("chris-voice", { engine: "CHRIS", voice: "chris" });
    await storage.put("uploads/narration/take1.m4a", Buffer.from("fake audio"));
    const al = await executeHeavyJob("film-voice-align", { film: f, recordingKey: "uploads/narration/take1.m4a" }, ctx(fakeEngine(calls)));
    expect(al.ok).toBe(true);
    const { linesKey } = al.result as { linesKey: string };
    const noVoice = await executeHeavyJob("film-render", { film: f, tier: "PREVIEW", register: false }, ctx(fakeEngine(calls)));
    expect(noVoice.ok).toBe(false);
    expect(noVoice.error).toMatch(/narrated by Chris/);
    const withVoice = await executeHeavyJob("film-render", { film: f, tier: "PREVIEW", register: false, narrationKey: linesKey }, ctx(fakeEngine(calls)));
    expect(withVoice.ok).toBe(true);
    const lines = calls.narration.at(-1) as Record<string, { words: unknown[] }>;
    expect(Object.keys(lines)).toEqual(["a"]);
    expect(lines.a!.words).toHaveLength(4);
  }, 60_000);

  it("an invalid film fails with the validator's explanation (nothing rendered)", async () => {
    const bad = { ...film("bad"), cast: [{ id: "c", kind: "NOPE" }] };
    const out = await executeHeavyJob("film-render", { film: bad as unknown as Film, tier: "PREVIEW" }, ctx(fakeEngine({ frames: [], narration: [] })));
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/cast\[0\]\.kind/);
  });

  it("jobs queued for the Mac are only taken by the Mac worker; the worker's heartbeat says it's online", async () => {
    const q = await enqueueHeavyJob(prisma, { subject: "film-storyboard:mac-test", jobKind: "film-storyboard", args: { film: film("mac") }, mode: "worker", actorId: "chris", target: "mac" });
    expect(q.queued).toBe(true);
    const cloud = await claimQueuedHeavyJob(prisma, { subjects: ["film-storyboard:mac-test"] });
    expect(cloud).toBeNull();
    const mac = await claimQueuedHeavyJob(prisma, { target: "mac", kinds: ["film-storyboard"], subjects: ["film-storyboard:mac-test"] });
    expect(mac?.jobKind).toBe("film-storyboard");
    await finishHeavyJob(prisma, mac!.jobRunId, { status: "SUCCEEDED" });

    const t0 = new Date("2026-10-18T10:00:00Z");
    await recordRenderWorkerHeartbeat(prisma, { workerId: "mac-test", host: "chris-mbp", gpu: true, kinds: ["film-render"] }, t0);
    expect((await listOnlineRenderWorkers(prisma, { now: new Date(t0.getTime() + 30_000) })).map((w) => w.workerId)).toContain("mac-test");
    expect((await listOnlineRenderWorkers(prisma, { now: new Date(t0.getTime() + 5 * 60_000) })).map((w) => w.workerId)).not.toContain("mac-test");
    await markRenderWorkerOffline(prisma, "mac-test");
    expect((await listOnlineRenderWorkers(prisma, { now: new Date(t0.getTime() + 30_000) })).map((w) => w.workerId)).not.toContain("mac-test");
  });
});

void writeFile;
