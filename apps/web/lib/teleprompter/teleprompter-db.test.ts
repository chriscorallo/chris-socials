import { describe, expect, it } from "vitest";
import { prisma, commitPlanImport, advancePlannedItemToFilmed, createContentItemFromFootage, ymdInTz, addDaysYmd } from "@chris/domain";
import { listPrompterPicks, loadPrompterVideo, prompterCanFilm } from "./data";
import { deliverTakes } from "./handoff";

/**
 * Teleprompter against the real (throwaway) database: which script it shows for a planned
 * video as that video gains shot notes and a script, the "what are you filming?" list, and the
 * take handoff walking a planned video to FILMED / creating a footage-first one — the same
 * domain calls the server actions make (preparePlannedUpload, createFootageItem).
 */
const TZ = "America/Los_Angeles";
const actor = { actorId: "chris" };
const uniq = () => Math.random().toString(36).slice(2, 8);

async function planOne(tag: string, ymd: string) {
  const res = await commitPlanImport(
    prisma,
    { sourceKind: "TEXT", rawInput: `tp ${tag}`, rows: [{ title: `Fees talk ${tag}`, ymd, time: "09:00", platforms: ["TIKTOK"], hook: "Stop paying 1% fees", notes: "Index funds\nExpense ratios", format: null, pillar: null }] },
    actor,
    { tz: TZ, plan: null },
  );
  return prisma.contentItem.findFirstOrThrow({ where: { planImportId: res.importId } });
}

describe("teleprompter (database)", () => {
  it("shows plan hook/notes → shot notes → latest script as the video matures", async () => {
    const tag = uniq();
    const item = await planOne(tag, addDaysYmd(ymdInTz(new Date(), TZ), 2));

    let v = await loadPrompterVideo(prisma, item.id);
    expect(v).toMatchObject({ state: "SELECTED", canFilm: true, takes: 0, source: { kind: "plan", text: "Stop paying 1% fees\n\nIndex funds\nExpense ratios" } });

    await prisma.creatorCard.create({ data: { contentItemId: item.id, hook: "Your advisor costs you $400k", talkingPoints: ["1% compounds", "Index funds"], setup: "DESK" } });
    v = await loadPrompterVideo(prisma, item.id);
    expect(v?.source).toMatchObject({ kind: "card", text: "Your advisor costs you $400k\n\n• 1% compounds\n\n• Index funds" });

    const base = { beats: [], intendedPauses: [], emphasizedWords: [], visualBeats: [], requiredFactualCaveats: [], targetRuntimeSeconds: 45, estimatedSpeakingRuntimeSeconds: 44, followUpIdeas: [] };
    await prisma.scriptVersion.create({ data: { ...base, contentItemId: item.id, spokenScript: "First draft.", createdAt: new Date(Date.now() - 60_000) } });
    await prisma.scriptVersion.create({ data: { ...base, contentItemId: item.id, spokenScript: "Final words  here.", authorType: "HUMAN" } });
    v = await loadPrompterVideo(prisma, item.id);
    expect(v?.source).toEqual({ kind: "script", label: "Your script (v2, your edit)", text: "Final words here." });

    expect(await loadPrompterVideo(prisma, "does-not-exist")).toBeNull();
  });

  it("lists not-filmed planned videos (with script flag) and drops them once filmed", async () => {
    const tag = uniq();
    const item = await planOne(tag, ymdInTz(new Date(), TZ));
    let picks = await listPrompterPicks(prisma, TZ, 500);
    const pick = picks.find((p) => p.id === item.id);
    expect(pick).toMatchObject({ when: "Today", hook: "Stop paying 1% fees", hasScript: false });

    await advancePlannedItemToFilmed(prisma, item.id, actor);
    picks = await listPrompterPicks(prisma, TZ, 500);
    expect(picks.some((p) => p.id === item.id)).toBe(false);
  });

  it("hands a take to a planned video: SELECTED → FILMED (honest steps), then the upload", async () => {
    const tag = uniq();
    const item = await planOne(tag, addDaysYmd(ymdInTz(new Date(), TZ), 1));
    const uploaded: string[] = [];
    const r = await deliverTakes(
      {
        // what preparePlannedUpload does (minus the session)
        prepareExisting: async (id) => {
          await advancePlannedItemToFilmed(prisma, id, actor);
          return { ok: true };
        },
        createNew: async () => ({ error: "unused" }),
        upload: async (id, f) => {
          const now = await prisma.contentItem.findUniqueOrThrow({ where: { id } });
          uploaded.push(`${now.currentState}:${f.name}`); // must already be FILMED when the bytes arrive
        },
      },
      { kind: "existing", contentItemId: item.id },
      [new File([new Uint8Array(8)], "teleprompter-take-1.mp4", { type: "video/mp4" })],
      () => undefined,
    );
    expect(r).toMatchObject({ ok: true, contentItemId: item.id, uploaded: 1 });
    expect(uploaded).toEqual(["FILMED:teleprompter-take-1.mp4"]);
    const hist = await prisma.contentStateTransition.findMany({ where: { contentItemId: item.id }, orderBy: { createdAt: "asc" } });
    expect(hist.at(-1)).toMatchObject({ toState: "FILMED" });
    expect(prompterCanFilm("FILMED")).toBe(true);
    expect(prompterCanFilm("PUBLISHED")).toBe(false);
    expect(prompterCanFilm("CANCELLED")).toBe(false);

    // Retrying the whole handoff is safe (the walk is idempotent).
    const again = await deliverTakes(
      { prepareExisting: async (id) => (await advancePlannedItemToFilmed(prisma, id, actor), { ok: true }), createNew: async () => ({ error: "unused" }), upload: async () => undefined },
      { kind: "existing", contentItemId: item.id },
      [new File([new Uint8Array(8)], "t2.mp4", { type: "video/mp4" })],
      () => undefined,
    );
    expect(again.ok).toBe(true);
  });

  it("a new video from the prompter is created footage-first and lands in FILMED", async () => {
    const tag = uniq();
    const r = await deliverTakes(
      {
        prepareExisting: async () => ({ error: "unused" }),
        createNew: async (title) => ({ id: (await createContentItemFromFootage(prisma, { title }, actor)).id }),
        upload: async () => undefined,
      },
      { kind: "new", title: `Prompter new ${tag}` },
      [new File([new Uint8Array(8)], "t.mp4", { type: "video/mp4" })],
      () => undefined,
    );
    expect(r.ok).toBe(true);
    const created = await prisma.contentItem.findUniqueOrThrow({ where: { id: r.contentItemId! } });
    expect(created).toMatchObject({ title: `Prompter new ${tag}`, currentState: "FILMED" });
  });
});
