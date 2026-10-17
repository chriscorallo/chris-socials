import { describe, expect, it } from "vitest";
import { NAV_LINKS, TAB_LINKS, MORE_LINKS, isActive } from "../app/components/nav-links-data";
import manifest from "../app/manifest";

// Mobile navigation (bottom tab bar + "More" sheet) — /docs/decisions-pending/mobile-app.md.
describe("mobile navigation", () => {
  it("reaches every desktop destination exactly once on phones (tabs + More)", () => {
    const mobile = [...TAB_LINKS.map((l) => l.href), ...MORE_LINKS.map((l) => l.href)];
    expect(new Set(mobile).size).toBe(mobile.length);
    expect([...mobile].sort()).toEqual(NAV_LINKS.map((l) => l.href).sort());
  });

  it("keeps the tab bar to five destinations plus More, with Upload in the thumb-center", () => {
    // Six slots at 320px is ~53px each — still >= the 44px tap-target floor.
    expect(TAB_LINKS.map((l) => l.label)).toEqual(["Home", "Content", "Upload", "Film", "Calendar"]);
    expect(Math.floor(320 / (TAB_LINKS.length + 1))).toBeGreaterThanOrEqual(44);
  });

  it("highlights Home only on /, and sections on their sub-routes", () => {
    expect(isActive("/", "/")).toBe(true);
    expect(isActive("/", "/content")).toBe(false);
    expect(isActive("/content", "/content/abc123")).toBe(true);
    expect(isActive("/content", "/contentious")).toBe(false);
    expect(isActive("/reference", "/reference/xyz")).toBe(true);
    expect(isActive("/settings/connections", "/settings/connections")).toBe(true);
    expect(isActive("/film", null)).toBe(false);
  });
});

describe("web app manifest", () => {
  it("launches standalone with the dark theme and home-screen icons", () => {
    const m = manifest();
    expect(m.display).toBe("standalone");
    expect(m.short_name).toBe("Chris Studio");
    expect(m.background_color).toBe("#050506");
    const sizes = (m.icons ?? []).map((i) => i.sizes);
    expect(sizes).toContain("192x192");
    expect(sizes).toContain("512x512");
    expect((m.icons ?? []).some((i) => i.purpose === "maskable")).toBe(true);
  });
});
