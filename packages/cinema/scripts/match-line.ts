/**
 * Meaning-Match from the command line (also warms the embedding model cache):
 *   pnpm --filter @chris/cinema exec tsx scripts/match-line.ts "You raised your baseline." ["another line" …]
 */
import { matchLineToCatalog } from "../src/catalog-match";

const lines = process.argv.slice(2);
for (const line of lines.length ? lines : ["You raised your baseline."]) {
  const t0 = Date.now();
  const m = await matchLineToCatalog(line, { limit: 5 });
  console.log(`\n"${line}" (${Date.now() - t0} ms)`);
  for (const r of m) console.log(`  ${r.score.toFixed(3)}  ${r.entry.id.padEnd(28)} sem ${r.semantic.toFixed(3)} kw ${r.keyword}  ← ${r.matchedPhrase ?? "(description)"}`);
}
