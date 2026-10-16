import type { FetchLike } from "../http";

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | Uint8Array | null;
}

type Responder = (call: RecordedCall) => Response | Promise<Response>;

interface Route {
  method?: string;
  match: string | RegExp;
  respond: Responder;
  /** Max times this route may answer (then it's skipped); default unlimited. */
  times?: number;
  used: number;
}

/** A scripted fetch: first matching route (by method + URL substring/regex) answers. Unmatched
 * requests throw so a test never silently hits the network. */
export function createMockFetch() {
  const routes: Route[] = [];
  const calls: RecordedCall[] = [];

  const fetchImpl: FetchLike = async (input, init) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    let body: string | Uint8Array | null = null;
    if (typeof init?.body === "string") body = init.body;
    else if (init?.body instanceof URLSearchParams) body = init.body.toString();
    else if (init?.body instanceof Blob) body = new Uint8Array(await init.body.arrayBuffer());
    const call: RecordedCall = { url: input, method: (init?.method ?? "GET").toUpperCase(), headers, body };
    calls.push(call);
    for (const route of routes) {
      if (route.method && route.method !== call.method) continue;
      const matches = typeof route.match === "string" ? call.url.includes(route.match) : route.match.test(call.url);
      if (!matches) continue;
      if (route.times !== undefined && route.used >= route.times) continue;
      route.used++;
      return route.respond(call);
    }
    throw new Error(`Unmocked fetch: ${call.method} ${call.url}`);
  };

  return {
    fetchImpl,
    calls,
    on(method: string | undefined, match: string | RegExp, respond: Responder | unknown, options: { times?: number; status?: number; headers?: Record<string, string> } = {}) {
      const responder: Responder =
        typeof respond === "function"
          ? (respond as Responder)
          : () => json(respond, options.status ?? 200, options.headers);
      routes.push({ method, match, respond: responder, times: options.times, used: 0 });
      return this;
    },
    callsTo(match: string) {
      return calls.filter((c) => c.url.includes(match));
    },
  };
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

export function raw(text: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(text, { status, headers });
}

export const noSleep = async () => {};
