import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  activeBranch,
  buildPlanContextText,
  chatGptShareId,
  decodeTurboStream,
  extractConversationFromShareHtml,
  extractContentText,
  extractJsonFromChatHtml,
  findHighlights,
  findPlanCandidates,
  isConversationsEntry,
  listZipEntries,
  parseConversationsJson,
  parseConversationsJsonText,
  parsePastedConversation,
  parsePlanSegments,
  randomAccessFromBytes,
  readZipEntry,
  shareServerError,
  stripChatProse,
  summarizeConversation,
  type PlanContextMessage,
} from "../plan-context";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const exportJson = readFileSync(join(ROOT, "fixtures", "chatgpt-export", "conversations.json"), "utf8");
const ctx = { today: "2026-10-17", enabledPlatforms: ["TIKTOK", "INSTAGRAM", "YOUTUBE"] as ("TIKTOK" | "INSTAGRAM" | "YOUTUBE")[] };

function planConversation() {
  return parseConversationsJsonText(exportJson).find((c) => c.conversationId === "conv-plan-0001")!;
}

describe("ChatGPT export: conversations.json", () => {
  it("lists conversations with messages, newest first, skipping empty ones", () => {
    const convs = parseConversationsJsonText(exportJson);
    expect(convs.map((c) => c.title)).toEqual(["120-video plan + business model", "Dinner ideas", "Untitled chat"]);
    const s = summarizeConversation(convs[0]!, 0);
    expect(s.messageCount).toBe(6);
    expect(s.preview).toMatch(/^Here's my current profile screenshot/);
    expect(s.updatedAt).toBe(new Date(1760700000 * 1000).toISOString());
  });

  it("walks current_node → root: edited/regenerated branches, hidden, tool and reasoning messages are left out", () => {
    const c = planConversation();
    const all = c.messages.map((m) => m.text).join("\n");
    expect(c.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant", "user", "assistant"]);
    for (const gone of ["ORIGINAL DRAFT QUESTION", "ABANDONED BRANCH", "REGENERATED AWAY", "SECRET CUSTOM INSTRUCTIONS", "HIDDEN REASONING", "PYTHON TOOL CALL", "TOOL OUTPUT"]) {
      expect(all).not.toContain(gone);
    }
    expect(c.notes.join(" ")).toMatch(/3 older versions of edited or regenerated messages/);
    expect(c.notes.join(" ")).toMatch(/1 image left out/);
    // Timestamps kept (unix seconds → ISO).
    expect(c.messages[0]!.at).toBe(new Date(1760500100 * 1000).toISOString());
    // Consecutive assistant parts read as one reply.
    expect(c.messages[3]!.text).toContain("(Times default to your 4 daily slots.)");
    // Citation tokens stripped.
    expect(c.messages[1]!.text).not.toMatch(/[\ue200-\ue2ff]|turn0search/);
  });

  it("missing current_node/fields: follows the newest child; non-string parts ignored", () => {
    const c = parseConversationsJsonText(exportJson).find((x) => x.title === "Untitled chat")!;
    expect(c.messages).toEqual([
      { role: "user", text: "Old chat with missing fields and no current_node", at: null },
      { role: "assistant", text: "Reply without metadata or recipient", at: new Date(1758000100 * 1000).toISOString() },
    ]);
    expect(c.conversationId).toBeNull();
  });

  it("activeBranch picks the newest child when current_node is unknown", () => {
    const mapping = new Map([
      ["r", { id: "r", parent: null, children: ["a", "b"], message: null }],
      ["a", { id: "a", parent: "r", children: [], message: { create_time: 1 } }],
      ["b", { id: "b", parent: "r", children: [], message: { create_time: 2 } }],
    ]);
    expect(activeBranch(mapping, "nope")).toEqual(["r", "b"]);
    expect(activeBranch(mapping, "a")).toEqual(["r", "a"]);
  });

  it("multimodal parts: text and audio transcripts kept, images counted, assets dropped", () => {
    const got = extractContentText({
      content_type: "multimodal_text",
      parts: [{ content_type: "image_asset_pointer", asset_pointer: "x" }, { content_type: "audio_transcription", text: "spoken words" }, { content_type: "audio_asset_pointer" }, "typed words"],
    });
    expect(got).toEqual({ text: "spoken words\n\ntyped words", images: 1 });
    expect(extractContentText({ content_type: "thoughts", thoughts: [] })).toBeNull();
    expect(extractContentText({ content_type: "code", language: "python", text: "x = 1" })!.text).toBe("```python\nx = 1\n```");
  });

  it("bad JSON → plain error; split files and folders recognized", () => {
    expect(() => parseConversationsJsonText("not json")).toThrow(/isn't ChatGPT's conversations.json/);
    expect(isConversationsEntry("conversations.json")).toBe(true);
    expect(isConversationsEntry("personal/conversations/conversations-001.json")).toBe(true);
    expect(isConversationsEntry("shared_conversations.json")).toBe(false);
    expect(isConversationsEntry("__MACOSX/._conversations.json")).toBe(false);
  });

  it("chat.html's embedded jsonData parses the same", () => {
    const html = `<!DOCTYPE html><html><body><div id="root"></div><script>\nvar jsonData = ${exportJson.trim()};\nfunction render(){ /* ]; } */ }\n</script></body></html>`;
    const data = extractJsonFromChatHtml(html);
    expect(parseConversationsJson(data).map((c) => c.title)).toEqual(parseConversationsJsonText(exportJson).map((c) => c.title));
    expect(extractJsonFromChatHtml("<html>nothing</html>")).toBeNull();
  });
});

/** Tiny ZIP writer for tests (stored + deflate), matching what ChatGPT's export produces. */
function makeZip(files: { name: string; data: Uint8Array; deflate: boolean }[]): Uint8Array {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name);
    const body = f.deflate ? deflateRawSync(f.data) : Buffer.from(f.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(f.deflate ? 8 : 0, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    chunks.push(local, name, body);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(f.deflate ? 8 : 0, 10);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(f.data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);
    offset += 30 + name.length + body.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...chunks, cdBuf, eocd]));
}

