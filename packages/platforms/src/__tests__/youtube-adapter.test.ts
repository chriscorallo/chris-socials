import { describe, it, expect } from "vitest";
import { YouTubeDataApiAdapter, nextOffsetFromRange } from "../youtube-adapter";
import { AmbiguousPublishError, PlatformHttpError, type PublishRequest } from "../adapter";
import { createMockFetch, json, raw } from "./mock-fetch";

const SESSION = "https://www.googleapis.com/upload/youtube/v3/videos?upload_id=SESSION1";

function request(overrides: Partial<PublishRequest> = {}): PublishRequest {
  return {
    contentItemId: "item-1",
    videoBytes: Buffer.alloc(1000, 7),
    publicVideoUrl: null,
    caption: "First line becomes title\nMore detail <here>",
    title: null,
    hashtags: ["#shorts", "physics"],
    coverFrameSeconds: null,
    idempotencyKey: "item-1:YOUTUBE",
    ...overrides,
  };
}

function adapter(mock: ReturnType<typeof createMockFetch>, privacyStatus: "public" | "private" | "unlisted" = "public") {
  return new YouTubeDataApiAdapter({ getAccessToken: async () => "yt-token", fetchImpl: mock.fetchImpl, privacyStatus });
}

function sessionRoute(mock: ReturnType<typeof createMockFetch>) {
  mock.on("POST", "uploadType=resumable", () => raw("", 200, { Location: SESSION }));
}

