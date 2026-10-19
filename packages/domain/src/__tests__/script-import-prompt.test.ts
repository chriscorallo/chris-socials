import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BRAND_GUIDANCE,
  PLAYBOOK_GUIDANCE,
  batchVideos,
  buildScriptPrompt,
  estimateSecondsAt,
  matchScriptBlocks,
  ownPaceWpm,
  parseChatGptScripts,
  scriptStyleFrom,
  videoCode,
  type PromptVideo,
} from "../script-import";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..", "..");
const brand = (f: string) => readFileSync(join(ROOT, "brand", f), "utf8");

const videos: PromptVideo[] = Array.from({ length: 47 }, (_, i) => {
  const id = `cmvid${i}`;
  return {
    id,
    code: videoCode(id),
    title: `Video title number ${i + 1}`,
    ymd: `2026-10-${String(19 + Math.floor(i / 4)).padStart(2, "0")}`,
    hook: i % 2 ? `Hook idea ${i + 1}` : null,
    notes: i % 3 ? `Note line one\nNote line two ${"x".repeat(i * 10)}` : null,
  };
});

describe("scriptStyleFrom (live reference numbers → prompt targets)", () => {
  it("defaults to ~200 wpm, 45–70 s, 3 s hook when there are no measured references", () => {
    expect(scriptStyleFrom(null)).toEqual({ wpm: 200, minSeconds: 45, maxSeconds: 70, minWords: 150, maxWords: 230, hookSeconds: 3, source: "default", sampleSize: 0 });
  });

  it("uses the references' median wpm, middle-half length and hook length", () => {
    const s = scriptStyleFrom({
      sampleSize: 12,
      wpm: { value: 212.4, n: 12, p25: 190, p75: 230 },
      durationS: { value: 61, n: 12, p25: 48.2, p75: 72.9 },
      hookDurationS: { value: 2.2, n: 12, p25: 1.5, p75: 3 },
    });
    expect(s).toMatchObject({ wpm: 212, minSeconds: 50, maxSeconds: 75, hookSeconds: 2, source: "references", sampleSize: 12 });
    expect(s.minWords).toBe(180); // 50 s × 212 wpm ≈ 177 → 180
    expect(s.maxWords).toBe(270);
  });

  it("ignores impossible numbers (a broken measurement must not ask for 40 wpm)", () => {
    const s = scriptStyleFrom({ sampleSize: 3, wpm: { value: 40, n: 3, p25: 30, p75: 50 }, durationS: null, hookDurationS: { value: 30, n: 3, p25: 1, p75: 40 } });
    expect(s).toMatchObject({ wpm: 200, minSeconds: 45, maxSeconds: 70, hookSeconds: 3 });
  });

  it("own pace needs at least 3 measured takes", () => {
    expect(ownPaceWpm({ takes: 2, wpm: { value: 190, n: 2, p25: 1, p75: 1 } })).toBeNull();
    expect(ownPaceWpm({ takes: 5, wpm: { value: 188.6, n: 5, p25: 1, p75: 1 } })).toBe(189);
    expect(estimateSecondsAt(200, 200)).toBe(60);
    expect(estimateSecondsAt(150, 200)).toBe(45);
  });
});

