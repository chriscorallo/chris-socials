import { describe, it, expect } from "vitest";
import {
  TikTokContentPostingAdapter,
  planTikTokChunks,
  extractTikTokPostIds,
  TIKTOK_MAX_FINAL_CHUNK_BYTES,
  type TikTokAdapterConfig,
} from "../tiktok-adapter";
import { AmbiguousPublishError, PlatformHttpError, type PublishRequest } from "../adapter";
import { createMockFetch, json, raw, noSleep } from "./mock-fetch";

const MB = 1024 * 1024;
const UPLOAD_URL = "https://open-upload.tiktokapis.com/video/?upload_id=U1&upload_token=T";

function request(overrides: Partial<PublishRequest> = {}): PublishRequest {
  return {
    contentItemId: "item-1",
    videoBytes: Buffer.alloc(1000, 1),
    publicVideoUrl: null,
    caption: "Physics in 30 seconds",
    title: null,
    hashtags: ["#physics", "learnontiktok"],
    coverFrameSeconds: 2,
    idempotencyKey: "item-1:TIKTOK",
    durationSeconds: 30,
    ...overrides,
  };
}

function adapter(mock: ReturnType<typeof createMockFetch>, config: Partial<TikTokAdapterConfig> = {}) {
  return new TikTokContentPostingAdapter({
    getAccessToken: async () => "tt-token",
    appAudited: false,
    fetchImpl: mock.fetchImpl,
    sleep: noSleep,
    statusPollAttempts: 2,
    statusPollIntervalMs: 0,
    ...config,
  });
}

const OK = { error: { code: "ok", message: "" } };

describe("planTikTokChunks (TikTok media transfer guide math)", () => {
  it("files ≤64MB upload as a single chunk of their own size", () => {
    expect(planTikTokChunks(3 * MB)).toEqual({ chunkSize: 3 * MB, totalChunkCount: 1, ranges: [[0, 3 * MB - 1]] });
    expect(planTikTokChunks(64 * MB).totalChunkCount).toBe(1);
  });

  it("larger files: total_chunk_count = floor(size / chunk_size), trailing bytes merged into the last chunk", () => {
    const size = 105 * MB + 123;
    const plan = planTikTokChunks(size, 10 * MB);
    expect(plan.chunkSize).toBe(10 * MB);
    expect(plan.totalChunkCount).toBe(10);
    expect(plan.ranges[0]).toEqual([0, 10 * MB - 1]);
    expect(plan.ranges[9]).toEqual([90 * MB, size - 1]);
    const last = plan.ranges[9]!;
    expect(last[1] - last[0] + 1).toBe(15 * MB + 123);
  });

  it("clamps the chunk size to 5–64MB and keeps the final chunk ≤128MB", () => {
    expect(planTikTokChunks(100 * MB, 1 * MB).chunkSize).toBe(5 * MB);
    const big = planTikTokChunks(700 * MB, 999 * MB);
    expect(big.chunkSize).toBe(64 * MB);
    const last = big.ranges[big.ranges.length - 1]!;
    expect(last[1] - last[0] + 1).toBeLessThanOrEqual(TIKTOK_MAX_FINAL_CHUNK_BYTES);
    expect(planTikTokChunks(4 * 1024 * MB).totalChunkCount).toBeLessThanOrEqual(1000);
  });

  it("ranges are contiguous and cover every byte", () => {
    const size = 333 * MB + 7;
    const plan = planTikTokChunks(size);
    let expected = 0;
    for (const [start, end] of plan.ranges) {
      expect(start).toBe(expected);
      expected = end + 1;
    }
    expect(expected).toBe(size);
  });
});

describe("extractTikTokPostIds", () => {
  it("keeps int64 ids exact (beyond 2^53)", () => {
    const text = '{"data":{"status":"PUBLISH_COMPLETE","publicaly_available_post_id":[7300000000000000123]},"error":{"code":"ok"}}';
    expect(extractTikTokPostIds(text)).toEqual(["7300000000000000123"]);
    expect(JSON.parse(text).data.publicaly_available_post_id[0].toString()).not.toBe("7300000000000000123");
  });
});

