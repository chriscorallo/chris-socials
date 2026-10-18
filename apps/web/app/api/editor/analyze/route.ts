import { NextResponse } from "next/server";
import { analyzeFootageAction } from "../../../content/[id]/edit/interaction-actions";

/**
 * The editor's footage analysis (scene stats + vocal emphasis for Motion v2 graphics) as a Route
 * Handler, not a Server Action: Next.js dispatches Server Actions one at a time per client, and
 * this one can take many seconds on a big take (it reads the camera original) — as an action it
 * held up Save, the proxy poll and everything else queued behind it
 * (docs/decisions-pending/editor-rebuild.md). Auth is checked inside (requireSession).
 */
export const maxDuration = 120;

export async function POST(request: Request) {
  let body: { contentItemId?: unknown; timeline?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  if (typeof body.contentItemId !== "string") return NextResponse.json({ error: "bad request" }, { status: 400 });
  try {
    return NextResponse.json(await analyzeFootageAction(body.contentItemId, body.timeline));
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
}
