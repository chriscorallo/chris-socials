/**
 * Runs once per server instance, before any request.
 *
 * Time zone: the whole app reasons in Chris's local time — `<input type="datetime-local">`
 * values parsed with `new Date(...)`, the calendar's week/day grouping, "7 PM" displays. All
 * of that uses the server process's time zone, which is UTC on Vercel (and can't be set via
 * the reserved TZ env var there), so a "7 PM" post was silently scheduled for 7 PM UTC.
 * Assigning process.env.TZ at runtime re-points Node's Date to APP_TIMEZONE for every code
 * path at once (default America/Los_Angeles). See /docs/DECISIONS.md ("App time zone").
 */
export function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    process.env.TZ = process.env.APP_TIMEZONE || "America/Los_Angeles";
  }
}

/** Server errors with enough context to debug months later (spec §22 observability). */
export function onRequestError(
  error: unknown,
  request: { path: string; method: string },
  context: { routerKind: string; routePath: string; routeType: string },
) {
  const err = error as { message?: string; digest?: string; stack?: string };
  console.error(
    JSON.stringify({
      level: "error",
      event: "request_error",
      method: request.method,
      path: request.path,
      routePath: context.routePath,
      routeType: context.routeType,
      message: err?.message,
      digest: err?.digest,
      stack: err?.stack?.split("\n").slice(0, 8).join("\n"),
    }),
  );
}
