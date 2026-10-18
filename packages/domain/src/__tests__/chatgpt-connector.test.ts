import { describe, expect, it } from "vitest";
import { prisma } from "../prisma";
import { commitPlanImport } from "../plan-import-db";
import { advancePlannedItemToFilmed } from "../footage-first";
import { isScriptVersionFilmable } from "../script-version";
import { videoCode } from "../script-import";
import { scriptStyleFrom, scriptWritingRules, buildScriptPrompt } from "../script-import/prompt";
import {
  CONNECTOR_REASON,
  canonicalScriptBlock,
  getConnectorVideo,
  listVideosNeedingScripts,
  saveConnectorScripts,
  ListVideosArgs,
  SaveScriptsArgs,
} from "../chatgpt-connector";

const TZ = "America/Los_Angeles";
const actor = { actorId: "chris" };
const style = scriptStyleFrom(null);
const uniq = () => Math.random().toString(36).slice(2, 8);
const saveCtx = { tz: TZ, wpm: 200, targetSeconds: { min: 45, max: 70 }, grantId: "grant-test" };

async function plan(rows: { title: string; ymd: string }[]) {
  const res = await commitPlanImport(
    prisma,
    {
      sourceKind: "TEXT",
      rawInput: `connector ${uniq()}`,
      rows: rows.map((r) => ({ title: r.title, ymd: r.ymd, time: null, platforms: ["TIKTOK"], hook: `Hook for ${r.title}`, notes: "Notes here", format: null, pillar: null })),
    },
    actor,
    { tz: TZ, plan: null },
  );
  const items = await prisma.contentItem.findMany({ where: { planImportId: res.importId } });
  return rows.map((r) => items.find((i) => i.title === r.title)!);
}

describe("ChatGPT connector tool schemas", () => {
  it("list args: default 15, max 30, date format", () => {
    expect(ListVideosArgs.parse({})).toMatchObject({ batchSize: 15, includeWithScripts: false, offset: 0 });
    expect(() => ListVideosArgs.parse({ batchSize: 31 })).toThrow();
    expect(() => ListVideosArgs.parse({ from: "Oct 21" })).toThrow();
  });
  it("save args: structured, id or code required, ≤ 30 items", () => {
    expect(() => SaveScriptsArgs.parse({ scripts: [{ hook: "h", script: "s" }] })).toThrow(/videoId or code/);
    expect(() => SaveScriptsArgs.parse({ scripts: [] })).toThrow();
    const many = Array.from({ length: 31 }, () => ({ code: "K3F9", hook: "h", script: "s" }));
    expect(() => SaveScriptsArgs.parse({ scripts: many })).toThrow();
    expect(SaveScriptsArgs.parse({ scripts: [{ code: "k3f9", hook: "h", script: "s", onScreen: ["a"] }] }).scripts).toHaveLength(1);
  });
  it("script rules are the copy-paste prompt's text, not a fork", () => {
    const rules = scriptWritingRules(style);
    const prompt = buildScriptPrompt({ videos: [{ id: "x", code: "K3F9", title: "T", ymd: "2026-10-21" }], batchNumber: 1, batchCount: 1, style });
    expect(prompt).toContain(rules);
    expect(rules).toContain("[CHECK]");
    expect(rules).toContain("HOW I SOUND");
  });
  it("canonical block reads back through the same parser (header-looking lines can't split it)", () => {
    const raw = canonicalScriptBlock({ ymd: "2026-10-21", title: "A | B", code: "K3F9" }, { hook: "Stop.", script: "Stop.\n### Not a header\nGo.", onScreen: ["one", "two"], cta: "Follow." });
    expect(raw.split("\n")[0]).toBe("### VIDEO 1 | 2026-10-21 | A / B | K3F9");
    expect(raw).not.toContain("### Not");
  });
});

