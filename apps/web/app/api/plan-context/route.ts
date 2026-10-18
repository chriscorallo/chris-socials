import { gunzipSync } from "node:zlib";
import { NextResponse } from "next/server";
import { PlanContextError, prisma, savePlanContext } from "@chris/domain";
import { auth } from "../../../auth";

/**
 * Plan context: save one ChatGPT conversation (its text only — the export .zip is read in
 * the browser and never uploads). A route handler rather than a Server Action because a long
 * planning chat can exceed the 1 MB action body limit; the browser gzips the JSON
 * (`x-body-encoding: gzip`) to stay well under Vercel's 4.5 MB request cap.
 */
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_JSON_BYTES = 40 * 1024 * 1024;

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const buf = Buffer.from(await request.arrayBuffer());
  if (buf.byteLength === 0) return NextResponse.json({ error: "Nothing was sent." }, { status: 400 });
  if (buf.byteLength > MAX_BODY_BYTES) return NextResponse.json({ error: "That conversation is too big to send in one go." }, { status: 413 });
  let body: unknown;
  try {
    const raw = request.headers.get("x-body-encoding") === "gzip" ? gunzipSync(buf, { maxOutputLength: MAX_JSON_BYTES }) : buf;
    body = JSON.parse(raw.toString("utf8"));
  } catch {
    return NextResponse.json({ error: "Couldn't read what was sent — try again." }, { status: 400 });
  }
  try {
    const result = await savePlanContext(prisma, body as Parameters<typeof savePlanContext>[1], { actorId: session.user.id });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof PlanContextError) return NextResponse.json({ error: err.message }, { status: 422 });
    if (err instanceof Error && err.name === "ZodError") return NextResponse.json({ error: "That conversation couldn't be saved (it looks empty or malformed)." }, { status: 422 });
    console.error("[plan-context] save failed", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Couldn't save just now — try again." }, { status: 500 });
  }
}
