import { prisma, isEnabled } from "@chris/domain";
import { getBrandContextText } from "@chris/agents";
import { FakeFilmEngine, FallbackEmbedder, OllamaModelProvider, PrismaFilmStore, type StudioDeps, type TextEmbedder } from "@chris/agents/studio";
import { CinemaFilmEngine, STUDIO_VOICES } from "./cinema-engine";
import { heavyFilmDispatch } from "./heavy-dispatch";

/**
 * SERVER-ONLY. Builds the studio's dependencies. $0 by construction: no Anthropic provider is
 * ever constructed here — the crew's creative steps are ChatGPT round trips (Chris pastes), or the
 * optional local model (feature flag `studio.local_ai` + STUDIO_LOCAL_AI_URL, off by default).
 *
 * Dev-only switches (refused on Vercel): STUDIO_FAKE_ENGINE=1 — sketch storyboards and a fake
 * render so the whole flow can be exercised without the engine's heavy jobs; STUDIO_DEMO_CREW=1 —
 * a "Fill with the demo answer" button standing in for ChatGPT in local testing.
 */

export const LOCAL_AI_FLAG = "studio.local_ai";

const onVercel = () => !!process.env.VERCEL;
export const fakeEngineOn = () => !onVercel() && process.env.STUDIO_FAKE_ENGINE === "1";
export const demoCrewOn = () => !onVercel() && process.env.STUDIO_DEMO_CREW === "1";

let embedder: TextEmbedder | null = null;
async function getEmbedder(): Promise<TextEmbedder> {
  if (!embedder) {
    if (process.env.STUDIO_EMBEDDINGS === "lexical") {
      const { LexicalEmbedder } = await import("@chris/agents/studio");
      embedder = new LexicalEmbedder();
    } else {
      const { LocalSentenceEmbedder } = await import("@chris/media/embeddings");
      embedder = new FallbackEmbedder(new LocalSentenceEmbedder());
    }
  }
  return embedder;
}

let fake: FakeFilmEngine | null = null;

export async function localAiStatus(): Promise<{ on: boolean; url: string | null }> {
  const url = process.env.STUDIO_LOCAL_AI_URL || null;
  const flag = await isEnabled(prisma, LOCAL_AI_FLAG).catch(() => false);
  return { on: flag && !!url, url };
}

export async function getStudioDeps(actorId: string): Promise<StudioDeps> {
  const store = new PrismaFilmStore(prisma);
  const real = new CinemaFilmEngine(heavyFilmDispatch(actorId));
  const engine = fakeEngineOn()
    ? (fake ??= new FakeFilmEngine({ validate: (d) => real.validateFilm(d), formatIssues: (i) => real.formatIssues(i), voices: STUDIO_VOICES, pollsToFinish: 2, videoUrl: process.env.STUDIO_FAKE_VIDEO_URL ?? null }))
    : real;
  const local = await localAiStatus();
  const brandContext = await getBrandContextText(prisma).catch(() => null);
  return {
    store,
    engine,
    embedder: await getEmbedder(),
    localAi: local.on ? new OllamaModelProvider({ baseUrl: local.url!, textModel: process.env.STUDIO_LOCAL_TEXT_MODEL, visionModel: process.env.STUDIO_LOCAL_VISION_MODEL }) : null,
    brandContext,
    worker: `web-${process.pid}`,
  };
}
