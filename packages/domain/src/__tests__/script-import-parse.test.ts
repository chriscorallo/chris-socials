import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseChatGptScripts, extractChecks, composeSpokenScript, countWords } from "../script-import";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..", "..");
const fixture = (name: string) => readFileSync(join(ROOT, "fixtures", "chatgpt-scripts", name), "utf8");
const today = "2026-10-17";
const parse = (t: string) => parseChatGptScripts(t, { today });

describe("parseChatGptScripts — the exact format the prompt asks for", () => {
  it("reads a clean answer in a code block, ignoring the preamble and the 'continue?' line", () => {
    const { blocks, ignored } = parse(fixture("clean-codeblock.txt"));
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({
      number: 1,
      ymd: "2026-10-19",
      title: "Making six figures and still broke",
      code: "K3F9",
      hook: "You make six figures and you're still broke? That's not an income problem.",
      cta: "Follow for the actual numbers.",
      onScreen: ["$100k+ and broke", "Add up your autopays", "It's the leak, not the latte"],
      checks: [],
      warnings: [],
    });
    // Hook is already the first line → not repeated; CTA wasn't in the script → appended once.
    expect(blocks[0]!.spokenScript.startsWith("You make six figures")).toBe(true);
    expect(blocks[0]!.spokenScript.match(/You make six figures/g)).toHaveLength(1);
    expect(blocks[0]!.spokenScript.endsWith("Follow for the actual numbers.")).toBe(true);
    expect(blocks[0]!.spokenScript).not.toMatch(/```|ON-SCREEN|CTA:|HOOK:|SCRIPT:/);
    expect(blocks[1]).toMatchObject({ number: 2, code: "M4P7", checks: ["A common setup is they match up to 4% of your salary."] });
    expect(blocks[1]!.spokenScript).not.toContain("[CHECK]");
    expect(blocks[1]!.spokenScript).not.toContain("Want me to keep going");
    expect(ignored.join("\n")).toContain("Want me to keep going with the next batch?");
    expect(ignored.join("\n")).toContain("Here are the scripts for batch 1");
    // Provenance: the raw block keeps the header and the [CHECK] markers as pasted.
    expect(blocks[1]!.raw.startsWith("### VIDEO 2 | 2026-10-19 | Your 401(k) match is free money | M4P7")).toBe(true);
    expect(blocks[1]!.raw).toContain("[CHECK]");
  });

  it("re-parsing a block's raw text gives the same script (the server re-reads what the phone sends)", () => {
    for (const f of ["clean-codeblock.txt", "messy-markdown.txt", "loose-headings.txt"]) {
      for (const b of parse(fixture(f)).blocks) {
        const again = parse(b.raw).blocks;
        expect(again).toHaveLength(1);
        expect(again[0]!.spokenScript).toBe(b.spokenScript);
        expect(again[0]!.title).toBe(b.title);
        expect(again[0]!.ymd).toBe(b.ymd);
      }
    }
  });
});

describe("parseChatGptScripts — messy real-world answers", () => {
  it("bold headers with dashes, emoji, smart quotes, timestamps, word counts, separators, sign-off", () => {
    const { blocks, ignored } = parse(fixture("messy-markdown.txt"));
    expect(blocks.map((b) => [b.number, b.ymd, b.title])).toEqual([
      [3, "2026-10-21", "Making Six Figures & Still Broke 💸"],
      [4, "2026-10-21", "Stop paying 1% advisor fees"],
      [9, "2026-10-22", "Why your credit score is a game"],
    ]);
    const [a, b, c] = blocks;
    expect(a!.hook).toBe("You make six figures and you’re still broke?");
    expect(a!.spokenScript).not.toMatch(/\(0–3s\)|\*\*|Word count|On-screen/);
    expect(a!.onScreen).toEqual(["Six figures ≠ rich", "Add up your autopays"]);
    expect(a!.checks).toEqual(["The average American has around 4.5 subscriptions they forgot about."]);
    expect(b!.checks[0]).toMatch(/\(depends on balance and returns\)$/);
    expect(b!.cta).toBe('Send this to the friend who "has a guy."');
    expect(c!.cta).toBeNull();
    expect(c!.spokenScript).not.toContain("Let me know");
    expect(c!.spokenScript.trim().endsWith("Play it on purpose.")).toBe(true);
    expect(ignored.some((t) => t.includes("Let me know if you want me to tweak"))).toBe(true);
  });

  it("markdown headings with no VIDEO keyword, date in parentheses, script with no SCRIPT label", () => {
    const { blocks } = parse(fixture("loose-headings.txt"));
    expect(blocks.map((b) => [b.number, b.ymd, b.title])).toEqual([
      [1, "2026-10-23", "The emergency fund nobody talks about"],
      [2, "2026-10-23", "Rent vs buy, the honest version"],
    ]);
    expect(blocks[0]!.hook).toBe("Your emergency fund isn't for emergencies. It's for options.");
    expect(blocks[0]!.spokenScript).toMatch(/^Your emergency fund isn't for emergencies\. It's for options\.\n\nWhen you have three months/);
    expect(blocks[1]!.spokenScript).not.toContain("Should I do the remaining");
  });

  it("missing optional parts, no code, numbering that restarts, extra blank lines, CRLF + NBSP", () => {
    const text = [
      "### VIDEO 1 | 2026-10-24 | Roth vs traditional",
      "HOOK: Roth or traditional? Wrong question.",
      "SCRIPT:",
      "",
      "",
      "Roth or traditional? Wrong question.  The real question is when you'd rather pay the tax.",
      "",
      "",
      "",
      "### VIDEO 1 | 2026-10-24 | Credit card points are a trap",
      "SCRIPT:",
      "Points feel free. They're not.",
    ].join("\r\n");
    const { blocks } = parse(text);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ code: null, onScreen: [], cta: null, number: 1 });
    expect(blocks[0]!.spokenScript).toBe("Roth or traditional? Wrong question. The real question is when you'd rather pay the tax.");
    expect(blocks[1]).toMatchObject({ number: 1, hook: null, spokenScript: "Points feel free. They're not." });
  });

  it("variants of the header: no number with pipes, code in brackets, 'Code:' prefix, weekday dates, 'Today'", () => {
    const text = `VIDEO | Oct 25 | Why I don't budget [K2B3]
SCRIPT:
I don't budget. I automate.

**Video 12: Your car is a liability (Mon 10/26)** — Code: Z9Y8
Hook: Your car is costing you more than you think.
Script: Your car is costing you more than you think. Insurance, gas, repairs.

# VIDEO 13 - Today - The 50/30/20 rule is broken
HOOK: The 50/30/20 rule was made for a different economy.
SCRIPT:
The 50/30/20 rule was made for a different economy.`;
    const { blocks } = parse(text);
    expect(blocks.map((b) => [b.number, b.ymd, b.title, b.code])).toEqual([
      [null, "2026-10-25", "Why I don't budget", "K2B3"],
      [12, "2026-10-26", "Your car is a liability", "Z9Y8"],
      [13, "2026-10-17", "The 50/30/20 rule is broken", null],
    ]);
    expect(blocks[1]!.spokenScript).toBe("Your car is costing you more than you think. Insurance, gas, repairs.");
  });

  it("date / title / code on their own lines inside the block", () => {
    const text = `## Video 5
Title: The tax refund myth
Date: 2026-10-27
Code: Q7W3
Hook: Your tax refund isn't a bonus.
Script:
Your tax refund isn't a bonus. It's your own money, returned late, with zero interest.`;
    const [b] = parse(text).blocks;
    expect(b).toMatchObject({ number: 5, title: "The tax refund myth", ymd: "2026-10-27", code: "Q7W3" });
  });

  it("hook that isn't in the script is put first; label styles: **Hook:**, Hook —, > quotes, bullets", () => {
    const text = `### VIDEO 2 | 2026-10-20 | HYSA explained
- **Hook:** Your savings account is losing you money.
> **SCRIPT:**
> A high-yield savings account pays you more for the exact same thing.
> Same safety, same access. Different rate.
- **CTA** — Check what yours pays.`;
    const [b] = parse(text).blocks;
    expect(b!.spokenScript).toBe(
      "Your savings account is losing you money.\n\nA high-yield savings account pays you more for the exact same thing.\nSame safety, same access. Different rate.\n\nCheck what yours pays.",
    );
  });

  it("stage directions are dropped; [CHECK] in the hook counts; a normal '(check …)' phrase isn't a marker", () => {
    const text = `### VIDEO 1 | 2026-10-20 | Fees
HOOK: Most funds charge under 0.1% [check].
SCRIPT:
Most funds charge under 0.1%. [pause] Go check your statement (check the expense ratio line). [B-roll: statement]`;
    const [b] = parse(text).blocks;
    expect(b!.checks).toEqual(["Most funds charge under 0.1%."]);
    expect(b!.spokenScript).toBe("Most funds charge under 0.1%. Go check your statement (check the expense ratio line).");
  });

  it("returns nothing for text that has no scripts (a plan, a refusal, an empty paste)", () => {
    expect(parse("").blocks).toEqual([]);
    expect(parse("Sorry, I can't help with that.").blocks).toEqual([]);
    expect(parse("Mon 10/20 — 5 money myths — TikTok\nTue — Why I stopped budgeting").blocks).toEqual([]);
    // "Video games…" / "Script:" lines inside prose are not headers.
    expect(parse("Video games are expensive.\nScript: none yet").blocks).toEqual([]);
  });

  it("a script line that happens to start with 'Video'/'Script' or contain a colon stays in the script", () => {
    const text = `### VIDEO 7 | 2026-10-28 | Gaming budget
SCRIPT:
Video games are a hobby, not a personality.
Video 2 of this series is about rent.
Script 3. Words.
Here's the rule: fun money is planned money.`;
    const [b] = parse(text).blocks;
    expect(b!.spokenScript).toBe("Video games are a hobby, not a personality.\nVideo 2 of this series is about rent.\nScript 3. Words.\nHere's the rule: fun money is planned money.");
    expect(parse(text).blocks).toHaveLength(1);
  });

  it("never drops a one-paragraph script that sounds like a question or starts with 'Words'", () => {
    expect(parse(`### VIDEO 1 | 2026-10-20 | Q\nSCRIPT:\nWords here.`).blocks[0]!.spokenScript).toBe("Words here.");
    expect(parse(`### VIDEO 1 | 2026-10-20 | Q\nSCRIPT:\nWant me to tell you why your rent is too high?`).blocks[0]!.spokenScript).toBe(
      "Want me to tell you why your rent is too high?",
    );
  });
});

describe("helpers", () => {
  it("extractChecks keeps decimals and 401(k) together and removes every marker", () => {
    const r = extractChecks("Your 401(k) limit went up [CHECK]. Rates are 4.5% right now [CHECK: Oct 2026]. Cool.");
    expect(r.checks).toEqual(["Your 401(k) limit went up.", "Rates are 4.5% right now. (Oct 2026)"]);
    expect(r.text).toBe("Your 401(k) limit went up. Rates are 4.5% right now. Cool.");
  });

  it("composeSpokenScript adds a missing hook/CTA once, tolerating light rewording", () => {
    expect(composeSpokenScript({ hook: "Stop paying 1% fees.", script: "Stop paying 1% in fees! Here's why.", cta: "Follow for more." })).toBe(
      "Stop paying 1% in fees! Here's why.\n\nFollow for more.",
    );
    expect(composeSpokenScript({ hook: "A", script: "", cta: null })).toBe("A");
  });

  it("countWords ignores stray punctuation", () => {
    expect(countWords("One, two — three... $100 4%!")).toBe(5);
  });
});
