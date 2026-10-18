import { resolveTranscriptionCacheDir } from "./transcription/local-whisper";

/**
 * Local sentence embeddings for the Mini-movie Studio's Meaning-Match first pass — $0, CPU,
 * no network after the first download. Default model: `Xenova/all-MiniLM-L6-v2` (sentence-
 * transformers all-MiniLM-L6-v2, Apache-2.0; ONNX q8 ≈ 23 MB), via transformers.js — the same
 * runtime and cache directory the repo's local Whisper already uses (TRANSCRIPTION_CACHE_DIR or
 * <repo>/.cache/transformers). Structurally implements `TextEmbedder` from @chris/agents/studio.
 */

export const DEFAULT_EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";

type Extractor = (texts: string[], opts: { pooling: "mean"; normalize: boolean }) => Promise<{ tolist(): number[][] }>;
const cache = new Map<string, Promise<Extractor>>();

export class LocalSentenceEmbedder {
  readonly id: string;
  /** Calibrated 2026-10-18 on the studio's demo film (line ↔ picture-description cosine): shots that
   * show their line 0.28–0.37; the proof film's flawed baseline shot 0.13 vs 0.37 once fixed;
   * abstract lines with no literal picture ("You didn't just spend the raise.") ≈ 0.05. */
  readonly thresholds = { match: 0.28, weak: 0.12 };
  private readonly model: string;
  private readonly cacheDir: string;
  private readonly offline: boolean;

  constructor(opts: { model?: string; cacheDir?: string; offline?: boolean } = {}) {
    this.model = opts.model ?? process.env.STUDIO_EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL;
    this.cacheDir = resolveTranscriptionCacheDir(opts.cacheDir);
    this.offline = opts.offline ?? false;
    this.id = `local:${this.model.split("/").pop()}`;
  }

  private load(): Promise<Extractor> {
    const key = `${this.model}|${this.cacheDir}`;
    let p = cache.get(key);
    if (!p) {
      p = (async () => {
        const { pipeline, env } = await import("@huggingface/transformers");
        env.cacheDir = this.cacheDir;
        env.allowRemoteModels = !this.offline;
        return (await pipeline("feature-extraction", this.model, { dtype: "q8" })) as unknown as Extractor;
      })();
      p.catch(() => cache.delete(key));
      cache.set(key, p);
    }
    return p;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (!texts.length) return [];
    const extract = await this.load();
    const out = await extract(texts, { pooling: "mean", normalize: true });
    return out.tolist();
  }
}