describe("list_videos_needing_scripts / get_video (database)", () => {
  it("date order, batching, offset, includeWithScripts, live style + rules", async () => {
    const tag = uniq();
    // A far-future window of our own so other tests' videos don't interfere.
    const days = ["2031-03-05", "2031-03-01", "2031-03-03", "2031-03-02", "2031-03-04"];
    const items = await plan(days.map((ymd, i) => ({ title: `List ${tag} ${i}`, ymd })));
    const ctx = { tz: TZ, style, voiceSamples: "" };

    const first = await listVideosNeedingScripts(prisma, { batchSize: 2, from: "2031-03-01" }, ctx);
    expect(first.videos.map((v) => v.date)).toEqual(["2031-03-01", "2031-03-02"]);
    expect(first.totalMatching).toBeGreaterThanOrEqual(5);
    expect(first.videos[0]).toMatchObject({ code: videoCode(first.videos[0]!.videoId), hookIdea: expect.stringContaining("Hook for"), notes: "Notes here", hasScript: false });
    expect(first.styleTargets).toMatchObject({ wordsPerMinute: style.wpm, lengthSeconds: { min: style.minSeconds, max: style.maxSeconds }, hookSeconds: style.hookSeconds });
    expect(first.scriptRules).toBe(scriptWritingRules(style, ""));

    const second = await listVideosNeedingScripts(prisma, { batchSize: 2, from: "2031-03-01", offset: 2 }, ctx);
    expect(second.videos.map((v) => v.date)).toEqual(["2031-03-03", "2031-03-04"]);

    // Saving one removes it from the default list; includeWithScripts brings it back flagged.
    const d1 = items[1]!; // 03-01
    await saveConnectorScripts(prisma, { scripts: [{ videoId: d1.id, hook: "First.", script: "First. Then more words." }] }, actor, saveCtx);
    const after = await listVideosNeedingScripts(prisma, { batchSize: 1, from: "2031-03-01" }, ctx);
    expect(after.videos[0]!.date).toBe("2031-03-02");
    const all = await listVideosNeedingScripts(prisma, { batchSize: 1, from: "2031-03-01", includeWithScripts: true }, ctx);
    expect(all.videos[0]).toMatchObject({ videoId: d1.id, hasScript: true, scriptVersions: 1 });

    const got = await getConnectorVideo(prisma, { code: videoCode(d1.id) }, { tz: TZ });
    expect(got.found).toBe(true);
    expect(got.video!.latestScript).toMatchObject({ version: 1, author: "ChatGPT", factChecked: false, text: "First. Then more words." });
    expect((await getConnectorVideo(prisma, { videoId: "nope" }, { tz: TZ })).found).toBe(false);
  });
});

