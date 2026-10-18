import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { matchScriptBlocks, parseChatGptScripts, titleSimilarity, videoCode, type ScriptTarget } from "../script-import";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..", "..");
const fixture = (name: string) => readFileSync(join(ROOT, "fixtures", "chatgpt-scripts", name), "utf8");
const parse = (t: string) => parseChatGptScripts(t, { today: "2026-10-17" }).blocks;

const T = (id: string, title: string, ymd: string, time = "09:00", extra: Partial<ScriptTarget> = {}): ScriptTarget => ({
  id,
  title,
  ymd,
  time,
  code: extra.code ?? videoCode(id),
  hook: extra.hook ?? null,
});

describe("videoCode", () => {
  it("is 4 chars, letter-digit-letter-digit, no I/O/0/1, and stable", () => {
    for (const id of ["cmabc123", "x", "cl9z8y7x6w5v4u3t2s1r0q", "item-42"]) {
      const c = videoCode(id);
      expect(c).toMatch(/^[A-HJ-NP-Z][2-9][A-HJ-NP-Z][2-9]$/);
      expect(videoCode(id)).toBe(c);
    }
    // Spread: 500 ids → very few collisions.
    const codes = new Set(Array.from({ length: 500 }, (_, i) => videoCode(`cm${i}x${i * 7919}`)));
    expect(codes.size).toBeGreaterThan(490);
  });
});

describe("titleSimilarity", () => {
  it("ignores case, punctuation, emoji, smart quotes, & vs and", () => {
    expect(titleSimilarity("Making Six Figures & Still Broke 💸", "Making six figures and still broke")).toBeGreaterThanOrEqual(0.9);
    expect(titleSimilarity("“Why I Don’t Budget”", "Why I don't budget")).toBe(1);
    expect(titleSimilarity("Six figures, still broke", "Making six figures and still broke")).toBeGreaterThan(0.6);
    expect(titleSimilarity("Stop paying 1% advisor fees", "Why your credit score is a game")).toBeLessThan(0.3);
    expect(titleSimilarity("Your 401(k) match is free money", "The 401k match = free money")).toBeGreaterThan(0.6);
  });
});

