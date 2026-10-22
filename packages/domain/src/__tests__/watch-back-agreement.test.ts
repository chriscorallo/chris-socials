import { describe, it, expect } from "vitest";
import { seriesAgreementFrom, watchAgrees, WATCH_AGREEMENT_WINDOW } from "../watch-back";

describe("watch-back — autonomy as agreement", () => {
  it("PASS agrees with UP, FIX/HOLD with DOWN", () => {
    expect(watchAgrees("PASS", "UP")).toBe(true);
    expect(watchAgrees("PASS", "DOWN")).toBe(false);
    expect(watchAgrees("HOLD", "DOWN")).toBe(true);
    expect(watchAgrees("FIX", "UP")).toBe(false);
  });
  it("a series earns hands-off posting at ≥ 90 % over ten, with no override; loses it on a pulled post", () => {
    const good = Array.from({ length: WATCH_AGREEMENT_WINDOW }, (_, i) => ({ verdict: i === 3 ? "HOLD" : "PASS", rating: i === 3 ? "DOWN" : "UP", action: "POSTED_UNCHANGED" }));
    expect(seriesAgreementFrom("PICK_YOUR_POISON", good)).toMatchObject({ rated: 10, agreed: 10, agreement: 1, earned: true });
    const nine = good.slice(0, 9);
    expect(seriesAgreementFrom("x", nine).earned).toBe(false);
    expect(seriesAgreementFrom("x", nine).why).toMatch(/9 of 10/);
    const withOverride = good.map((r, i) => (i === 5 ? { ...r, action: "POST_ANYWAY" } : r));
    expect(seriesAgreementFrom("x", withOverride).earned).toBe(false);
    const disagree = good.map((r, i) => (i < 2 ? { ...r, rating: "DOWN" } : r));
    const d = seriesAgreementFrom("x", disagree);
    expect(d.agreement).toBe(0.8);
    expect(d.earned).toBe(false);
    const pulled = good.map((r, i) => (i === 0 ? { ...r, action: "PULLED" } : r));
    expect(seriesAgreementFrom("x", pulled)).toMatchObject({ earned: false, pulled: 1 });
    expect(seriesAgreementFrom("x", pulled).why).toMatch(/demoted/);
  });
});
