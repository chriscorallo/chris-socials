import { NextResponse } from "next/server";
import { auth } from "../../../../../auth";
import { prisma, isDirectorSpriteKey } from "@chris/domain";
import { storage } from "../../../../../lib/storage";

/**
 * A take's Director-chat frames sprite (JPEG, a few hundred KB). Served SAME-ORIGIN (bytes, not a
 * redirect) because the editor draws it into a canvas to compose the labelled frames image —
 * a cross-origin image would taint the canvas. Only keys of a TakeUnderstanding row are served.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ key: string[] }> }) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { key } = await params;
  const storageKey = key.join("/");
  if (!storageKey.startsWith("understanding/") || !(await isDirectorSpriteKey(prisma, storageKey))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const bytes = await storage.get(storageKey);
  return new NextResponse(new Uint8Array(bytes), {
    headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=31536000, immutable" },
  });
}
