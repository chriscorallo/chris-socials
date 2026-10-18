import { describe, expect, it } from "vitest";
import { prisma } from "../prisma";
import { commitPlanImport } from "../plan-import-db";
import { advancePlannedItemToFilmed } from "../footage-first";
import { isScriptVersionFilmable } from "../script-version";
import { addDaysYmd, ymdInTz } from "../tz";
import {
  countVideosNeedingScripts,
  listScriptImportTargets,
  saveImportedScripts,
  SCRIPT_IMPORT_REASON,
} from "../script-import-db";
import { videoCode } from "../script-import";

const TZ = "America/Los_Angeles";
const actor = { actorId: "chris" };
const uniq = () => Math.random().toString(36).slice(2, 8);
const opts = { tz: TZ, plan: null, wpm: 200, targetSeconds: { min: 45, max: 70 } };

async function planVideos(tag: string, titles: string[], ymd: string) {
  const res = await commitPlanImport(
    prisma,
    {
      sourceKind: "TEXT",
      rawInput: `scripts ${tag}`,
      rows: titles.map((title) => ({ title, ymd, time: null, platforms: ["TIKTOK"], hook: `Hook for ${title}`, notes: "Some notes", format: null, pillar: null })),
    },
    actor,
    { tz: TZ, plan: null },
  );
  const items = await prisma.contentItem.findMany({ where: { planImportId: res.importId }, orderBy: { createdAt: "asc" } });
  return titles.map((t) => items.find((i) => i.title === t)!);
}

function block(n: number, ymd: string, title: string, id: string, script: string) {
  return `### VIDEO ${n} | ${ymd} | ${title} | ${videoCode(id)}\nHOOK: ${script.split(".")[0]}.\nSCRIPT:\n${script}\nON-SCREEN: one / two\nCTA: Follow for more.`;
}