describe("TikTokContentPostingAdapter", () => {
  it("defaults to INBOX mode when the app is not audited", () => {
    expect(adapter(createMockFetch()).postMode).toBe("INBOX");
    expect(adapter(createMockFetch(), { appAudited: true }).postMode).toBe("DIRECT");
  });

  it("INBOX mode: inbox init (source_info only), chunk PUT with Content-Range, DRAFT with a finish-in-app message", async () => {
    const mock = createMockFetch()
      .on("POST", "/post/publish/inbox/video/init/", { data: { publish_id: "v_inbox_1", upload_url: UPLOAD_URL }, ...OK })
      .on("PUT", "upload_id=U1", () => raw("", 201))
      .on("POST", "/post/publish/status/fetch/", { data: { status: "SEND_TO_USER_INBOX" }, ...OK });

    const result = await adapter(mock).publish(request());
    expect(result.status).toBe("DRAFT");
    expect(result.platformPostId).toBe("v_inbox_1");
    expect(result.errorMessage).toContain("TikTok inbox");

    const init = JSON.parse(mock.callsTo("/inbox/video/init/")[0]!.body as string);
    expect(init).toEqual({ source_info: { source: "FILE_UPLOAD", video_size: 1000, chunk_size: 1000, total_chunk_count: 1 } });
    const put = mock.callsTo("upload_id=U1")[0]!;
    expect(put.headers["content-range"]).toBe("bytes 0-999/1000");
    expect(put.headers["content-type"]).toBe("video/mp4");
    expect(mock.callsTo("creator_info")).toHaveLength(0);
  });

  it("uploads large files in sequential chunks with correct Content-Range headers", async () => {
    const size = 75 * MB;
    const mock = createMockFetch()
      .on("POST", "/inbox/video/init/", { data: { publish_id: "p", upload_url: UPLOAD_URL }, ...OK })
      .on("PUT", "upload_id=U1", () => raw("", 206), { times: 6 })
      .on("PUT", "upload_id=U1", () => raw("", 201))
      .on("POST", "/status/fetch/", { data: { status: "SEND_TO_USER_INBOX" }, ...OK });
    await adapter(mock).publish(request({ videoBytes: Buffer.alloc(size, 2) }));

    const init = JSON.parse(mock.callsTo("/inbox/video/init/")[0]!.body as string);
    expect(init.source_info).toEqual({ source: "FILE_UPLOAD", video_size: size, chunk_size: 10 * MB, total_chunk_count: 7 });
    const puts = mock.callsTo("upload_id=U1");
    expect(puts).toHaveLength(7);
    expect(puts[0]!.headers["content-range"]).toBe(`bytes 0-${10 * MB - 1}/${size}`);
    expect(puts[6]!.headers["content-range"]).toBe(`bytes ${60 * MB}-${size - 1}/${size}`);
    expect((puts[6]!.body as Uint8Array).byteLength).toBe(15 * MB);
  });

  it("DIRECT (audited): creator_info first, PUBLIC privacy from the allowed options, composed title, cover ms; resolves the int64 video id", async () => {
    const mock = createMockFetch()
      .on("POST", "/creator_info/query/", {
        data: { creator_username: "chris", privacy_level_options: ["PUBLIC_TO_EVERYONE", "SELF_ONLY"], comment_disabled: false, duet_disabled: true, stitch_disabled: false, max_video_post_duration_sec: 600 },
        ...OK,
      })
      .on("POST", "/post/publish/video/init/", { data: { publish_id: "v_pub_1", upload_url: UPLOAD_URL }, ...OK })
      .on("PUT", "upload_id=U1", () => raw("", 201))
      .on("POST", "/status/fetch/", () =>
        raw('{"data":{"status":"PUBLISH_COMPLETE","publicaly_available_post_id":[7300000000000000123]},"error":{"code":"ok"}}'),
      );

    const result = await adapter(mock, { appAudited: true }).publish(request());
    expect(result.status).toBe("SUCCESS");
    expect(result.platformPostId).toBe("7300000000000000123");
    expect(result.url).toBe("https://www.tiktok.com/@chris/video/7300000000000000123");

    const init = JSON.parse(mock.callsTo("/post/publish/video/init/")[0]!.body as string);
    expect(init.post_info).toEqual({
      title: "Physics in 30 seconds\n\n#physics #learnontiktok",
      privacy_level: "PUBLIC_TO_EVERYONE",
      disable_comment: false,
      disable_duet: true,
      disable_stitch: false,
      video_cover_timestamp_ms: 2000,
    });
  });

  it("DIRECT (unaudited, private account): SELF_ONLY and a DRAFT outcome", async () => {
    const mock = createMockFetch()
      .on("POST", "/creator_info/query/", { data: { privacy_level_options: ["FOLLOWER_OF_CREATOR", "SELF_ONLY"] }, ...OK })
      .on("POST", "/post/publish/video/init/", { data: { publish_id: "v_pub_2", upload_url: UPLOAD_URL }, ...OK })
      .on("PUT", "upload_id=U1", () => raw("", 201))
      .on("POST", "/status/fetch/", { data: { status: "PROCESSING_UPLOAD" }, ...OK });
    const result = await adapter(mock, { postMode: "DIRECT" }).publish(request());
    expect(result.status).toBe("DRAFT");
    expect(JSON.parse(mock.callsTo("/video/init/")[0]!.body as string).post_info.privacy_level).toBe("SELF_ONLY");
    expect(result.platformPostId).toBe("v_pub_2");
  });

  it("DIRECT (unaudited, no usable privacy option): fails before uploading, pointing at INBOX mode", async () => {
    const mock = createMockFetch().on("POST", "/creator_info/query/", { data: { privacy_level_options: ["PUBLIC_TO_EVERYONE"] }, ...OK });
    const result = await adapter(mock, { postMode: "DIRECT" }).publish(request());
    expect(result.status).toBe("FAILED");
    expect(result.errorMessage).toContain("TIKTOK_POST_MODE=INBOX");
    expect(mock.callsTo("/video/init/")).toHaveLength(0);
  });

  it("DIRECT: enforces the creator's max duration from creator_info", async () => {
    const mock = createMockFetch().on("POST", "/creator_info/query/", { data: { privacy_level_options: ["SELF_ONLY"], max_video_post_duration_sec: 60 }, ...OK });
    const result = await adapter(mock, { postMode: "DIRECT" }).publish(request({ durationSeconds: 90 }));
    expect(result.status).toBe("FAILED");
    expect(result.errorMessage).toContain("at most 60s");
  });

  it("init errors carry TikTok's code plus an actionable hint", async () => {
    const mock = createMockFetch()
      .on("POST", "/creator_info/query/", { data: { privacy_level_options: ["SELF_ONLY"] }, ...OK })
      .on("POST", "/video/init/", { error: { code: "unaudited_client_can_only_post_to_private_accounts", message: "x" } }, { status: 403 });
    const result = await adapter(mock, { postMode: "DIRECT" }).publish(request());
    expect(result.status).toBe("FAILED");
    expect(result.errorMessage).toContain("unaudited_client_can_only_post_to_private_accounts");
    expect(result.errorMessage).toContain("INBOX");
  });

  it("a network failure on the final chunk is AMBIGUOUS", async () => {
    const mock = createMockFetch()
      .on("POST", "/inbox/video/init/", { data: { publish_id: "p", upload_url: UPLOAD_URL }, ...OK })
      .on("PUT", "upload_id=U1", () => {
        throw new TypeError("fetch failed");
      });
    await expect(adapter(mock).publish(request())).rejects.toBeInstanceOf(AmbiguousPublishError);
  });

  it("a FAILED processing status is reported with TikTok's fail_reason", async () => {
    const mock = createMockFetch()
      .on("POST", "/inbox/video/init/", { data: { publish_id: "p", upload_url: UPLOAD_URL }, ...OK })
      .on("PUT", "upload_id=U1", () => raw("", 201))
      .on("POST", "/status/fetch/", { data: { status: "FAILED", fail_reason: "duration_check_failed" }, ...OK });
    const result = await adapter(mock).publish(request());
    expect(result.status).toBe("FAILED");
    expect(result.errorMessage).toContain("duration_check_failed");
  });

  it("verify resolves a publish_id to the public video id once TikTok exposes it", async () => {
    const mock = createMockFetch().on("POST", "/status/fetch/", () =>
      raw('{"data":{"status":"PUBLISH_COMPLETE","publicaly_available_post_id":[7311111111111111111]},"error":{"code":"ok"}}'),
    );
    const result = await adapter(mock).verify("v_pub_9");
    expect(result).toMatchObject({ verified: true, resolvedPostId: "7311111111111111111" });

    const processing = createMockFetch().on("POST", "/status/fetch/", { data: { status: "PROCESSING_UPLOAD" }, ...OK });
    expect(await adapter(processing).verify("v_pub_9")).toMatchObject({ verified: false, pending: true });
  });

  it("getMetrics refuses an unresolved publish_id, throws on API errors, maps fields on success", async () => {
    await expect(adapter(createMockFetch()).getMetrics("v_pub_1")).rejects.toThrow(/not resolved/);

    const unauthorized = createMockFetch().on("POST", "/video/query/", { error: { code: "access_token_invalid", message: "expired" } }, { status: 401 });
    await expect(adapter(unauthorized).getMetrics("7300000000000000123")).rejects.toBeInstanceOf(PlatformHttpError);

    const ok = createMockFetch().on("POST", "/video/query/", () =>
      json({ data: { videos: [{ id: "7300000000000000123", view_count: 900, like_count: 50, comment_count: 4, share_count: 3 }] }, ...OK }),
    );
    expect(await adapter(ok).getMetrics("7300000000000000123")).toMatchObject({ viewCount: 900, likeCount: 50, commentCount: 4, shareCount: 3, saveCount: null });
  });

  it("listComments stays [] (no endpoint at this tier); INBOX findExistingPost refuses (can't look up drafts)", async () => {
    const tt = adapter(createMockFetch());
    expect(await tt.listComments("x")).toEqual([]);
    await expect(tt.findExistingPost({ caption: "c", title: null, hashtags: [], since: new Date() })).rejects.toThrow(/inbox/);
  });

  it("DIRECT findExistingPost matches title + create_time via video/list, keeping int64 ids exact", async () => {
    const mock = createMockFetch().on("POST", "/video/list/", () =>
      raw(
        '{"data":{"videos":[{"id":7300000000000000999,"title":"Physics in 30 seconds\\n\\n#physics #learnontiktok","create_time":1792000000,"share_url":"https://www.tiktok.com/@chris/video/7300000000000000999"}]},"error":{"code":"ok"}}',
      ),
    );
    const found = await adapter(mock, { postMode: "DIRECT" }).findExistingPost({
      caption: "Physics in 30 seconds",
      title: null,
      hashtags: ["#physics", "learnontiktok"],
      since: new Date(1791999000 * 1000),
    });
    expect(found?.platformPostId).toBe("7300000000000000999");
  });
});
