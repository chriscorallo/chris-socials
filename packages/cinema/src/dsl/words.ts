/**
 * Word tokenization shared by validation (does the anchor word exist in the line?), timing
 * (which spoken word is it?) and captions. Pure.
 */

export interface LineToken {
  /** As written in the line ("$10,000.", "raise,"). */
  raw: string;
  /** Normalized for matching: lowercase, letters/digits only ("10000", "raise"). */
  norm: string;
}

/** "$10,000." -> "10000"; "Don't" -> "dont"; "half—" -> "half". */
export function normalizeWord(w: string): string {
  return w
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9%]/g, "");
}

/** Words of a line. Whitespace and dashes separate words; a hyphenated word ("thirty-five")
 * becomes its parts ("thirty-", "five") so each can be anchored and matched to speech. */
export function tokenizeLine(line: string): LineToken[] {
  return line
    .split(/[\s—–]+/) // whitespace, em/en dashes
    .flatMap((w) => w.split(/(?<=[A-Za-z]-)(?=[A-Za-z])/)) // "thirty-five" -> "thirty-", "five"
    .map((raw) => raw.trim())
    .filter((raw) => raw.length > 0)
    .map((raw) => ({ raw, norm: normalizeWord(raw) }))
    .filter((t) => t.norm.length > 0);
}

/** Index of the n-th (1-based) token whose norm equals normalizeWord(word); -1 if none. */
export function findWordIndex(tokens: LineToken[], word: string, occurrence = 1): number {
  const target = normalizeWord(word);
  let seen = 0;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i]!.norm === target) {
      seen++;
      if (seen === occurrence) return i;
    }
  }
  return -1;
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length]!;
}

/** Closest words of the line to a misspelled anchor (for "did you mean" hints). */
export function closestWords(tokens: LineToken[], word: string, max = 3): string[] {
  const target = normalizeWord(word);
  const uniq = [...new Set(tokens.map((t) => t.norm))];
  return uniq
    .map((w) => ({ w, d: levenshtein(w, target) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, max)
    .map((x) => x.w);
}
