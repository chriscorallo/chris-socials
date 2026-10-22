// Golden-set harness: replay every fixture offline and diff against the expected cut
// (docs/PREMIUM_EDITOR_HANDOFF.md §3.1).
//
//   pnpm golden:replay            print each cut + the diff; exit 1 on any diff
//   pnpm golden:replay --update   rewrite fixtures/golden/expected/*.json
//   pnpm golden:replay <slug> …   only these fixtures
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { diffGolden, GoldenFixtureSchema, replayGolden, type GoldenCut, type GoldenReplay, type HandEditComparison } from "../../packages/media/src/golden";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const DIR = join(ROOT, "fixtures/golden");
const EXPECTED = join(DIR, "expected");
const args = process.argv.slice(2);
const update = args.includes("--update");
const only = args.filter((a) => !a.startsWith("--"));

const files = existsSync(DIR) ? readdirSync(DIR).filter((f) => f.endsWith(".json") && (!only.length || only.includes(f.replace(/\.json$/, "")))) : [];
if (!files.length) {
  console.log("No fixtures in fixtures/golden — pull some with `pnpm golden:pull`.");
  process.exit(0);
}

const fmtSum = (s: GoldenCut["spliceSummary"]) =>
  `${s.n} splices · air median ${s.airMedianS ?? "–"} s · p90 ${s.airP90S ?? "–"} s · max ${s.airMaxS ?? "–"} s · >0.26 s: ${s.airOver026Count} · clipped >40 ms: ${s.clippedCount} (max ${s.clippedMaxMs} ms)`;
const fmtHand = (c: HandEditComparison) =>
  `edges vs hand: median ${c.medianDeltaMs ?? "–"} ms · p90 ${c.p90DeltaMs ?? "–"} ms · within 30 ms ${c.within30ms}/${c.handCuts * 2} · kept agreement ${(c.machineKeptOfHand * 100).toFixed(0)}% of hand / ${(c.handKeptOfMachine * 100).toFixed(0)}% of machine`;

function printCut(label: string, c: GoldenCut | null) {
  if (!c) return;
  if (!c.ok) {
    console.log(`  ${label}: FAILED — ${c.error}`);
    return;
  }
  console.log(`  ${label}: ${c.outputDurationS} s · title "${c.title ?? "—"}" · ${c.headlines.length} headlines · ${c.graphics.length} graphics · ${c.zooms} zooms`);
  for (const k of c.kept) console.log(`    [${k.sentenceId}] ${k.beat.padEnd(8)} ${k.text.slice(0, 90)}`);
  if (c.headlines.length) console.log(`    headlines: ${c.headlines.map((h) => `"${h.text}" ${h.start}–${h.end}`).join(" | ")}`);
  console.log(`    ${fmtSum(c.spliceSummary)}`);
}

let dirty = 0;
if (update) mkdirSync(EXPECTED, { recursive: true });
for (const file of files) {
  const slug = file.replace(/\.json$/, "");
  const fixture = GoldenFixtureSchema.parse(JSON.parse(readFileSync(join(DIR, file), "utf8")));
  const r = await replayGolden(fixture);
  console.log(`\n== ${slug} — ${fixture.title ?? ""} (${fixture.take.durationSeconds.toFixed(1)} s take)`);
  printCut("free", r.free);
  printCut("editor", r.editor);
  if (r.prodMachine) console.log(`  prod machine cut: ${fmtSum(r.prodMachine.spliceSummary)}`);
  if (r.hand) {
    console.log(`  hand edit: ${fmtSum(r.hand.spliceSummary)}`);
    console.log(`    free   ${fmtHand(r.hand.vsFree)}`);
    if (r.hand.vsEditor) console.log(`    editor ${fmtHand(r.hand.vsEditor)}`);
  }
  const expPath = join(EXPECTED, file);
  if (update) {
    writeFileSync(expPath, JSON.stringify(r, null, 1) + "\n");
    console.log("  expected: written");
    continue;
  }
  if (!existsSync(expPath)) {
    console.log("  expected: none yet (run with --update)");
    continue;
  }
  const d = diffGolden(JSON.parse(readFileSync(expPath, "utf8")) as GoldenReplay, r);
  if (d.length) {
    dirty++;
    console.log(`  DIFF (${d.length}):`);
    for (const x of d) console.log(`    - ${x}`);
  } else console.log("  expected: matches");
}
console.log(update ? "\nExpected cuts updated." : dirty ? `\n${dirty} fixture(s) changed.` : "\nGolden set green.");
process.exit(!update && dirty ? 1 : 0);
