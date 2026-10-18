/**
 * Independent reads in parallel where the database can take it, one at a time where it can't.
 *
 * The local PGlite dev/test database breaks under concurrently dispatched queries (see
 * /docs/DECISIONS.md, "The PGlite dev database can't handle concurrently dispatched queries"),
 * which is why pages and loaders were written as long chains of sequential awaits. Production
 * is Neon Postgres, which handles concurrency fine — there each sequential await costs a full
 * function↔database round trip, and a page with 15–20 of them pays that 15–20 times. This
 * helper keeps one code path for both: `Promise.all` on a real Postgres, strictly sequential
 * (in argument order) on PGlite.
 *
 * Detection is by the connection host: PGlite is only ever served on this machine
 * (scripts/dev-db.mjs, vitest.global-setup.ts), production never is. `DB_PARALLEL_QUERIES`
 * ("1"/"0") overrides either way — e.g. a local Docker Postgres can opt in.
 * See docs/decisions-pending/app-performance.md.
 */

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);

export function canRunQueriesInParallel(env: Record<string, string | undefined> = process.env): boolean {
  const override = env.DB_PARALLEL_QUERIES;
  if (override === "1" || override === "true") return true;
  if (override === "0" || override === "false") return false;
  const url = env.DATABASE_URL;
  if (!url) return false;
  try {
    return !LOCAL_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

type Thunks = readonly (() => Promise<unknown>)[];
type Results<T extends Thunks> = { -readonly [K in keyof T]: Awaited<ReturnType<T[K]>> };

/**
 * Runs independent query thunks — `Promise.all` when the database allows concurrency,
 * otherwise one after another in order. Results come back in argument order either way.
 * Thunks (not promises) so the sequential path really does dispatch one query at a time.
 */
export async function queryAll<const T extends Thunks>(
  thunks: T,
  opts: { parallel?: boolean } = {},
): Promise<Results<T>> {
  const parallel = opts.parallel ?? canRunQueriesInParallel();
  if (parallel) {
    return (await Promise.all(thunks.map((t) => t()))) as Results<T>;
  }
  const out: unknown[] = [];
  for (const t of thunks) out.push(await t());
  return out as Results<T>;
}
