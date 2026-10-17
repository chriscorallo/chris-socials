/**
 * Google Sheets link → the sheet's CSV export URL. Works when the sheet is shared "Anyone with
 * the link" (or published to the web); a private sheet answers with Google's sign-in page,
 * which the server-side fetch detects and turns into a plain "share it first" message.
 *
 *   https://docs.google.com/spreadsheets/d/<id>/edit#gid=123
 *   https://docs.google.com/spreadsheets/d/<id>/edit?usp=sharing
 *   https://docs.google.com/spreadsheets/d/e/<pubId>/pubhtml?gid=0&single=true   (published)
 */
export function googleSheetCsvUrl(link: string): string | null {
  let url: URL;
  try {
    url = new URL(link.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname !== "docs.google.com") return null;
  const gid = /[#&?]gid=(\d+)/.exec(url.href)?.[1] ?? null;
  const pub = /^\/spreadsheets\/d\/e\/([\w-]+)/.exec(url.pathname);
  if (pub) {
    return `https://docs.google.com/spreadsheets/d/e/${pub[1]}/pub?output=csv${gid ? `&gid=${gid}` : ""}`;
  }
  const m = /^\/spreadsheets\/d\/([\w-]{20,})/.exec(url.pathname);
  if (!m) return null;
  return `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv${gid ? `&gid=${gid}` : ""}`;
}

export function looksLikeGoogleSheetLink(text: string): boolean {
  return /^\s*https:\/\/docs\.google\.com\/spreadsheets\//.test(text) && text.trim().split(/\s+/).length === 1;
}

/** Plain-English failure for a sheet fetch (status + content-type of Google's answer). */
export function googleSheetFetchError(status: number, contentType: string | null): string | null {
  if (status >= 200 && status < 300 && !/text\/html/i.test(contentType ?? "")) return null;
  if (status === 404) return "That sheet doesn't exist (or the link is incomplete). Copy the link again from the Share button.";
  return "Couldn't open that sheet — it's private. In Google Sheets tap Share → General access → “Anyone with the link” (Viewer), then paste the link again. Or download it as CSV/Excel and upload the file.";
}
