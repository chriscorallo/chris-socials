import { NextResponse } from "next/server";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { auth } from "../../../auth";
import { REFERENCE_VIDEO_KEY_PATTERN } from "@chris/domain/style-metrics";

/** Largest raw take accepted (4K phone footage of a few minutes fits comfortably). */
const MAX_RAW_TAKE_BYTES = 5 * 1024 * 1024 * 1024;

/**
 * Issues short-lived client tokens so the browser can upload a raw take DIRECTLY to the
 * private Blob store (Vercel functions can't receive bodies over 4.5 MB). Only signed-in
 * users get a token, only for a `raw/<contentItemId>/...` pathname (video/audio) or a
 * `music/<contentItemId>/...` pathname (audio only — a music bed).
 * The MediaAsset row is created afterwards by the `registerBlobUpload` server action, which
 * the browser calls once the upload finishes — not by an upload-completed webhook, which
 * can't reach a local dev server. See /docs/DECISIONS.md.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const body = (await request.json()) as HandleUploadBody;
  try {
    const result = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname) => {
        const session = await auth();
        if (!session?.user) throw new Error("Unauthorized");
        // reference/<creator>/<file> = a reference video (private style analysis only; video only).
        if (/^reference\//.test(pathname)) {
          if (!REFERENCE_VIDEO_KEY_PATTERN.test(pathname)) throw new Error(`Refusing upload to unexpected pathname: ${pathname}`);
          return { allowedContentTypes: ["video/*"], maximumSizeInBytes: MAX_RAW_TAKE_BYTES, addRandomSuffix: false, allowOverwrite: false };
        }
        // raw/<item>/<file> = a take (video or audio); music/<item>/<file> = a music bed (audio only).
        const kind = /^music\//.test(pathname) ? "MUSIC" : "RAW_TAKE";
        if (!/^(raw|music)\/[\w-]+\/[\w.-]+$/.test(pathname)) {
          throw new Error(`Refusing upload to unexpected pathname: ${pathname}`);
        }
        return {
          allowedContentTypes: kind === "MUSIC" ? ["audio/*"] : ["video/*", "audio/*"],
          maximumSizeInBytes: MAX_RAW_TAKE_BYTES,
          addRandomSuffix: false,
          allowOverwrite: false,
        };
      },
    });
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Upload token error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
