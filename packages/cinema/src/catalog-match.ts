import { resolveTranscriptionCacheDir } from "@chris/media/transcription";
import { VISUAL_CATALOG, catalogEntryText, searchCatalog, type CatalogEntry, type CatalogEntryType } from "./catalog";

/**
 * Meaning-Match: ranks catalog entries for a narration line with a small LOCAL sentence-embedding
 * model — $0, no API, runs in Node / the Sandbox / Chris's Mac.
 *
 * Model: sentence-transformers/all-MiniLM-L6-v2 (Apache-2.0), ONNX export Xenova/all-MiniLM-L6-v2,
 * q8 (~23 MB), via @huggingface/transformers (already a dependency for Whisper/Kokoro). Downloaded
 * once into the same cache as Whisper (TRANSCRIPTION_CACHE_DIR); the Sandbox snapshot's warmup
 * pre-downloads it.
 *
 * Score: for each entry, the best cosine similarity between the line and (a) the entry's full
 * description and (b) each of its "good for" phrases — so "you raised your baseline" lands on
 * the phrase it literally matches — blended with the deterministic keyword score (15 %).
 */

export const CATALOG_EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";

type Extractor = (texts: string[], opts: { pooling: "mean"; normalize: boolean }) => Promise<{ data: Float32Array; dims: number[] }>;

let extractorPromise: Promise<Extractor> | null = null;

async function getExtractor(cacheDir?: string): Promise<Extractor> {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      const { env, pipeline } = await import("@huggingface/transformers");
      env.cacheDir = resolveTranscriptionCacheDir(cacheDir);
      return (await pipeline("feature-extraction", CATALOG_EMBEDDING_MODEL, { dtype: "q8", device: "cpu" })) as unknown as Extractor;
    })();
    extractorPromise.catch(() => (extractorPromise = null));
  }
  return extractorPromise;
}

/** Unit-length sentence embeddings (384-d). */
export async function embedTexts(texts: string[], opts: { cacheDir?: string } = {}): Promise<Float32Array[]> {
  if (!texts.length) return [];
  const ex = await getExtractor(opts.cacheDir);
  const out: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += 64) {
    const batch = texts.slice(i, i + 64);
    const r = await ex(batch, { pooling: "mean", normalize: true });
    const d = r.dims[r.dims.length - 1]!;
    for (let k = 0; k < batch.length; k++) out.push(r.data.slice(k * d, (k + 1) * d));
  }
  return out;
}

const dot = (a: Float32Array, b: Float32Array) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
};

interface Index {
  entries: CatalogEntry[];
  text: Float32Array[];
  phrases: Array<{ entry: number; vec: Float32Array; phrase: string }>;
}
let indexPromise: Promise<Index> | null = null;

async function catalogIndex(cacheDir?: string): Promise<Index> {
  if (!indexPromise) {
    indexPromise = (async () => {
      const entries = VISUAL_CATALOG;
      const text = await embedTexts(entries.map(catalogEntryText), { cacheDir });
      const flat = entries.flatMap((e, i) => e.goodFor.map((p) => ({ entry: i, phrase: p })));
      const vecs = await embedTexts(flat.map((f) => f.phrase), { cacheDir });
      return { entries, text, phrases: flat.map((f, k) => ({ ...f, vec: vecs[k]! })) };
    })();
    indexPromise.catch(() => (indexPromise = null));
  }
  return indexPromise;
}

export interface CatalogMatch {
  entry: CatalogEntry;
  /** Combined score 0..1 (rank by this). */
  score: number;
  /** Best cosine similarity (description or a good-for phrase). */
  semantic: number;
  /** The good-for phrase that matched best (why it was picked). */
  matchedPhrase: string | null;
  keyword: number;
}

export async function matchLineToCatalog(line: string, opts: { limit?: number; types?: CatalogEntryType[]; cacheDir?: string } = {}): Promise<CatalogMatch[]> {
  const idx = await catalogIndex(opts.cacheDir);
  const [q] = await embedTexts([line], { cacheDir: opts.cacheDir });
  const kw = new Map(searchCatalog(line, { limit: 1000 }).map((r) => [r.entry.id, r.score]));
  const best = idx.entries.map((e, i) => ({ sem: dot(q!, idx.text[i]!), phrase: null as string | null }));
  for (const p of idx.phrases) {
    const s = dot(q!, p.vec);
    if (s > best[p.entry]!.sem) best[p.entry] = { sem: s, phrase: p.phrase };
  }
  const out: CatalogMatch[] = idx.entries.map((entry, i) => {
    const k = kw.get(entry.id) ?? 0;
    const semantic = Math.max(0, best[i]!.sem);
    const recipe = entry.type === "RECIPE" ? 0.03 : 0;
    return { entry, semantic: r3(semantic), matchedPhrase: best[i]!.phrase, keyword: k, score: r3(Math.min(1, 0.85 * semantic + 0.15 * Math.min(1, k / 6) + recipe)) };
  });
  return out
    .filter((m) => !opts.types || opts.types.includes(m.entry.type))
    .sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id))
    .slice(0, opts.limit ?? 8);
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;

/** Downloads + loads the model (snapshot warmup). */
export async function warmCatalogMatcher(cacheDir?: string): Promise<{ model: string; entries: number }> {
  const idx = await catalogIndex(cacheDir);
  return { model: CATALOG_EMBEDDING_MODEL, entries: idx.entries.length };
}
