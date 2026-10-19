import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PostItYourself } from "../app/components/PostItYourself";

describe("PostItYourself", () => {
  it("offers Save to Photos and copies each app's exact text (YouTube: title + description)", () => {
    const html = renderToStaticMarkup(
      createElement(PostItYourself, {
        videoUrl: "/api/media/renders/x.mp4",
        fileName: "car.mp4",
        texts: [
          { platform: "INSTAGRAM", caption: "Your car is a 72-month commitment.\n\n#budgeting", title: null },
          { platform: "YOUTUBE", caption: "Needs at 50%, savings first.", title: "Where are you saving?" },
        ],
      }),
    );
    expect(html).toContain("Save video to Photos");
    expect(html).toContain("Copy caption — Your car is a 72-month commitment.");
    expect(html).toContain("Copy title — Where are you saving?");
    expect(html).toContain("Copy description — Needs at 50%, savings first.");
    // TikTok has no text yet → says where it comes from.
    expect(html).toMatch(/post-TIKTOK[\s\S]*No text yet/);
  });
});