describe("saveImportedScripts (database)", () => {
  it("saves a new IMPORTED version with provenance, walks SELECTED → SCRIPTED honestly, keeps the factual gate", async () => {
    const tag = uniq();
    const ymd = addDaysYmd(ymdInTz(new Date(), TZ), 3);
    const [a] = await planVideos(tag, [`Six figures and broke ${tag}`], ymd);
    expect(a!.currentState).toBe("SELECTED");
    const raw = block(1, ymd, a!.title, a!.id, "You make six figures and you're broke. Most cards charge over 20% [CHECK]. Fix the leak.");

    const before = await countVideosNeedingScripts(prisma, { tz: TZ });
    const res = await saveImportedScripts(prisma, { rawPaste: `Here you go!\n\n${raw}\n\nWant more?`, items: [{ rawBlock: raw, contentItemId: a!.id }] }, actor, opts);
    expect(res.saved).toBe(1);
    expect(res.outcomes[0]).toMatchObject({ status: "saved", contentItemId: a!.id });
    expect(await countVideosNeedingScripts(prisma, { tz: TZ })).toBe(before - 1);

    const versions = await prisma.scriptVersion.findMany({ where: { contentItemId: a!.id } });
    expect(versions).toHaveLength(1);
    const v = versions[0]!;
    expect(v).toMatchObject({
      authorType: "IMPORTED",
      revisedFromId: null,
      scriptClaimsGateResult: null,
      researchPacketId: null,
      visualBeats: ["one", "two"],
      targetRuntimeSeconds: 70, // the prompt's length target
      estimatedSpeakingRuntimeSeconds: 5, // 18 words at 200 wpm
    });
    expect(v.spokenScript).toBe("You make six figures and you're broke. Most cards charge over 20%. Fix the leak.\n\nFollow for more.");
    expect(v.revisionNote).toBe("Imported from ChatGPT (pasted by Chris) · 1 claim marked [CHECK]");
    expect(v.beats).toEqual([
      { label: "Hook", text: "You make six figures and you're broke." },
      { label: "CTA", text: "Follow for more." },
    ]);

    // State: SELECTED → CONTRACTED → RESEARCHING → RESEARCHED → SCRIPTING → SCRIPTED, every step recorded.
    const item = await prisma.contentItem.findUniqueOrThrow({ where: { id: a!.id } });
    expect(item.currentState).toBe("SCRIPTED");
    const transitions = await prisma.contentStateTransition.findMany({ where: { contentItemId: a!.id }, orderBy: { createdAt: "asc" } });
    expect(transitions.map((t) => t.toState)).toEqual(["SELECTED", "CONTRACTED", "RESEARCHING", "RESEARCHED", "SCRIPTING", "SCRIPTED"]);
    for (const t of transitions.slice(2)) expect(t).toMatchObject({ actorType: "SYSTEM", reason: SCRIPT_IMPORT_REASON });

    // The factual hard gate stays closed: contract is NOT fact-check-exempt, and the script isn't filmable-checked.
    const contract = await prisma.productionContract.findUniqueOrThrow({ where: { contentItemId: a!.id } });
    expect(contract.researchDepth === "NONE" && contract.factualRisk === "LOW").toBe(false);
    expect(isScriptVersionFilmable(v)).toEqual({ ok: false, reason: "This script came from ChatGPT and hasn't been fact-checked yet." });

    // Provenance: the raw block (with its [CHECK]) lives in the permanent audit log.
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityId: a!.id, action: "SCRIPT_IMPORTED" } });
    expect((audit.metadata as { rawBlock: string; source: string; checks: string[] }).rawBlock).toBe(raw);
    expect((audit.metadata as { source: string }).source).toBe("ChatGPT (pasted by Chris)");
    expect((audit.metadata as { checks: string[] }).checks).toEqual(["Most cards charge over 20%."]);
    const batch = await prisma.auditLog.findFirstOrThrow({ where: { entityId: res.batchId, action: "SCRIPTS_IMPORTED_FROM_CHATGPT" } });
    expect(batch.after).toMatchObject({ saved: 1, items: 1 });

    // Footage can still be uploaded afterwards (SCRIPTED → READY_TO_FILM → FILMED).
    const filmed = await advancePlannedItemToFilmed(prisma, a!.id, actor);
    expect(filmed.item.currentState).toBe("FILMED");
  });

  it("is idempotent: pasting the same answer again creates no new version and no new transitions", async () => {
    const tag = uniq();
    const ymd = addDaysYmd(ymdInTz(new Date(), TZ), 4);
    const [a, b] = await planVideos(tag, [`Roth vs traditional ${tag}`, `Credit points trap ${tag}`], ymd);
    const ra = block(1, ymd, a!.title, a!.id, "Roth or traditional? Wrong question. Ask when you'd rather pay the tax.");
    const rb = block(2, ymd, b!.title, b!.id, "Points feel free. They're not.");
    const input = { rawPaste: `${ra}\n\n${rb}`, items: [{ rawBlock: ra, contentItemId: a!.id }, { rawBlock: rb, contentItemId: b!.id }] };
    expect((await saveImportedScripts(prisma, input, actor, opts)).saved).toBe(2);
    const tCount = await prisma.contentStateTransition.count({ where: { contentItemId: { in: [a!.id, b!.id] } } });

    const again = await saveImportedScripts(prisma, input, actor, opts);
    expect(again.saved).toBe(0);
    expect(again.outcomes.map((o) => o.status)).toEqual(["already-saved", "already-saved"]);
    // Even with Replace on, the same words aren't saved twice (whitespace / quote style ignored).
    const reworded = ra.replace("Wrong question.", "Wrong   question.").replace("you'd", "you’d");
    const third = await saveImportedScripts(prisma, { rawPaste: reworded, items: [{ rawBlock: reworded, contentItemId: a!.id, replace: true }] }, actor, opts);
    expect(third.outcomes[0]!.status).toBe("already-saved");
    expect(await prisma.scriptVersion.count({ where: { contentItemId: { in: [a!.id, b!.id] } } })).toBe(2);
    expect(await prisma.contentStateTransition.count({ where: { contentItemId: { in: [a!.id, b!.id] } } })).toBe(tCount);
  });

  it("never overwrites: an existing script is skipped unless Replace, which adds a new version on top (agent override journaled)", async () => {
    const tag = uniq();
    const ymd = addDaysYmd(ymdInTz(new Date(), TZ), 5);
    const [a] = await planVideos(tag, [`Advisor fees ${tag}`], ymd);
    const agent = await prisma.scriptVersion.create({
      data: { contentItemId: a!.id, spokenScript: "Agent script words.", beats: [], intendedPauses: [], emphasizedWords: [], visualBeats: [], requiredFactualCaveats: [], targetRuntimeSeconds: 45, estimatedSpeakingRuntimeSeconds: 10, followUpIdeas: [], authorType: "AGENT" },
    });
    const raw = block(1, ymd, a!.title, a!.id, "That 1% fee adds up. Ask what you pay in dollars.");

    const skip = await saveImportedScripts(prisma, { rawPaste: raw, items: [{ rawBlock: raw, contentItemId: a!.id }] }, actor, opts);
    expect(skip.outcomes[0]).toMatchObject({ status: "has-script" });
    expect(await prisma.scriptVersion.count({ where: { contentItemId: a!.id } })).toBe(1);

    const rep = await saveImportedScripts(prisma, { rawPaste: raw, items: [{ rawBlock: raw, contentItemId: a!.id, replace: true }] }, actor, opts);
    expect(rep.outcomes[0]).toMatchObject({ status: "saved", message: "Saved as a new version (the old one is kept)." });
    const versions = await prisma.scriptVersion.findMany({ where: { contentItemId: a!.id }, orderBy: { createdAt: "asc" } });
    expect(versions.map((v) => v.authorType)).toEqual(["AGENT", "IMPORTED"]);
    expect(versions[0]!.spokenScript).toBe("Agent script words."); // untouched
    expect(versions[1]!.revisedFromId).toBe(agent.id);
    const journal = await prisma.decisionJournalEntry.findFirst({ where: { selectedDecision: { contains: versions[1]!.id } } });
    expect(journal?.userOverride).toBe(true);

    const targets = await listScriptImportTargets(prisma, { tz: TZ });
    const t = targets.find((x) => x.id === a!.id)!;
    expect(t).toMatchObject({ scriptCount: 2, code: videoCode(a!.id), hook: `Hook for ${a!.title}`, notes: "Some notes" });
    expect(t.latestScript).toMatchObject({ authorType: "IMPORTED" });
  });

  it("refuses filmed videos, reports bad blocks, and one failure doesn't stop the rest", async () => {
    const tag = uniq();
    const ymd = addDaysYmd(ymdInTz(new Date(), TZ), 6);
    const [filmed, ok] = await planVideos(tag, [`Filmed already ${tag}`, `Still planned ${tag}`], ymd);
    await advancePlannedItemToFilmed(prisma, filmed!.id, actor);
    const r1 = block(1, ymd, filmed!.title, filmed!.id, "Words for a filmed video.");
    const r2 = block(2, ymd, ok!.title, ok!.id, "Words for a planned video.");
    const res = await saveImportedScripts(
      prisma,
      {
        rawPaste: "x",
        items: [
          { rawBlock: r1, contentItemId: filmed!.id },
          { rawBlock: "Sorry, I can't do that.", contentItemId: ok!.id },
          { rawBlock: r2, contentItemId: "does-not-exist" },
          { rawBlock: r2, contentItemId: ok!.id },
          { rawBlock: r2, contentItemId: null },
        ],
      },
      actor,
      opts,
    );
    expect(res.outcomes.map((o) => o.status)).toEqual(["not-importable", "failed", "failed", "saved", "failed"]);
    expect(await prisma.scriptVersion.count({ where: { contentItemId: filmed!.id } })).toBe(0);
  });

  it("'Create as a new planned video' goes through plan import (dated, on the calendar) and gets the script", async () => {
    const tag = uniq();
    const ymd = addDaysYmd(ymdInTz(new Date(), TZ), 7);
    const raw = `### VIDEO 9 | ${ymd} | Brand new idea ${tag}\nHOOK: Nobody plans this.\nSCRIPT:\nNobody plans this. Here's why you should.`;
    const res = await saveImportedScripts(prisma, { rawPaste: raw, items: [{ rawBlock: raw, newVideo: { title: `Brand new idea ${tag}`, ymd } }] }, actor, { ...opts, plan: null });
    expect(res.outcomes[0]).toMatchObject({ status: "saved", createdVideo: true });
    const id = res.outcomes[0]!.contentItemId!;
    const item = await prisma.contentItem.findUniqueOrThrow({ where: { id }, include: { scheduleEntry: true, planImport: true } });
    expect(item.currentState).toBe("SCRIPTED");
    expect(item.description).toBe("Hook: Nobody plans this.");
    expect(item.scheduleEntry).not.toBeNull();
    expect(item.planImport?.sourceRef).toBe("Scripts from ChatGPT");
    // Creating it twice (retry) reuses the same video.
    const again = await saveImportedScripts(prisma, { rawPaste: raw, items: [{ rawBlock: raw, newVideo: { title: `Brand new idea ${tag}`, ymd } }] }, actor, opts);
    expect(again.outcomes[0]).toMatchObject({ status: "already-saved", contentItemId: id });
  });
});
