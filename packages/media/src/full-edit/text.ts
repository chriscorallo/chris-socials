/**
 * Text helpers for the Full edit (PURE, browser-safe): tokens, stop words, similarity, and a
 * deterministic lexical "embedding" used when the local sentence model isn't available.
 */

export const STOP_WORDS = new Set(
  (
    "a an the and or but of to in on at for is are was were be been being it its it's this that these those you your yours " +
    "i i'm i've i'd me my we our us they them their he him his she her with as by from so just not no do does did doing have has had " +
    "what when where how which who whom will would can could should than then there here about into over out up down if because " +
    "very really also too all any some more most much many such only own same other again once am get got gonna wanna kind sort " +
    "thing things like um uh okay ok yeah oh well let let's that's there's here's what's don't doesn't didn't isn't wasn't you're you'll"
  ).split(" "),
);

/** Lower-case word tokens (apostrophes kept: "don't"). */
export function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .split(/[^a-z0-9$%'.]+/)
    .map((t) => t.replace(/^[.']+|[.']+$/g, ""))
    .filter(Boolean);
}

export function stem(w: string): string {
  return w
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .replace(/(ings|ing|edly|ed|es|s|ly)$/, "")
    .replace(/(.)\1$/, "$1");
}

/** Content stems (stop words dropped). */
export function contentStems(s: string): string[] {
  return tokens(s)
    .filter((t) => !STOP_WORDS.has(t))
    .map(stem)
    .filter((t) => t.length > 1);
}

export function jaccard(a: string[], b: string[]): number {
  const A = new Set(a);
  const B = new Set(b);
  if (A.size === 0 && B.size === 0) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** Deterministic fallback vectors: hashed content stems (+ bigrams) into 256 dims. */
export function lexicalVector(text: string): number[] {
  const v = new Array<number>(256).fill(0);
  const words = contentStems(text);
  const add = (tok: string, weight: number) => {
    let h = 2166136261;
    for (let i = 0; i < tok.length; i++) h = Math.imul(h ^ tok.charCodeAt(i), 16777619);
    v[Math.abs(h) % 256]! += weight;
  };
  words.forEach((w, i) => {
    add(w, 1);
    if (i > 0) add(`${words[i - 1]}_${w}`, 0.5);
  });
  return v;
}

/** Structural twin of the studio's `TextEmbedder` (packages/agents studio/meaning-match.ts). */
export interface FullEditEmbedder {
  readonly id: string;
  /** Similarity bands: ≥ match → clearly about the same thing, < weak → unrelated. */
  readonly thresholds: { match: number; weak: number };
  embed(texts: string[]): Promise<number[][]>;
}

/** The pure fallback (no model): hashed word stems. Worse at synonyms; labelled by its id. */
export const LEXICAL_EMBEDDER: FullEditEmbedder = {
  id: "lexical-hash-v1",
  thresholds: { match: 0.3, weak: 0.1 },
  embed: async (texts) => texts.map(lexicalVector),
};

export function capitalizeFirst(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

/** Strips Whisper punctuation from a word for matching ("raise," → "raise"). */
export function bare(w: string): string {
  return w.toLowerCase().replace(/[’‘]/g, "'").replace(/^[^a-z0-9$]+|[^a-z0-9%']+$/g, "");
}

/** FNV-1a 32-bit, hex. */
export function hashString(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
