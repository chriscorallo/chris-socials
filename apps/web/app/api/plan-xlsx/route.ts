import { NextResponse } from "next/server";
import { auth } from "../../../auth";
import { MAX_XLSX_BYTES, readXlsxSheets } from "../../../lib/plan-xlsx";

/**
 * Plan import: the browser PUTs an .xlsx file as the raw body and gets every visible sheet
 * back as string cells (parsing to rows happens in the browser, same as CSV). A route handler
 * rather than a Server Action because actions cap bodies at 1 MB by default. Nothing is stored.
 */
export async function PUT(request: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const buf = await request.arrayBuffer();
  if (buf.byteLength === 0) return NextResponse.json({ error: "That file is empty." }, { status: 400 });
  if (buf.byteLength > MAX_XLSX_BYTES) return NextResponse.json({ error: "That spreadsheet is over 5 MB — save just the plan tab and try again." }, { status: 413 });
  try {
    const sheets = await readXlsxSheets(buf);
    if (sheets.length === 0) return NextResponse.json({ error: "That spreadsheet looks empty." }, { status: 422 });
    return NextResponse.json({ sheets });
  } catch {
    return NextResponse.json(
      { error: "Couldn't read that file as an Excel spreadsheet (.xlsx). Older .xls or Numbers files: export as CSV or .xlsx first." },
      { status: 422 },
    );
  }
}
