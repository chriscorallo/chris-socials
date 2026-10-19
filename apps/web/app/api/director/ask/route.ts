import { NextResponse } from "next/server";
import { auth } from "../../../../auth";
import { prisma } from "@chris/domain";
import { askDirectorAi } from "../../../../lib/director/server";
import { getModelProvider } from "../../../../lib/model-provider";

/**
 * Director chat — the PAID path ("Ask AI"): the same pack + the frames image to Claude. A Route
 * Handler, not a Server Action: it carries a JPEG (over the 1 MB action body limit) and takes
 * tens of seconds (actions run one at a time per client and would block Save). Refused unless AI
 * credit is available (checked again on the server). Cost is logged per call (ModelCallLog).
 */
export const maxDuration = 300;

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ ok: false, errors: ["Sign in again."], repairMessage: "" }, { status: 401 });
  let body: { itemId?: unknown; messageId?: unknown; imageBase64?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, errors: ["Bad request."], repairMessage: "" }, { status: 400 });
  }
  if (typeof body.itemId !== "string" || typeof body.messageId !== "string") return NextResponse.json({ ok: false, errors: ["Bad request."], repairMessage: "" }, { status: 400 });
  const image = typeof body.imageBase64 === "string" && body.imageBase64.length < 6_000_000 ? body.imageBase64.replace(/^data:image\/\w+;base64,/, "") : null;
  try {
    const r = await askDirectorAi(prisma, getModelProvider(), { itemId: body.itemId, messageId: body.messageId, imageBase64: image, actorId: session.user.id });
    return NextResponse.json(r);
  } catch (err) {
    return NextResponse.json({ ok: false, errors: [err instanceof Error ? err.message : "Something went wrong."], repairMessage: "" }, { status: 500 });
  }
}