describe("save_scripts (database)", () => {
  it("new IMPORTED version, provenance 'ChatGPT connector', honest walk to SCRIPTED, factual gate still closed", async () => {
    const tag = uniq();
    const [a] = await plan([{ title: `Save ${tag}`, ymd: "2031-04-01" }]);
    const res = await saveConnectorScripts(
      prisma,
      { scripts: [{ code: videoCode(a!.id).toLowerCase(), hook: "You're broke on six figures.", script: "You're broke on six figures. Cards charge over 20% [CHECK]. Fix it.", onScreen: ["six figures", "broke"], cta: "Follow for more." }] },
      actor,
      saveCtx,
    );
    expect(res.saved).toBe(1);
    expect(res.outcomes[0]).toMatchObject({ status: "saved", videoId: a!.id, claimsToCheck: 1 });
    expect(res.summary).toMatch(/^1 saved/);

    const v = await prisma.scriptVersion.findFirstOrThrow({ where: { contentItemId: a!.id } });
    expect(v).toMatchObject({ authorType: "IMPORTED", scriptClaimsGateResult: null, researchPacketId: null, visualBeats: ["six figures", "broke"] });
    expect(v.spokenScript).toBe("You're broke on six figures. Cards charge over 20%. Fix it.\n\nFollow for more.");
    expect(v.revisionNote).toBe("Imported from ChatGPT connector · 1 claim marked [CHECK]");
    expect(isScriptVersionFilmable(v).ok).toBe(false);

    const item = await prisma.contentItem.findUniqueOrThrow({ where: { id: a!.id } });
    expect(item.currentState).toBe("SCRIPTED");
    const ts = await prisma.contentStateTransition.findMany({ where: { contentItemId: a!.id }, orderBy: { createdAt: "asc" } });
    expect(ts.map((t) => t.toState)).toEqual(["SELECTED", "CONTRACTED", "RESEARCHING", "RESEARCHED", "SCRIPTING", "SCRIPTED"]);
    expect(ts.slice(2).every((t) => t.reason === CONNECTOR_REASON)).toBe(true);
    const contract = await prisma.productionContract.findUniqueOrThrow({ where: { contentItemId: a!.id } });
    expect(contract.researchDepth === "NONE" && contract.factualRisk === "LOW").toBe(false);

    const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityId: a!.id, action: "SCRIPT_IMPORTED" } });
    expect(audit.metadata).toMatchObject({ source: "ChatGPT connector", via: "chatgpt-mcp", grantId: "grant-test", checks: ["Cards charge over 20%."] });
  });

  it("idempotent, never overwrites, replace only when asked (keeps the old version)", async () => {
    const tag = uniq();
    const [a] = await plan([{ title: `Replace ${tag}`, ymd: "2031-04-02" }]);
    const item = { videoId: a!.id, hook: "Points aren't free.", script: "Points aren't free. Here's the math." };
    expect((await saveConnectorScripts(prisma, { scripts: [item] }, actor, saveCtx)).outcomes[0]!.status).toBe("saved");
    const tCount = await prisma.contentStateTransition.count({ where: { contentItemId: a!.id } });

    const dup = await saveConnectorScripts(prisma, { scripts: [{ ...item, script: "Points  aren’t free. Here's the math." }] }, actor, saveCtx);
    expect(dup.outcomes[0]!.status).toBe("skipped-duplicate");

    const other = { ...item, script: "Points aren't free. A new take entirely." };
    const ask = await saveConnectorScripts(prisma, { scripts: [other] }, actor, saveCtx);
    expect(ask.outcomes[0]!.status).toBe("needs-confirmation-to-replace");
    expect(ask.outcomes[0]!.message).toMatch(/replace: true/);
    expect(await prisma.scriptVersion.count({ where: { contentItemId: a!.id } })).toBe(1);

    const rep = await saveConnectorScripts(prisma, { scripts: [{ ...other, replace: true }] }, actor, saveCtx);
    expect(rep.outcomes[0]!.status).toBe("saved");
    const versions = await prisma.scriptVersion.findMany({ where: { contentItemId: a!.id }, orderBy: { createdAt: "asc" } });
    expect(versions).toHaveLength(2);
    expect(versions[0]!.spokenScript).toBe("Points aren't free. Here's the math.");
    expect(versions[1]!.revisedFromId).toBe(versions[0]!.id);
    expect(await prisma.contentStateTransition.count({ where: { contentItemId: a!.id } })).toBe(tCount);
  });

  it("unknown, ambiguous, mismatched, duplicate-in-call and filmed videos are reported, the rest still save", async () => {
    const tag = uniq();
    const [filmed, ok] = await plan([
      { title: `Filmed ${tag}`, ymd: "2031-04-03" },
      { title: `Ok ${tag}`, ymd: "2031-04-03" },
    ]);
    await advancePlannedItemToFilmed(prisma, filmed!.id, actor);
    const s = { hook: "Hi.", script: "Hi. Words." };
    const res = await saveConnectorScripts(
      prisma,
      {
        scripts: [
          { videoId: "does-not-exist", ...s },
          { code: "ZZZZ", ...s },
          { videoId: ok!.id, code: videoCode(filmed!.id) === videoCode(ok!.id) ? "AAAA" : videoCode(filmed!.id), ...s },
          { videoId: filmed!.id, ...s },
          { videoId: ok!.id, ...s },
          { videoId: ok!.id, hook: "Again.", script: "Again. Other words." },
        ],
      },
      actor,
      saveCtx,
    );
    expect(res.outcomes.map((o) => o.status)).toEqual(["not-found", "not-found", "ambiguous", "not-allowed", "saved", "ambiguous"]);
    expect(await prisma.scriptVersion.count({ where: { contentItemId: filmed!.id } })).toBe(0);
    expect(await prisma.scriptVersion.count({ where: { contentItemId: ok!.id } })).toBe(1);
  });

  it("rejects a code that points at more than one video", async () => {
    // Force a collision: find two existing targets with the same code, or fabricate via ids is impossible —
    // so test the resolver through get_video with a code shared by construction.
    const tag = uniq();
    const items = await plan(Array.from({ length: 1 }, (_, i) => ({ title: `Code ${tag} ${i}`, ymd: "2031-04-04" })));
    const code = videoCode(items[0]!.id);
    // Same code on a second planned video: a content item whose id maps to the same code.
    const twinId = await findIdWithCode(code);
    const twin = await prisma.contentItem.create({ data: { id: twinId, title: `Twin ${tag}`, currentState: "SELECTED" } });
    await prisma.scheduleEntry.create({ data: { contentItemId: twin.id, scheduledDate: new Date("2031-04-04T17:00:00Z"), targetPlatforms: ["TIKTOK"] } });
    const res = await saveConnectorScripts(prisma, { scripts: [{ code, hook: "Hi.", script: "Hi. Words." }] }, actor, saveCtx);
    expect(res.outcomes[0]!.status).toBe("ambiguous");
    expect(res.outcomes[0]!.message).toMatch(/Save again using videoId/);
    expect(res.saved).toBe(0);
  });
});

/** A fresh id whose 4-character code equals `code` (brute force over random suffixes). */
async function findIdWithCode(code: string): Promise<string> {
  for (let i = 0; i < 2_000_000; i++) {
    const id = `twin${i.toString(36)}${uniq()}`;
    if (videoCode(id) === code) return id;
  }
  throw new Error("no twin found");
}