describe("buildScriptPrompt", () => {
  const style = scriptStyleFrom({ sampleSize: 9, wpm: { value: 205, n: 9, p25: 1, p75: 1 }, durationS: { value: 60, n: 9, p25: 45, p75: 70 }, hookDurationS: { value: 2.6, n: 9, p25: 1, p75: 1 } });
  const batches = batchVideos(videos, 15);

  it("batches 47 videos into 15 + 15 + 15 + 2", () => {
    expect(batches.map((b) => b.length)).toEqual([15, 15, 15, 2]);
    expect(batchVideos(videos, 10)).toHaveLength(5);
    expect(batchVideos([], 15)).toEqual([]);
  });

  const prompt = buildScriptPrompt({ videos: batches[1]!, batchNumber: 2, batchCount: batches.length, style });

  it("works in the planning chat and standalone, and says which batch it is", () => {
    expect(prompt).toMatch(/^Write the scripts for 15 of my short-form videos \(batch 2 of 4\)\./);
    expect(prompt).toContain("If we planned these videos together earlier in this chat, use what we talked about.");
    // Every video in the batch is embedded with its date, code, hook and notes.
    for (const v of batches[1]!) {
      expect(prompt).toContain(v.title);
      expect(prompt).toContain(`Date: ${v.ymd}`);
      expect(prompt).toContain(`Code: ${v.code}`);
      if (v.hook) expect(prompt).toContain(`Hook idea: ${v.hook}`);
    }
    expect(prompt).not.toContain(batches[0]![0]!.title + "\n");
    expect(prompt).toContain("Note line one / Note line two"); // multi-line notes flattened
  });

  it("embeds the Content Intelligence playbook and asks for the BRIEF (the same craft rules the in-app Script Agent gets)", () => {
    expect(prompt).toContain(PLAYBOOK_GUIDANCE);
    expect(prompt).toContain("BRIEF: one JSON object on one line");
    const playbook = readFileSync(join(ROOT, "prompts", "shared", "CONTENT_INTELLIGENCE.md"), "utf8").toLowerCase().replace(/\s+/g, " ");
    for (const phrase of ["impossible_choice", "absurd_investigation", "before_after", "pick_your_poison", "cost_of_being_alive", "the viewer should feel rewarded, not tricked", "correlation is not causation"]) {
      expect(playbook, phrase).toContain(phrase);
      expect(PLAYBOOK_GUIDANCE.toLowerCase(), phrase).toContain(phrase);
    }
  });

  it("embeds the brand voice, the reference numbers and the [CHECK] rule", () => {
    expect(prompt).toContain(BRAND_GUIDANCE);
    expect(prompt).toContain("about 205 words a minute");
    expect(prompt).toContain("45–70 seconds, which is about 150–240 spoken words");
    expect(prompt).toContain("Hook in the first ~3 seconds");
    expect(prompt).toContain("[CHECK]");
    expect(prompt).toMatch(/Only claims I can stand behind/);
  });

  it("asks for the exact block format the parser reads — and the parser reads ChatGPT following it", () => {
    const first = batches[1]![0]!;
    expect(prompt).toContain(`### VIDEO 1 | ${first.ymd} | ${first.title} | ${first.code}`);
    expect(prompt).toMatch(/HOOK: .*\nSCRIPT:\n.*\nON-SCREEN: .*\nCTA: /);
    expect(prompt).toContain("ONE code block");
    expect(prompt).toContain("don't ask if you should continue");
    // Simulate a compliant answer for the batch and round-trip it.
    const answer =
      "```\n" +
      batches[1]!.map((v, i) => `### VIDEO ${i + 1} | ${v.ymd} | ${v.title} | ${v.code}\nHOOK: Hook ${i}.\nSCRIPT:\nHook ${i}. Body of script ${i}.\nCTA: Bye ${i}.`).join("\n\n") +
      "\n```";
    const blocks = parseChatGptScripts(answer, { today: "2026-10-17" }).blocks;
    expect(blocks).toHaveLength(15);
    const m = matchScriptBlocks(
      blocks,
      videos.map((v) => ({ id: v.id, title: v.title, ymd: v.ymd, code: v.code, hook: v.hook ?? null })),
    );
    expect(m.map((x) => x.targetId)).toEqual(batches[1]!.map((v) => v.id));
    expect(m.every((x) => x.confidence === "exact")).toBe(true);
  });

  it("stays a sane length even for 30 videos with long notes, and truncates very long notes", () => {
    const long = videos.map((v) => ({ ...v, notes: "n".repeat(2000), hook: "h".repeat(800) }));
    const p = buildScriptPrompt({ videos: long.slice(0, 30), batchNumber: 1, batchCount: 2, style });
    expect(p.length).toBeLessThan(28_000); // brand + playbook + BRIEF shape are constant (~6k); the videos are the variable part
    expect(p).not.toContain("n".repeat(400));
    expect(buildScriptPrompt({ videos: videos.slice(0, 15), batchNumber: 1, batchCount: 4, style }).length).toBeLessThan(12_000);
  });

  it("includes voice samples only when Chris has written some (capped)", () => {
    expect(prompt).not.toContain("HOW I ACTUALLY TALK");
    const withSamples = buildScriptPrompt({ videos: batches[0]!, batchNumber: 1, batchCount: 4, style, voiceSamples: "### Sample\nLook, here's the thing. " + "word ".repeat(2000) });
    expect(withSamples).toContain("HOW I ACTUALLY TALK");
    expect(withSamples).toContain("Look, here's the thing.");
    expect(withSamples.length).toBeLessThan(buildScriptPrompt({ videos: batches[0]!, batchNumber: 1, batchCount: 4, style }).length + 2700);
  });

  it("a single batch doesn't say 'batch 1 of 1'", () => {
    expect(buildScriptPrompt({ videos: videos.slice(0, 3), batchNumber: 1, batchCount: 1, style })).toMatch(/^Write the scripts for 3 of my short-form videos\. /);
  });
});

describe("BRAND_GUIDANCE stays faithful to /brand (human-owned files are never edited from code)", () => {
  it("every quoted phrase still exists in BRAND_CONSTITUTION.md / CHRIS_BRAIN.md", () => {
    const constitution = brand("BRAND_CONSTITUTION.md");
    const brain = brand("CHRIS_BRAIN.md");
    const both = `${constitution}\n${brain}`.toLowerCase().replace(/\s+/g, " ");
    const phrases = [
      "entertainment that happens to teach people about money",
      "i investigate ridiculous questions about money and life, do the",
      "finance is the tool used to answer an interesting question",
      "ambitious people in their twenties and thirties",
      "pick your poison",
      "i did the math",
      "the financial butterfly effect",
      "how broke is this character?",
      "money makes no sense",
      "the cost of being alive",
      "explaining something surprising to a friend",
      "intelligent without sounding academic",
      "confident without pretending certainty",
      "honest about assumptions and uncertainty",
      "what else could that money have done?",
      "motivational clichés",
      "unlock your financial future",
      "game changer",
      "forced gen z slang",
      "fake excitement",
      "but here's the crazy part",
      "predictable \"like, comment and follow\" endings",
      "hey guys, welcome back",
      "obviously ai-written copy",
      "never mocking people for poverty, debt, disability",
    ];
    for (const p of phrases) expect(both, p).toContain(p);
    const summaryOnly = new Set(["never mocking people for poverty, debt, disability", "i investigate ridiculous questions about money and life, do the"]);
    for (const p of phrases.filter((x) => !summaryOnly.has(x))) expect(BRAND_GUIDANCE.toLowerCase(), p).toContain(p.replace(/\n/g, " "));
  });
});
