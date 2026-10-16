import { PlatformHttpError, type Platform } from "./adapter";

/** Injectable for tests (mocked fetch) — production uses the global fetch. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpResult {
  ok: boolean;
  status: number;
  body: unknown;
  text: string;
  headers: Headers;
}

/** Reads the body once as text, then parses JSON if possible. Keeping the raw text matters
 * for TikTok, whose int64 post ids lose precision under JSON.parse. */
export async function readResponse(response: Response): Promise<HttpResult> {
  const text = await response.text().catch(() => "");
  let body: unknown = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { ok: response.ok, status: response.status, body, text, headers: response.headers };
}

export async function request(fetchImpl: FetchLike, url: string, init?: RequestInit): Promise<HttpResult> {
  const response = await fetchImpl(url, init);
  return readResponse(response);
}

export function assertOk(platform: Platform, operation: string, result: HttpResult): void {
  if (!result.ok) throw new PlatformHttpError(platform, operation, result.status, result.body);
}

export function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Copy into a plain ArrayBuffer-backed Uint8Array — satisfies every fetch BodyInit typing in
 * this monorepo (see the original tiktok-adapter.ts note on Buffer's ArrayBufferLike). */
export function toBody(bytes: Buffer | Uint8Array): Blob {
  return new Blob([Uint8Array.from(bytes)]);
}
