import { describe, it, expect } from "vitest";
import { InstagramGraphAdapter } from "../instagram-adapter";
import { AmbiguousPublishError, PlatformHttpError, type PublishRequest } from "../adapter";
import { createMockFetch, noSleep } from "./mock-fetch";

const AUTH = { accessToken: "ig-token", igUserId: "1784" };

function request(overrides: Partial<PublishRequest> = {}): PublishRequest {
  return {
    contentItemId: "item-1",
    videoBytes: Buffer.from("video"),
    publicVideoUrl: "https://blob.example/v.mp4",
    caption: "Why the sky is blue #science",
    title: null,
    hashtags: ["#Science", "physics", "#learn more"],
    coverFrameSeconds: 1.5,
    idempotencyKey: "item-1:INSTAGRAM",
    ...overrides,
  };
}

function adapter(mock: ReturnType<typeof createMockFetch>, extra: Partial<ConstructorParameters<typeof InstagramGraphAdapter>[0] & object> = {}) {
  return new InstagramGraphAdapter({
    getAuth: async () => AUTH,
    fetchImpl: mock.fetchImpl,
    sleep: noSleep,
    pollIntervalMs: 0,
    maxPollAttempts: 3,
    apiVersion: "v25.0",
    ...extra,
  });
}

describe("InstagramGraphAdapter", () => {
  it("publishes a Reel: container with composed caption + thumb_offset (ms), poll, publish, then the real permalink", async () => {
    const mock = createMockFetch()
      .on("POST", "/1784/media?", { id: "container-1" })
      .on("GET", "/container-1?fields=status_code", { status_code: "IN_PROGRESS" }, { times: 1 })
      .on("GET", "/container-1?fields=status_code", { status_code: "FINISHED" })
      .on("POST", "/1784/media_publish", { id: "17900000001" })
      .on("GET", "/17900000001?fields=id,permalink", { id: "17900000001", permalink: "https://www.instagram.com/reel/C0dE123/" });

    const result = await adapter(mock).publish(request());

    expect(result.status).toBe("SUCCESS");
    expect(result.platformPostId).toBe("17900000001");
    expect(result.url).toBe("https://www.instagram.com/reel/C0dE123/"); // not /reel/{numeric id}/

    const create = mock.callsTo("/1784/media?")[0]!;
    expect(create.url).toContain("https://graph.instagram.com/v25.0/1784/media");
    const params = new URLSearchParams(create.body as string);
    expect(params.get("media_type")).toBe("REELS");
    expect(params.get("video_url")).toBe("https://blob.example/v.mp4");
    expect(params.get("thumb_offset")).toBe("1500");
    expect(params.get("share_to_feed")).toBe("true");
    // #Science already in the caption (case-insensitive) is not duplicated; "learn more" normalized.
    expect(params.get("caption")).toBe("Why the sky is blue #science\n\n#physics #learnmore");
  });

  it("fails clearly without a public video URL (never guesses)", async () => {
    const mock = createMockFetch();
    const result = await adapter(mock).publish(request({ publicVideoUrl: null }));
    expect(result.status).toBe("FAILED");
    expect(result.errorMessage).toContain("public video URL");
    expect(mock.calls).toHaveLength(0);
  });

  it("returns a resumable PENDING_PROCESSING failure when the container is still processing, and resumes without re-uploading", async () => {
    const mock = createMockFetch()
      .on("POST", "/1784/media?", { id: "container-2" })
      .on("GET", "/container-2?fields=status_code", { status_code: "IN_PROGRESS" }, { times: 3 });
    const ig = adapter(mock);

    const first = await ig.publish(request());
    expect(first.status).toBe("FAILED");
    expect(first.errorMessage).toMatch(/^PENDING_PROCESSING:/);
    expect(first.resumeToken).toMatchObject({ containerId: "container-2" });

    mock
      .on("GET", "/container-2?fields=status_code", { status_code: "FINISHED" })
      .on("POST", "/1784/media_publish", { id: "179" })
      .on("GET", "/179?fields=id,permalink", { id: "179", permalink: "https://www.instagram.com/reel/X/" });
    const second = await ig.publish(request({ resumeToken: first.resumeToken, publicVideoUrl: null }));
    expect(second.status).toBe("SUCCESS");
    expect(mock.callsTo("/1784/media?")).toHaveLength(1); // container created once only
  });

  it("an ERROR container fails with the platform's reason", async () => {
    const mock = createMockFetch()
      .on("POST", "/1784/media?", { id: "c3" })
      .on("GET", "/c3?fields=status_code", { status_code: "ERROR", status: "Video format unsupported" });
    const result = await adapter(mock).publish(request());
    expect(result.status).toBe("FAILED");
    expect(result.errorMessage).toContain("ERROR");
  });

  it("a network failure on media_publish is AMBIGUOUS (it may have posted)", async () => {
    const mock = createMockFetch()
      .on("POST", "/1784/media?", { id: "c4" })
      .on("GET", "/c4?fields=status_code", { status_code: "FINISHED" })
      .on("POST", "/1784/media_publish", () => {
        throw new TypeError("fetch failed: socket hang up");
      });
    await expect(adapter(mock).publish(request())).rejects.toBeInstanceOf(AmbiguousPublishError);
  });

  it("a container-creation HTTP error is a plain FAILED (nothing posted)", async () => {
    const mock = createMockFetch().on("POST", "/1784/media?", { error: { message: "Invalid token", code: 190 } }, { status: 400 });
    const result = await adapter(mock).publish(request());
    expect(result.status).toBe("FAILED");
    expect(result.errorMessage).toContain("HTTP 400");
    expect(result.errorMessage).toContain("Invalid token");
  });

  it("getMetrics uses current Reels metric names and converts ig_reels_avg_watch_time ms -> seconds", async () => {
    const mock = createMockFetch().on("GET", "/179/insights", {
      data: [
        { name: "views", values: [{ value: 1200 }] },
        { name: "likes", values: [{ value: 80 }] },
        { name: "comments", values: [{ value: 7 }] },
        { name: "shares", values: [{ value: 5 }] },
        { name: "saved", values: [{ value: 9 }] },
        { name: "reach", values: [{ value: 1000 }] },
        { name: "ig_reels_avg_watch_time", values: [{ value: 6450 }] },
      ],
    });
    const metrics = await adapter(mock).getMetrics("179");
    expect(metrics).toMatchObject({ viewCount: 1200, likeCount: 80, commentCount: 7, shareCount: 5, saveCount: 9, reach: 1000, avgWatchTimeSeconds: 6.45 });
    const url = mock.calls[0]!.url;
    expect(url).toContain("metric=views,likes,comments,shares,saved,reach,ig_reels_avg_watch_time");
    expect(url).not.toContain("plays");
  });

  it("getMetrics throws on an HTTP error instead of returning fabricated all-null metrics", async () => {
    const mock = createMockFetch().on("GET", "/179/insights", { error: { message: "Error validating access token", code: 190 } }, { status: 401 });
    await expect(adapter(mock).getMetrics("179")).rejects.toBeInstanceOf(PlatformHttpError);
  });

  it("listComments follows paging.next and throws on HTTP errors", async () => {
    const mock = createMockFetch()
      .on("GET", "after=CURSOR", { data: [{ id: "c2", username: "b", text: "two", timestamp: "2026-10-16T10:00:00+0000" }] })
      .on("GET", "/179/comments", {
        data: [{ id: "c1", username: "a", text: "one" }],
        paging: { next: "https://graph.instagram.com/v25.0/179/comments?after=CURSOR&access_token=ig-token" },
      });
    const comments = await adapter(mock).listComments("179");
    expect(comments.map((c) => c.platformCommentId)).toEqual(["c1", "c2"]);
    expect(comments[1]?.postedAt?.toISOString()).toBe("2026-10-16T10:00:00.000Z");

    const failing = createMockFetch().on("GET", "/179/comments", { error: { message: "bad" } }, { status: 500 });
    await expect(adapter(failing).listComments("179")).rejects.toBeInstanceOf(PlatformHttpError);
  });

  it("verify returns the permalink", async () => {
    const mock = createMockFetch().on("GET", "/179?fields=id,permalink", { id: "179", permalink: "https://www.instagram.com/reel/P/" });
    expect(await adapter(mock).verify("179")).toMatchObject({ verified: true, url: "https://www.instagram.com/reel/P/" });
  });

  it("asks the token provider for a fresh token on every call (no cached static token)", async () => {
    let n = 0;
    const mock = createMockFetch().on("GET", "/me?fields=user_id", { user_id: "1784" });
    const ig = new InstagramGraphAdapter({
      getAuth: async () => ({ accessToken: `token-${++n}`, igUserId: "1784" }),
      fetchImpl: mock.fetchImpl,
    });
    await ig.checkCredentials();
    await ig.checkCredentials();
    expect(mock.calls[0]!.url).toContain("access_token=token-1");
    expect(mock.calls[1]!.url).toContain("access_token=token-2");
  });

  it("reports not-connected when the provider has no credential", async () => {
    const ig = new InstagramGraphAdapter(null);
    expect(await ig.checkCredentials()).toMatchObject({ ok: false });
  });

  it("findExistingPost matches the composed caption among recent media", async () => {
    const mock = createMockFetch().on("GET", "/1784/media?fields=id,caption", {
      data: [
        { id: "old", caption: "Why the sky is blue #science\n\n#physics #learnmore", timestamp: "2020-01-01T00:00:00+0000" },
        { id: "new", caption: "Why the sky is blue #science\n\n#physics #learnmore", timestamp: "2026-10-16T12:00:00+0000", permalink: "https://www.instagram.com/reel/N/" },
      ],
    });
    const found = await adapter(mock).findExistingPost({
      caption: "Why the sky is blue #science",
      title: null,
      hashtags: ["#Science", "physics", "#learn more"],
      since: new Date("2026-10-16T11:00:00Z"),
    });
    expect(found).toMatchObject({ platformPostId: "new", url: "https://www.instagram.com/reel/N/" });
  });
});