describe("ChatGPT export: reading the .zip without touching the media", () => {
  it("finds conversations.json in the central directory and inflates only it", async () => {
    const big = new Uint8Array(2_000_000).fill(7); // a "photo"
    const zip = makeZip([
      { name: "file-AbC123-IMG_0042.png", data: big, deflate: false },
      { name: "chat.html", data: Buffer.from("<html></html>"), deflate: true },
      { name: "conversations.json", data: Buffer.from(exportJson), deflate: true },
      { name: "user.json", data: Buffer.from("{}"), deflate: true },
    ]);
    const reads: [number, number][] = [];
    const base = randomAccessFromBytes(zip);
    const file = { size: base.size, read: (s: number, e: number) => (reads.push([s, e]), base.read(s, e)) };
    const entries = await listZipEntries(file);
    expect(entries.map((e) => e.name)).toEqual(["file-AbC123-IMG_0042.png", "chat.html", "conversations.json", "user.json"]);
    const conv = entries.find((e) => isConversationsEntry(e.name))!;
    const bytes = await readZipEntry(file, conv, (d) => new Uint8Array(inflateRawSync(d)));
    expect(parseConversationsJsonText(new TextDecoder().decode(bytes))).toHaveLength(3);
    // Never read the 2 MB image.
    const bytesRead = reads.reduce((s, [a, b]) => s + (b - a), 0);
    expect(bytesRead).toBeLessThan(200_000);
  });

  it("not a zip → plain error", async () => {
    await expect(listZipEntries(randomAccessFromBytes(new TextEncoder().encode("hello")))).rejects.toThrow(/doesn't look like a .zip/);
  });
});

describe("Paste: “select all in the chat and paste”", () => {
  it("splits on ChatGPT's hidden “You said:” / “ChatGPT said:” labels and drops UI noise", () => {
    const paste = [
      "You said:",
      "Help me plan 120 videos.",
      "ChatGPT said:",
      "Thought for 12s",
      "## Posting Cadence",
      "4 a day across TikTok, Reels and Shorts.",
      "",
      "Copy code",
      "You said:",
      "Great, and the audience?",
      "ChatGPT said:",
      "People in their 20s.",
      "ChatGPT can make mistakes. Check important info.",
    ].join("\n");
    const c = parsePastedConversation(paste);
    expect(c.messages.map((m) => [m.role, m.text])).toEqual([
      ["user", "Help me plan 120 videos."],
      ["assistant", "## Posting Cadence\n4 a day across TikTok, Reels and Shorts."],
      ["user", "Great, and the audience?"],
      ["assistant", "People in their 20s."],
    ]);
    expect(c.title).toBe("Help me plan 120 videos.");
  });

  it("“You:” / “ChatGPT:” inline and markdown-heading speakers", () => {
    const c = parsePastedConversation("**You:** what's my offer?\n**ChatGPT:** A $29 community.\n## You\nAnd pricing?\n## ChatGPT\nKeep it at $29.");
    expect(c.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(c.messages[1]!.text).toBe("A $29 community.");
  });

  it("no labels → one honest block (role unknown)", () => {
    const c = parsePastedConversation("Business model: community + course.\nAudience: 20s.", "My notes");
    expect(c.messages).toEqual([{ role: "unknown", text: "Business model: community + course.\nAudience: 20s.", at: null }]);
    expect(c.title).toBe("My notes");
    expect(c.notes[0]).toMatch(/Couldn't tell who said what/);
  });

  it("a single “User:” line in content doesn't fake a conversation", () => {
    const c = parsePastedConversation("Target\nUser: busy parents\nmore text");
    expect(c.messages).toHaveLength(1);
    expect(c.messages[0]!.role).toBe("unknown");
  });
});

describe("Share links", () => {
  it("recognizes share URLs", () => {
    expect(chatGptShareId("https://chatgpt.com/share/6710a1b2-1234-8000-9abc-0123456789ab")).toBe("6710a1b2-1234-8000-9abc-0123456789ab");
    expect(chatGptShareId("https://chat.openai.com/share/abcdef12-3456")).toBe("abcdef12-3456");
    expect(chatGptShareId("https://chatgpt.com/c/6710a1b2-1234")).toBeNull();
    expect(chatGptShareId("https://evil.example/share/6710a1b2-1234")).toBeNull();
  });

  /** Encodes like turbo-stream: a flat array; objects map "_<keyIndex>" → valueIndex. */
  function turboEncode(root: unknown): unknown[] {
    const values: unknown[] = [];
    const strIdx = new Map<string, number>();
    const enc = (v: unknown): number => {
      if (v === null) return -5;
      if (v === undefined) return -7;
      if (typeof v === "string") {
        if (strIdx.has(v)) return strIdx.get(v)!;
        values.push(v);
        strIdx.set(v, values.length - 1);
        return values.length - 1;
      }
      if (typeof v !== "object") {
        values.push(v);
        return values.length - 1;
      }
      const i = values.length;
      values.push(null);
      if (Array.isArray(v)) values[i] = v.map(enc);
      else {
        const o: Record<string, number> = {};
        for (const [k, val] of Object.entries(v as object)) o[`_${enc(k)}`] = enc(val);
        values[i] = o;
      }
      return i;
    };
    enc(root);
    return values;
  }

  function sharePage(payload: unknown): string {
    const chunk = JSON.stringify(turboEncode(payload)) + "\n";
    return `<html><body><script>window.__reactRouterContext.streamController.enqueue(${JSON.stringify(chunk)});</script><script>window.__reactRouterContext.streamController.enqueue("P43:[{}]\\n");</script></body></html>`;
  }

  it("decodes the conversation from the page's inline React Router stream", () => {
    const conv = JSON.parse(exportJson)[1];
    const html = sharePage({ loaderData: { root: {}, "routes/share.$shareId.($action)": { sharedConversationId: "s1", serverResponse: { type: "data", data: conv } } }, actionData: null, errors: null });
    const c = extractConversationFromShareHtml(html)!;
    expect(c.title).toBe("120-video plan + business model");
    expect(c.messages).toHaveLength(6);
    expect(shareServerError(html)).toBeNull();
  });

  it("reports ChatGPT's own error (deleted / private) and returns null when there's no conversation", () => {
    const html = sharePage({ loaderData: { "routes/share.$shareId.($action)": { serverResponse: { type: "error", error: "Conversation has been deleted. Start a new chat." } } } });
    expect(extractConversationFromShareHtml(html)).toBeNull();
    expect(shareServerError(html)).toBe("Conversation has been deleted. Start a new chat.");
    expect(extractConversationFromShareHtml("<html>Just a moment...</html>")).toBeNull();
  });

  it("decodeTurboStream handles specials, shared strings and dates", () => {
    expect(decodeTurboStream([{ _1: 2, _3: -5, _4: 5 }, "a", "x", "b", "c", ["D", 0]])).toEqual({ a: "x", b: null, c: "1970-01-01T00:00:00.000Z" });
  });
});

describe("Highlights (by headings, deterministic)", () => {
  it("finds business model, audience, offer, pillars, cadence and monetization in the plan chat", () => {
    const hl = findHighlights(planConversation().messages);
    const cats = [...new Set(hl.map((h) => h.category))];
    expect(cats).toEqual(["businessModel", "audience", "offer", "pillars", "cadence", "monetization"]);
    const cadence = hl.find((h) => h.category === "cadence")!;
    expect(cadence.text).toMatch(/^## Posting Cadence\n4 videos a day/);
    expect(cadence.text).not.toContain("Monetization");
    expect(hl.find((h) => h.category === "offer")!.text).toContain("Money Reset");
    expect(hl.find((h) => h.category === "pillars")!.text).toContain("3. Lifestyle");
  });

  it("newest mention first; empty headings ignored; body-text mentions don't count", () => {
    const msgs: PlanContextMessage[] = [
      { role: "assistant", text: "## Audience\nOld idea: college students who want side hustles.", at: null },
      { role: "assistant", text: "We talked about the audience a lot.\n## Audience\n\n## Audience\nNew: 22–30 year olds with a first paycheck.", at: null },
    ];
    const hl = findHighlights(msgs);
    expect(hl.map((h) => [h.messageIndex, h.text.split("\n")[1]])).toEqual([
      [1, "New: 22–30 year olds with a first paycheck."],
      [0, "Old idea: college students who want side hustles."],
    ]);
  });
});

describe("Finding the video plan inside the conversation", () => {
  it("finds the table (week 1) and the list (week 2), parsed by the plan-import parsers", () => {
    const c = planConversation();
    const cands = findPlanCandidates(c.messages, ctx);
    expect(cands.map((x) => [x.messageIndex, x.kind, x.rowCount, x.firstYmd, x.supersededBy])).toEqual([
      [5, "list", 4, "2026-10-26", null],
      [3, "table", 5, "2026-10-19", null],
    ]);
    // Business-model prose (pillars list etc.) isn't mistaken for a plan.
    expect(cands.some((x) => x.messageIndex === 1)).toBe(false);
    const rows = parsePlanSegments([c.messages[3]!.text, c.messages[5]!.text], ctx).rows;
    expect(rows.map((r) => [r.ymd, r.title])).toEqual([
      ["2026-10-19", "5 money myths that keep you broke"],
      ["2026-10-19", "Why I stopped budgeting"],
      ["2026-10-20", "The 3-account system"],
      ["2026-10-21", "How to read your credit report"],
      ["2026-10-22", "First paycheck checklist"],
      ["2026-10-26", "The latte myth, honestly"],
      ["2026-10-27", "Emergency fund in 90 days"],
      ["2026-10-28", "Credit card points for beginners"],
      ["2026-10-29", "My money morning routine"],
    ]);
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
    expect(rows[0]!.hook).toBe("Myth #1 is costing you $200 a month");
  });

  it("chat prose around a plan isn't read as a video (“…across the week.”)", () => {
    const t = "Week 2\n\n- Mon 10/26 — The latte myth — all\n\nThat keeps the pillars balanced across the week.\nMon 10/27 — Why I stopped budgeting.";
    expect(stripChatProse(t)).toBe("Week 2\n\n- Mon 10/26 — The latte myth — all\n\nMon 10/27 — Why I stopped budgeting.");
  });

  it("an older draft of the same plan is marked superseded by the newer one", () => {
    const v1 = "- Mon 10/19 — Money myths — all\n- Tue 10/20 — Budgeting is dead — all\n- Wed 10/21 — Credit basics — all";
    const v2 = "Updated:\n- Mon 10/19 — Money myths — all\n- Tue 10/20 — Budgeting is dead — all\n- Wed 10/21 — Credit report secrets — all\n- Thu 10/22 — Payday checklist — all";
    const cands = findPlanCandidates([{ role: "assistant", text: v1, at: null }, { role: "user", text: "tweak it", at: null }, { role: "assistant", text: v2, at: null }], ctx);
    expect(cands.map((c) => [c.messageIndex, c.supersededBy])).toEqual([
      [2, null],
      [0, 2],
    ]);
  });
});

describe("Plan context text for model calls (bounded)", () => {
  const longChat = (n: number): PlanContextMessage[] =>
    Array.from({ length: n }, (_, i) => ({ role: i % 2 ? "assistant" : "user", text: `Message ${i} ${"words ".repeat(60)}`, at: `2026-10-${String(1 + (i % 28)).padStart(2, "0")}T10:00:00.000Z` }));

  it("fits everything when small — not truncated", () => {
    const r = buildPlanContextText([{ title: "Plan", importedAt: "2026-10-17T00:00:00.000Z", messages: planConversation().messages }], { maxChars: 50_000 });
    expect(r.truncated).toBe(false);
    expect(r.includedMessages).toBe(6);
    expect(r.text).toContain("NOT a verified source");
    expect(r.text).toContain("### Highlights");
    expect(r.text.indexOf("### Highlights")).toBeLessThan(r.text.indexOf("### Conversation"));
  });

  it("over budget: highlights + the most recent messages, honest truncation", () => {
    const msgs = [{ role: "assistant" as const, text: "## Business Model\nCommunity + course, $29/month.", at: null }, ...longChat(200)];
    const r = buildPlanContextText([{ title: "Long", importedAt: null, messages: msgs }], { maxChars: 6000 });
    expect(r.truncated).toBe(true);
    expect(r.chars).toBeLessThanOrEqual(6000);
    expect(r.text).toContain("[Business model] ## Business Model");
    expect(r.text).toContain("Message 199");
    expect(r.text).not.toContain("Message 100 ");
    expect(r.text).toMatch(/the most recent \d+ of 201 messages \(\d+ earlier left out\)/);
    // Chronological order of what was kept.
    expect(r.text.indexOf("Message 198")).toBeLessThan(r.text.indexOf("Message 199"));
  });

  it("several conversations share the budget; empty → empty", () => {
    const r = buildPlanContextText(
      [
        { title: "A", importedAt: null, messages: longChat(50) },
        { title: "B", importedAt: null, messages: longChat(50) },
      ],
      { maxChars: 8000 },
    );
    expect(r.conversations).toBe(2);
    expect(r.chars).toBeLessThanOrEqual(8000);
    expect(r.text).toContain('## "A"');
    expect(r.text).toContain('## "B"');
    expect(buildPlanContextText([], { maxChars: 1000 })).toMatchObject({ text: "", truncated: false });
  });
});
