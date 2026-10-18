import { NextResponse } from "next/server";
import { prisma, recordEditorHealthReport, EDITOR_HEALTH_MAX_BYTES } from "@chris/domain";
import { auth } from "../../../auth";
import { EditorHealthReportSchema, type ParsedEditorHealthReport } from "../../../lib/editor/health-schema";

/**
 * Editor health telemetry sink (docs/decisions-pending/editor-rebuild.md). The finishing editor
 * posts compact reports (fetch, or sendBeacon when the page hides). Signed-in only; size-capped;
 * schema-checked (numbers, short strings, small arrays — no media, titles or text); stored
 * append-only and pruned on write (newest 400 / 30 days).
 */
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const text = await request.text();
  if (text.length > EDITOR_HEALTH_MAX_BYTES) return NextResponse.json({ error: "Too large" }, { status: 413 });
  let parsed: ParsedEditorHealthReport;
  try {
    parsed = EditorHealthReportSchema.parse(JSON.parse(text));
  } catch {
    return NextResponse.json({ error: "Bad report" }, { status: 400 });
  }
  try {
    const row = await recordEditorHealthReport(prisma, {
      userId: session.user.id,
      contentItemId: parsed.contentItemId,
      sessionId: parsed.sessionId,
      kind: parsed.kind,
      engine: parsed.engine,
      userAgent: request.headers.get("user-agent"),
      report: parsed as unknown as Record<string, unknown>,
    });
    return NextResponse.json({ ok: true, id: row.id });
  } catch (err) {
    // Telemetry never surfaces errors to the editor — but leave a trace for the server log.
    console.error(JSON.stringify({ level: "error", event: "editor_health_write_failed", message: err instanceof Error ? err.message : String(err) }));
    return NextResponse.json({ ok: false }, { status: 200 });
  }
}
