import { NextResponse } from "next/server";
import { graphicBakesAction } from "../../../content/[id]/edit/actions";

/**
 * Baked preview graphics: request + poll (docs/decisions-pending/editor-rebuild.md). A Route
 * Handler so the editor's polling never queues in front of Save (Next.js runs Server Actions one
 * at a time per client). Auth is checked inside (requireSession).
 */
export async function POST(request: Request) {
  let body: { contentItemId?: unknown; wanted?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  if (typeof body.contentItemId !== "string" || !Array.isArray(body.wanted)) return NextResponse.json({ error: "bad request" }, { status: 400 });
  try {
    return NextResponse.json(await graphicBakesAction(body.contentItemId, body.wanted as Parameters<typeof graphicBakesAction>[1]));
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
}
