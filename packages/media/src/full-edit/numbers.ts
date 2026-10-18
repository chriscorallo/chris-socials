/**
 * Numbers Chris actually SAID, at the word level (PURE). Whisper writes some numbers as digits
 * ("$10,000", "5%") and some spelled out ("sixty thousand dollars"); both are read here with the
 * word span they came from, so a graphic can start on the number word and the Verification bot
 * can prove every on-screen number was spoken.
 */

export interface SpokenNumber {
  value: number;
  kind: "MONEY" | "PERCENT" | "NUMBER";
  /** Word index span [w0, w1] (inclusive) in the list passed in. */
  w0: number;
  w1: number;
  raw: string;
  /** A bare small count ("three months", "step one") — real, but not a visual on its own. */
  minor: boolean;
}

const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const SCALES: Record<string, number> = { thousand: 1e3, grand: 1e3, million: 1e6, billion: 1e9 };
const SUFFIX: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9 };

function clean(w: string): string {
  return w.toLowerCase().replace(/[’‘]/g, "'").replace(/^["“(]+|[.,!?;:"”)]+$/g, "");
}

function unitAfter(words: string[], i: number): { kind: "MONEY" | "PERCENT" | null; used: number } {
  const w = words[i] !== undefined ? clean(words[i]!) : "";
  if (/^(dollars?|bucks)$/.test(w)) return { kind: "MONEY", used: 1 };
  if (/^(percent|%)$/.test(w)) return { kind: "PERCENT", used: 1 };
  return { kind: null, used: 0 };
}

/** Pure. Every number in `words` (Whisper tokens, punctuation attached) with its word span. */
export function spokenNumbers(words: string[]): SpokenNumber[] {
  const out: SpokenNumber[] = [];
  let i = 0;
  while (i < words.length) {
    const raw = words[i]!;
    const w = clean(raw);
    // Retirement-plan names are not amounts.
    if (/^40[13]\(?[kb]\)?s?$/.test(w)) {
      i++;
      continue;
    }
    const dm = /^(\$)?(\d[\d,]*(?:\.\d+)?)(k|m|b)?(%)?$/.exec(w.replace(/^\$\s*/, "$"));
    if (dm) {
      let v = Number(dm[2]!.replace(/,/g, ""));
      let end = i;
      if (dm[3]) v *= SUFFIX[dm[3]]!;
      const next = words[i + 1] !== undefined ? clean(words[i + 1]!) : "";
      if (!dm[3] && next in SCALES) {
        v *= SCALES[next]!;
        end++;
      }
      let kind: SpokenNumber["kind"] = dm[1] ? "MONEY" : dm[4] ? "PERCENT" : "NUMBER";
      const u = unitAfter(words, end + 1);
      if (kind === "NUMBER" && u.kind) {
        kind = u.kind;
        end += u.used;
      }
      const isYear = kind === "NUMBER" && !dm[3] && end === i && Number.isInteger(v) && v >= 1900 && v <= 2100;
      if (Number.isFinite(v) && !isYear) {
        out.push({ value: v, kind, w0: i, w1: end, raw: words.slice(i, end + 1).join(" "), minor: kind === "NUMBER" && v <= 12 && Number.isInteger(v) });
      }
      i = end + 1;
      continue;
    }
    // Spelled out: "sixty thousand dollars", "a hundred percent", "four hundred", "twenty-five".
    const isNumWord = (x: string) => x in UNITS || x in TENS || x === "hundred" || x in SCALES;
    const parts = w.split("-");
    const startsSpelled = parts.every(isNumWord) || (w === "a" && words[i + 1] !== undefined && ["hundred", "thousand", "million", "billion"].includes(clean(words[i + 1]!)));
    if (startsSpelled && !(w in SCALES)) {
      let total = 0;
      let current = 0;
      let j = i;
      let any = false;
      for (; j < words.length; j++) {
        const x = clean(words[j]!);
        if (x === "and" && any && j + 1 < words.length && clean(words[j + 1]!).split("-").every(isNumWord)) continue;
        if (x === "a" && j === i) {
          current = 1;
          any = true;
          continue;
        }
        const xs = x.split("-");
        if (!xs.every(isNumWord)) break;
        for (const p of xs) {
          if (p in UNITS) current += UNITS[p]!;
          else if (p in TENS) current += TENS[p]!;
          else if (p === "hundred") current = (current || 1) * 100;
          else if (p in SCALES) {
            total += (current || 1) * SCALES[p]!;
            current = 0;
          }
        }
        any = true;
        // Stop after a scale word unless more number words follow ("ten thousand five hundred").
        if (/[.,!?;:]$/.test(words[j]!)) {
          j++;
          break;
        }
      }
      const end = j - 1;
      if (any && end >= i) {
        const v = total + current;
        let kind: SpokenNumber["kind"] = "NUMBER";
        let last = end;
        const u = unitAfter(words, end + 1);
        if (u.kind && !/[.,!?;:]$/.test(words[end]!)) {
          kind = u.kind;
          last += u.used;
        }
        const single = end === i && w !== "a";
        out.push({ value: v, kind, w0: i, w1: last, raw: words.slice(i, last + 1).join(" "), minor: kind === "NUMBER" && (v <= 12 || single) });
        i = last + 1;
        continue;
      }
    }
    i++;
  }
  return out;
}

/** Same quantity? Exact, or the same value written at another scale/rounding within 0.5 %. */
export function sameNumber(a: number, b: number): boolean {
  if (a === b) return true;
  const A = Math.abs(a);
  const B = Math.abs(b);
  if (A === 0 || B === 0) return false;
  return Math.abs(A - B) / Math.max(A, B) <= 0.005;
}

/** Compact money/percent label as a creator would write it: 10000 → "$10K", 5 → "5%". */
export function shortNumberLabel(n: { value: number; kind: SpokenNumber["kind"] }): string {
  const v = Math.abs(n.value);
  const fmt = (x: number) => (Number.isInteger(x) ? String(x) : x.toFixed(1).replace(/\.0$/, ""));
  let s: string;
  if (v >= 1e9) s = `${fmt(v / 1e9)}B`;
  else if (v >= 1e6) s = `${fmt(v / 1e6)}M`;
  else if (v >= 1e4) s = `${fmt(v / 1e3)}K`;
  else if (v >= 1000) s = Number.isInteger(v / 1000) ? `${v / 1000}K` : v.toLocaleString("en-US");
  else s = fmt(v);
  if (n.kind === "MONEY") return `${n.value < 0 ? "−" : ""}$${s}`;
  if (n.kind === "PERCENT") return `${s}%`;
  return s;
}