describe("YouTubeDataApiAdapter", () => {
  it("uses the resumable protocol: metadata POST (composed title/description/tags, configured privacy), then a PUT of the bytes", async () => {
    const mock = createMockFetch();
    sessionRoute(mock);
    mock.on("PUT", "upload_id=SESSION1", { id: "vid123", status: { privacyStatus: "unlisted" } });

    const result = await adapter(mock, "unlisted").publish(request());
    expect(result).toMatchObject({ status: "SUCCESS", platformPostId: "vid123", url: "https://www.youtube.com/shorts/vid123" });

    const init = mock.calls[0]!;
    expect(init.headers["x-upload-content-length"]).toBe("1000");
    expect(init.headers["authorization"]).toBe("Bearer yt-token");
    const metadata = JSON.parse(init.body as string);
    expect(metadata.snippet.title).toBe("First line becomes title");
    expect(metadata.snippet.description).toBe("First line becomes title\nMore detail here\n\n#shorts #physics");
    expect(metadata.snippet.tags).toEqual(["shorts", "physics"]);
    expect(metadata.status.privacyStatus).toBe("unlisted");
    expect((mock.calls[1]!.body as Uint8Array).byteLength).toBe(1000);
  });

  it("enforces ≤100 chars without splitting surrogate pairs and strips < >", async () => {
    const mock = createMockFetch();
    sessionRoute(mock);
    mock.on("PUT", "upload_id=SESSION1", { id: "v" });
    await adapter(mock).publish(request({ title: `<${"a".repeat(98)}😀😀>` }));
    const title: string = JSON.parse(mock.calls[0]!.body as string).snippet.title;
    expect(Array.from(title)).toHaveLength(100);
    expect(title.endsWith("😀")).toBe(true);
    expect(title).not.toMatch(/[<>]/);
    expect(title.at(-1)).not.toBe("\ud83d"); // no dangling high surrogate
  });

  it("resumes an interrupted upload from the server-acknowledged offset", async () => {
    const mock = createMockFetch();
    sessionRoute(mock);
    mock
      .on("PUT", "upload_id=SESSION1", () => {
        throw new TypeError("fetch failed: ECONNRESET");
      }, { times: 1 })
      .on("PUT", "upload_id=SESSION1", (call) =>
        call.headers["content-range"] === "bytes */1000" ? raw("", 308, { Range: "bytes=0-399" }) : json({ id: "vid-resumed" }),
      );
    const result = await adapter(mock).publish(request());
    expect(result).toMatchObject({ status: "SUCCESS", platformPostId: "vid-resumed" });
    const resumePut = mock.calls.find((c) => c.headers["content-range"] === "bytes 400-999/1000");
    expect((resumePut?.body as Uint8Array).byteLength).toBe(600);
  });

  it("an interrupted upload whose status can't be read is AMBIGUOUS", async () => {
    const mock = createMockFetch();
    sessionRoute(mock);
    mock.on("PUT", "upload_id=SESSION1", () => {
      throw new TypeError("fetch failed");
    });
    await expect(adapter(mock).publish(request())).rejects.toBeInstanceOf(AmbiguousPublishError);
  });

  it("an upload-session HTTP error is a plain FAILED", async () => {
    const mock = createMockFetch().on("POST", "uploadType=resumable", { error: { code: 403, message: "quotaExceeded" } }, { status: 403 });
    const result = await adapter(mock).publish(request());
    expect(result.status).toBe("FAILED");
    expect(result.errorMessage).toContain("quotaExceeded");
  });

  it("verify flags a requested-public upload that YouTube locked to private", async () => {
    const mock = createMockFetch().on("GET", "/videos?part=status", { items: [{ status: { uploadStatus: "processed", privacyStatus: "private" } }] });
    const result = await adapter(mock).verify("vid123");
    expect(result.verified).toBe(true);
    expect(result.note).toContain("Uploaded but private — YouTube API audit required");
  });

  it("verify reports a rejected upload as not verified with the reason", async () => {
    const mock = createMockFetch().on("GET", "/videos?part=status", { items: [{ status: { uploadStatus: "rejected", rejectionReason: "duplicate" } }] });
    const result = await adapter(mock).verify("vid123");
    expect(result.verified).toBe(false);
    expect(result.note).toContain("duplicate");
  });

  it("getMetrics throws on HTTP errors and on a missing video (no fake nulls)", async () => {
    const unauthorized = createMockFetch().on("GET", "part=statistics", { error: { code: 401, message: "Invalid Credentials" } }, { status: 401 });
    await expect(adapter(unauthorized).getMetrics("v")).rejects.toBeInstanceOf(PlatformHttpError);
    const missing = createMockFetch().on("GET", "part=statistics", { items: [] });
    await expect(adapter(missing).getMetrics("v")).rejects.toBeInstanceOf(PlatformHttpError);
    const ok = createMockFetch().on("GET", "part=statistics", { items: [{ statistics: { viewCount: "10", likeCount: "2", commentCount: "1" } }] });
    expect(await adapter(ok).getMetrics("v")).toMatchObject({ viewCount: 10, likeCount: 2, commentCount: 1, shareCount: null, avgWatchTimeSeconds: null });
  });

  it("listComments paginates with pageToken; comments disabled yields []", async () => {
    const mock = createMockFetch()
      .on("GET", "pageToken=P2", { items: [{ snippet: { topLevelComment: { id: "c2", snippet: { textDisplay: "b" } } } }] })
      .on("GET", "/commentThreads", { nextPageToken: "P2", items: [{ snippet: { topLevelComment: { id: "c1", snippet: { textDisplay: "a" } } } }] });
    expect((await adapter(mock).listComments("v")).map((c) => c.platformCommentId)).toEqual(["c1", "c2"]);

    const disabled = createMockFetch().on("GET", "/commentThreads", { error: { errors: [{ reason: "commentsDisabled" }] } }, { status: 403 });
    expect(await adapter(disabled).listComments("v")).toEqual([]);
  });

  it("findExistingPost checks the uploads playlist for the exact composed title", async () => {
    const mock = createMockFetch()
      .on("GET", "/channels?part=contentDetails", { items: [{ contentDetails: { relatedPlaylists: { uploads: "UU1" } } }] })
      .on("GET", "/playlistItems", {
        items: [{ snippet: { title: "First line becomes title", publishedAt: "2026-10-16T12:00:00Z", resourceId: { videoId: "found1" } } }],
      });
    const found = await adapter(mock).findExistingPost({
      caption: request().caption,
      title: null,
      hashtags: [],
      since: new Date("2026-10-16T11:00:00Z"),
    });
    expect(found?.platformPostId).toBe("found1");
  });

  it("nextOffsetFromRange parses Range headers", () => {
    expect(nextOffsetFromRange("bytes=0-524287")).toBe(524288);
    expect(nextOffsetFromRange(null)).toBe(0);
  });

  it("legacy static-token construction still works (backward compatible)", async () => {
    const mock = createMockFetch().on("GET", "/channels?part=id", { items: [{ id: "UC1" }] });
    const yt = new YouTubeDataApiAdapter({ getAccessToken: async () => "static", fetchImpl: mock.fetchImpl });
    expect(await yt.checkCredentials()).toEqual({ ok: true });
    expect(await new YouTubeDataApiAdapter(null).checkCredentials()).toMatchObject({ ok: false });
  });
});