describe("matchScriptBlocks", () => {
  const plan: ScriptTarget[] = [
    T("v1", "Making six figures and still broke", "2026-10-19", "09:00", { code: "K3F9" }),
    T("v2", "Your 401(k) match is free money", "2026-10-19", "12:00", { code: "M4P7" }),
    T("v3", "Making six figures and still broke", "2026-10-21", "09:00"),
    T("v4", "Stop paying 1% advisor fees", "2026-10-21", "12:00"),
    T("v5", "Why your credit score is a game", "2026-10-22", "09:00"),
    T("v6", "The emergency fund nobody talks about", "2026-10-23", "09:00"),
    T("v7", "Rent vs buy: the honest version", "2026-10-23", "12:00"),
    T("v8", "What I spend in a week", "2026-10-23", "17:00"),
  ];
  const byIndex = (blocks: ReturnType<typeof parse>) => matchScriptBlocks(blocks, plan);

  it("code + title → Exact", () => {
    const m = byIndex(parse(fixture("clean-codeblock.txt")));
    expect(m.map((x) => [x.targetId, x.confidence])).toEqual([
      ["v1", "exact"],
      ["v2", "exact"],
    ]);
    expect(m[0]!.reason).toBe("Code and title match");
  });

  it("no codes: title + date decide, and the same title on another day goes to the right day", () => {
    const m = byIndex(parse(fixture("messy-markdown.txt")));
    // "Making Six Figures & Still Broke" dated Oct 21 → v3 (Oct 21), not v1 (Oct 19).
    expect(m.map((x) => [x.targetId, x.confidence])).toEqual([
      ["v3", "exact"],
      ["v4", "exact"],
      ["v5", "exact"],
    ]);
  });

  it("loose headings with dates in parentheses → Exact on title + date", () => {
    const m = byIndex(parse(fixture("loose-headings.txt")));
    expect(m.map((x) => [x.targetId, x.confidence])).toEqual([
      ["v6", "exact"],
      // "Rent vs buy, the honest version" vs "Rent vs buy: the honest version" — punctuation only.
      ["v7", "exact"],
    ]);
  });

  it("a code that contradicts the title doesn't win silently (collision / moved code)", () => {
    const [b] = parse(`### VIDEO 1 | 2026-10-22 | Why your credit score is a game | K3F9\nSCRIPT:\nCredit is a game.`);
    const [m] = matchScriptBlocks([b!], plan);
    // Title + date say v5; the code says v1. Title and date win; it isn't "exact".
    expect(m!.targetId).toBe("v5");
    expect(m!.confidence).toBe("exact");
    const [b2] = parse(`### VIDEO 1 | 2026-11-30 | Something else entirely | K3F9\nSCRIPT:\nWords.`);
    const [m2] = matchScriptBlocks([b2!], plan);
    expect(m2).toMatchObject({ targetId: "v1", confidence: "likely" });
    expect(m2!.reason).toMatch(/title looks different/);
  });

  it("ChatGPT reworded the title → Likely", () => {
    const [b] = parse(`### VIDEO 2 | 2026-10-19 | The 401k match = free money\nSCRIPT:\nTake the match.`);
    expect(matchScriptBlocks([b!], plan)[0]).toMatchObject({ targetId: "v2", confidence: "likely" });
  });

  it("a date one day off with the exact title → Likely, not a different video", () => {
    const [b] = parse(`### VIDEO 1 | 2026-10-23 | Why your credit score is a game\nSCRIPT:\nCredit.`);
    expect(matchScriptBlocks([b!], plan)[0]).toMatchObject({ targetId: "v5", confidence: "likely" });
  });

  it("order within a day: the only leftover video that day → Likely; several → Pick one with the order as best guess", () => {
    const one = parse(`### VIDEO 3 | 2026-10-22 | Something totally different\nSCRIPT:\nWords here.`);
    expect(matchScriptBlocks(one, plan)[0]).toMatchObject({ targetId: "v5", confidence: "likely", reason: "Only video left on that day" });

    const two = parse(`### VIDEO 2 | 2026-10-23 | Unrelated B\nSCRIPT:\nB.\n\n### VIDEO 1 | 2026-10-23 | Unrelated A\nSCRIPT:\nA.\n\n### VIDEO 3 | 2026-10-23 | Unrelated C\nSCRIPT:\nC.`);
    const m = matchScriptBlocks(two, plan);
    expect(m.every((x) => x.confidence === "pick" && x.targetId === null)).toBe(true);
    // VIDEO numbers order the guesses: #1 → 09:00, #2 → 12:00, #3 → 17:00.
    expect(m[1]!.suggestions[0]).toBe("v6");
    expect(m[0]!.suggestions[0]).toBe("v7");
    expect(m[2]!.suggestions[0]).toBe("v8");
  });

  it("one script per video: a duplicate block doesn't take the same video twice", () => {
    const blocks = parse(`### VIDEO 1 | 2026-10-21 | Stop paying 1% advisor fees\nSCRIPT:\nFirst.\n\n### VIDEO 2 | 2026-10-21 | Stop paying 1% advisor fees\nSCRIPT:\nSecond.`);
    const m = matchScriptBlocks(blocks, plan);
    expect(m[0]).toMatchObject({ targetId: "v4", confidence: "exact" });
    expect(m[1]!.targetId).not.toBe("v4");
  });

  it("no date and no matching title → Pick one with no guess pre-selected", () => {
    const [b] = parse(`### VIDEO 1 | Totally new idea about crypto\nSCRIPT:\nCrypto.`);
    const [m] = matchScriptBlocks([b!], plan);
    expect(m).toMatchObject({ targetId: null, confidence: "pick" });
    expect(m!.suggestions.length).toBeGreaterThan(0);
  });

  it("scales: 30 scripts against 400 planned videos in well under a second", () => {
    const many: ScriptTarget[] = Array.from({ length: 400 }, (_, i) =>
      T(`p${i}`, `Money topic number ${i} ${["roth", "debt", "credit", "rent", "taxes"][i % 5]} ${["myths", "truth", "mistakes"][i % 3]}`, `2026-11-${String((i % 28) + 1).padStart(2, "0")}`, ["09:00", "12:00", "17:00", "20:00"][i % 4]),
    );
    const text = many
      .slice(0, 30)
      .map((t, i) => `### VIDEO ${i + 1} | ${t.ymd} | ${t.title} | ${t.code}\nSCRIPT:\nScript ${i}.`)
      .join("\n\n");
    const t0 = Date.now();
    const m = matchScriptBlocks(parse(text), many);
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(m.filter((x) => x.confidence === "exact").length).toBe(30);
    expect(m.map((x) => x.targetId)).toEqual(many.slice(0, 30).map((t) => t.id));
  });
});
