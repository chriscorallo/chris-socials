import { NextResponse } from "next/server";
import { auth } from "../../../../auth";
import { prisma } from "@chris/domain";
import { storage } from "../../../../lib/storage";

/**
 * Authenticated media serving. Phase 1's local-fs StorageAdapter approximates a "signed URL"
 * with a plain authenticated route rather than a real time-limited signature — see
 * /docs/SECURITY.md. Real signed URLs arrive with the Vercel Blob implementation.
 *
 * Checks MediaAsset (raw uploads) first, then Render (rendered outputs) — both store files
 * under the same StorageAdapter, but only MediaAsset carries a `mimeType` column. Render
 * outputs are always video/mp4 (packages/media's renderVideo always encodes to that — see
 * /docs/DECISIONS.md), so that's hardcoded here rather than adding an unused column. Found
 * this gap by tracing through the content detail page's new "View rendered output" link,
 * which would otherwise 404 — Phase 3's UI wiring pass, see /docs/DECISIONS.md.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ key: string[] }> },
) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { key: keySegments } = await params;
  const storageKey = keySegments.join("/");

  const asset = await prisma.mediaAsset.findFirst({ where: { storageKey } });
  if (asset) {
    const bytes = await storage.get(storageKey);
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        "Content-Type": asset.mimeType,
        "Content-Disposition": `inline; filename="${asset.originalFilename}"`,
        "Cache-Control": "private, max-age=0, must-revalidate",
      },
    });
  }

  const render = await prisma.render.findFirst({ where: { storageKey } });
  if (render) {
    const bytes = await storage.get(storageKey);
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        "Content-Type": "video/mp4",
        "Content-Disposition": 'inline; filename="render.mp4"',
        "Cache-Control": "private, max-age=0, must-revalidate",
      },
    });
  }

  return NextResponse.json({ error: "Not found" }, { status: 404 });
}
