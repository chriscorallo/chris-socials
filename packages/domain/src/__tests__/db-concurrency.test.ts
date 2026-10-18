import { describe, it, expect } from "vitest";
import { canRunQueriesInParallel, queryAll } from "../db-concurrency";
import { prisma } from "../prisma";

describe("canRunQueriesInParallel", () => {
  it("is false for a local (PGlite) database and true for a hosted one", () => {
    expect(canRunQueriesInParallel({ DATABASE_URL: "postgresql://postgres:postgres@localhost:55432/postgres" })).toBe(false);
    expect(canRunQueriesInParallel({ DATABASE_URL: "postgresql://u:p@127.0.0.1:5432/db" })).toBe(false);
    expect(canRunQueriesInParallel({ DATABASE_URL: "postgresql://u:p@ep-x-pooler.c-14.us-east-1.aws.neon.tech/db?sslmode=require" })).toBe(true);
  });

  it("fails safe (sequential) with no or an unparsable URL, and honors the override", () => {
    expect(canRunQueriesInParallel({})).toBe(false);
    expect(canRunQueriesInParallel({ DATABASE_URL: "not a url" })).toBe(false);
    expect(canRunQueriesInParallel({ DATABASE_URL: "postgresql://u:p@localhost/db", DB_PARALLEL_QUERIES: "1" })).toBe(true);
    expect(canRunQueriesInParallel({ DATABASE_URL: "postgresql://u:p@db.neon.tech/db", DB_PARALLEL_QUERIES: "0" })).toBe(false);
  });
});

describe("queryAll", () => {
  function tracked() {
    let inFlight = 0;
    let maxInFlight = 0;
    const order: number[] = [];
    const task = (n: number, ms: number) => async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, ms));
      inFlight--;
      order.push(n);
      return n * 10;
    };
    return { task, stats: () => ({ maxInFlight, order }) };
  }

  it("sequential mode never has two thunks in flight, and runs them in order", async () => {
    const { task, stats } = tracked();
    const out = await queryAll([task(1, 15), task(2, 1), task(3, 5)], { parallel: false });
    expect(out).toEqual([10, 20, 30]);
    expect(stats()).toEqual({ maxInFlight: 1, order: [1, 2, 3] });
  });

  it("parallel mode overlaps them but still returns results in argument order", async () => {
    const { task, stats } = tracked();
    const out = await queryAll([task(1, 15), task(2, 1), task(3, 5)], { parallel: true });
    expect(out).toEqual([10, 20, 30]);
    expect(stats().maxInFlight).toBe(3);
  });

  it("propagates a rejection", async () => {
    await expect(queryAll([async () => 1, async () => { throw new Error("boom"); }], { parallel: false })).rejects.toThrow("boom");
  });

  it("defaults to sequential against the test PGlite database and works with real queries", async () => {
    expect(canRunQueriesInParallel()).toBe(false);
    const [users, items, one] = await queryAll([() => prisma.user.count(), () => prisma.contentItem.count(), () => prisma.$queryRaw<{ n: number }[]>`SELECT 1 AS n`]);
    expect(typeof users).toBe("number");
    expect(typeof items).toBe("number");
    expect(one[0]?.n).toBe(1);
  });
});
