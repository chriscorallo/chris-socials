import { parseExportConversation } from "./chatgpt-export";
import type { ParsedConversation } from "./types";

/**
 * ChatGPT share links (https://chatgpt.com/share/<id>). The public page is server-rendered by
 * React Router and streams its data inline as turbo-stream chunks
 * (`window.__reactRouterContext.streamController.enqueue("…")`); older pages used
 * `__NEXT_DATA__`. When the page carries the conversation (`mapping` / `linear_conversation`),
 * we decode it and reuse the export parser. This is a reasonable attempt, not a scraper we
 * maintain: the page format is undocumented and ChatGPT may block server fetches — the caller
 * must fall back to "export" / "paste" with a plain message. See
 * docs/decisions-pending/plan-context.md.
 */

const SHARE_RE = /^https?:\/\/(?:www\.)?(?:chatgpt\.com|chat\.openai\.com)\/(?:g\/[\w-]+\/)?share\/([A-Za-z0-9-]{8,})(?:[/?#].*)?$/;

export function chatGptShareId(link: string): string | null {
  const m = SHARE_RE.exec(link.trim());
  return m ? m[1]! : null;
}

export function canonicalShareUrl(id: string): string {
  return `https://chatgpt.com/share/${id}`;
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/** Decodes turbo-stream's flat, index-referenced encoding (good enough for loader data). */
export function decodeTurboStream(values: unknown[]): unknown {
  const memo = new Map<number, unknown>();
  const SPECIAL: Record<number, unknown> = { [-1]: undefined, [-2]: NaN, [-3]: -Infinity, [-4]: -0, [-5]: null, [-6]: Infinity, [-7]: undefined };
  const hydrate = (i: unknown, depth: number): unknown => {
    if (typeof i !== "number") return undefined;
    if (i < 0) return SPECIAL[i];
    if (memo.has(i)) return memo.get(i);
    if (depth > 200) return undefined;
    const v = values[i];
    if (v === null || typeof v !== "object") {
      memo.set(i, v);
      return v;
    }
    if (Array.isArray(v)) {
      if (v.length > 0 && typeof v[0] === "string") {
        // Type-tagged values: ["D", ms] date; others (promises, maps, errors…) aren't needed.
        const out = v[0] === "D" && typeof v[1] === "number" ? new Date(v[1]).toISOString() : null;
        memo.set(i, out);
        return out;
      }
      const arr: unknown[] = [];
      memo.set(i, arr);
      for (const el of v) arr.push(hydrate(el, depth + 1));
      return arr;
    }
    const obj: Json = {};
    memo.set(i, obj);
    for (const [k, ref] of Object.entries(v as Json)) {
      const keyIdx = /^_(\d+)$/.exec(k);
      const key = keyIdx ? values[Number(keyIdx[1])] : k;
      if (typeof key !== "string") continue;
      obj[key] = hydrate(ref, depth + 1);
    }
    return obj;
  };
  return hydrate(0, 0);
}

/** The string literals passed to streamController.enqueue(…) on the page. */
export function streamChunks(html: string): string[] {
  const out: string[] = [];
  const re = /streamController\.enqueue\(("(?:[^"\\]|\\.)*")\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    try {
      const s = JSON.parse(m[1]!) as unknown;
      if (typeof s === "string") out.push(s);
    } catch {
      /* skip */
    }
  }
  return out;
}

function findConversation(root: unknown): Json | null {
  const stack: unknown[] = [root];
  const seen = new Set<unknown>();
  let steps = 0;
  while (stack.length && steps++ < 200_000) {
    const v = stack.pop();
    if (!v || typeof v !== "object" || seen.has(v)) continue;
    seen.add(v);
    if (isObj(v) && (isObj(v.mapping) || Array.isArray(v.linear_conversation))) return v;
    for (const child of Array.isArray(v) ? v : Object.values(v as Json)) stack.push(child);
  }
  return null;
}

/** ChatGPT's own error on the share page ("Conversation has been deleted…"), if any. */
export function shareServerError(html: string): string | null {
  for (const line of streamChunks(html).join("").split("\n")) {
    const body = line.replace(/^P\d+:/, "");
    if (!body.startsWith("[")) continue;
    try {
      const stack: unknown[] = [decodeTurboStream(JSON.parse(body) as unknown[])];
      const seen = new Set<unknown>();
      while (stack.length) {
        const v = stack.pop();
        if (!v || typeof v !== "object" || seen.has(v)) continue;
        seen.add(v);
        if (isObj(v) && isObj(v.serverResponse) && v.serverResponse.type === "error") {
          const e = v.serverResponse.error;
          return typeof e === "string" ? e : "ChatGPT couldn't open that link.";
        }
        for (const child of Array.isArray(v) ? v : Object.values(v as Json)) stack.push(child);
      }
    } catch {
      /* ignore */
    }
  }
  return null;
}

/** The conversation embedded in a share page's HTML, or null when it isn't there. */
export function extractConversationFromShareHtml(html: string): ParsedConversation | null {
  const candidates: unknown[] = [];
  const next = /<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (next) {
    try {
      candidates.push(JSON.parse(next[1]!));
    } catch {
      /* ignore */
    }
  }
  const chunks = streamChunks(html);
  const joined = chunks.join("");
  // The first chunk is the root payload; later ones are "P<n>:[…]" promise resolutions. Try
  // the whole stream as one array first, then each line on its own.
  for (const line of joined.split("\n")) {
    const body = line.replace(/^P\d+:/, "");
    if (!body.startsWith("[")) continue;
    try {
      const arr = JSON.parse(body) as unknown;
      if (Array.isArray(arr)) candidates.push(decodeTurboStream(arr));
    } catch {
      /* ignore */
    }
  }
  for (const c of candidates) {
    const conv = findConversation(c);
    if (!conv) continue;
    const parsed = parseExportConversation(conv);
    if (parsed && parsed.messages.length > 0) return parsed;
  }
  return null;
}
