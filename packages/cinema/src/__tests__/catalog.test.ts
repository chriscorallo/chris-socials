import { describe, expect, it } from "vitest";
import { ACTION_TYPES, ACTOR_KINDS, SET_KINDS, VERBS } from "../dsl/schema";
import { formatIssues, validateFilm } from "../dsl/validate";
import { VISUAL_CATALOG, catalogEntryText, catalogExampleFilm, getCatalogEntry, searchCatalog } from "../catalog";
import { compileFilm, evaluateFrame } from "../evaluate";
import { resolveFilm } from "../timing";
import { VERB_TARGETS } from "../kinds";

describe("visual catalog", () => {
  it("has an entry for every actor kind, action type and set", () => {
    for (const k of ACTOR_KINDS) expect(getCatalogEntry(k), k).toBeTruthy();
    for (const a of ACTION_TYPES) expect(getCatalogEntry(`action:${a}`), a).toBeTruthy();
    for (const s of SET_KINDS) expect(getCatalogEntry(`set:${s}`), s).toBeTruthy();
    expect(VISUAL_CATALOG.filter((e) => e.type === "RECIPE").length).toBeGreaterThanOrEqual(15);
  });

  it("every entry has rich text to embed (depicts ≥ 50 chars, ≥ 3 good-for phrases)", () => {
    for (const e of VISUAL_CATALOG) {
      expect(e.depicts.length, e.id).toBeGreaterThanOrEqual(50);
      expect(e.goodFor.length, e.id).toBeGreaterThanOrEqual(3);
      expect(catalogEntryText(e).length).toBeGreaterThan(80);
    }
  });

  it("every verb applies to at least one kind and every ACTOR entry lists its params", () => {
    for (const v of VERBS) expect(Object.keys(VERB_TARGETS[v]).length, v).toBeGreaterThan(0);
    for (const e of VISUAL_CATALOG.filter((x) => x.type === "ACTOR")) {
      expect(e.params.length, e.id).toBeGreaterThan(0);
      expect(e.framing?.distance, e.id).toBeGreaterThan(1);
    }
  });

  it("every example is a valid film whose frames evaluate (and are deterministic)", () => {
    for (const e of VISUAL_CATALOG) {
      const film = catalogExampleFilm(e);
      const v = validateFilm(film);
      if (!v.ok) throw new Error(`${e.id}:\n${formatIssues(v.errors)}`);
      const cf = compileFilm(resolveFilm(v.film));
      const n = cf.rf.totalFrames;
      for (const f of [0, Math.floor(n / 2), n - 1]) {
        const a = evaluateFrame(cf, f);
        expect(a.actors.every((s) => s.position.every(Number.isFinite)), `${e.id}@${f}`).toBe(true);
        expect(JSON.stringify(evaluateFrame(cf, f))).toBe(JSON.stringify(a));
      }
    }
  });

  it("keyword search finds the literal metaphor for a line", () => {
    expect(searchCatalog("You raised your baseline.")[0]!.entry.id).toBe("recipe:raise-baseline");
    expect(searchCatalog("Read the fine print")[0]!.entry.id).toMatch(/fine-print|MAGNIFIER|DOCUMENT/);
    expect(searchCatalog("You're stuck in the rat race").map((r) => r.entry.id)).toContain("recipe:rat-race");
  });
});
