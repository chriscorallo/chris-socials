import type { ModelProvider } from "./model-provider";
import { contentIntelligenceFor, getAgentPrompt, getSystemBase } from "./prompt-context";
import { PlatformPackageModelOutputSchema, type PlatformPackageOutput } from "./schemas";

export type PackagingPlatform = "INSTAGRAM" | "TIKTOK" | "YOUTUBE";

const PLATFORM_PROMPT_ID: Record<PackagingPlatform, string> = {
  INSTAGRAM: "PLATFORM_PACKAGING_INSTAGRAM",
  TIKTOK: "PLATFORM_PACKAGING_TIKTOK",
  YOUTUBE: "PLATFORM_PACKAGING_YOUTUBE",
};

/**
 * Platform Packaging is the one agent whose prompt is genuinely two files, not one — every
 * platform-specific file's own frontmatter names `PLATFORM_PACKAGING_BASE` as required context
 * (see /prompts/agents/PLATFORM_PACKAGING_{INSTAGRAM,TIKTOK,YOUTUBE}.md). `buildSystemPrompt`
 * (prompt-context.ts) only ever concatenates SYSTEM_BASE with a single named prompt, so this
 * composes the three-way concatenation itself: SYSTEM_BASE + PLATFORM_PACKAGING_BASE + the
 * platform-specific file, in that order — matching the shared-then-specific structure every
 * other multi-file relationship in this registry follows.
 */
function buildPlatformPackagingSystemPrompt(platform: PackagingPlatform): string {
  const base = getAgentPrompt("PLATFORM_PACKAGING_BASE");
  const specific = getAgentPrompt(PLATFORM_PROMPT_ID[platform]);
  return `${getSystemBase()}${contentIntelligenceFor(PLATFORM_PROMPT_ID[platform])}\n\n---\n\n${base.body}\n\n---\n\n${specific.body}`;
}

function buildUserPrompt(input: {
  platform: PackagingPlatform;
  finalTranscript: string;
  brandContext: string;
  creativeBrief?: string | null;
}): string {
  return `${input.brandContext}

## Final Render Transcript (the finished artifact — package this, not the script draft)

${input.finalTranscript}${input.creativeBrief ? `\n\n## Creative brief (what this video is for)\n\n${input.creativeBrief}\n\nThe caption/title/description serve the brief: the series, the chosen hook's promise, and the ending's ONE objective (COMMENT → ask the genuine question; SHARE → give the legitimate reason to send it; FOLLOW → the repeatable reason to return; PUNCHLINE → keep it short and let the line land). Never "like, comment, share and follow".` : ""}

## Task

Package this finished video for ${input.platform} per your instructions above. Put any
platform-specific extras (e.g. YouTube category, pinned-comment text, alt text) in
metadataEntries as {key, value} pairs; leave it empty when there are none.`;
}

export async function runPlatformPackagingAgent(
  provider: ModelProvider,
  input: { platform: PackagingPlatform; finalTranscript: string; brandContext: string; creativeBrief?: string | null },
): Promise<PlatformPackageOutput> {
  const systemPrompt = buildPlatformPackagingSystemPrompt(input.platform);
  const specific = getAgentPrompt(PLATFORM_PROMPT_ID[input.platform]);
  const modelClass = specific.frontmatter.model_class;
  if (modelClass === "DETERMINISTIC") {
    // Every PLATFORM_PACKAGING_* prompt is model_class LOW today — this guard exists so a
    // future prompt-frontmatter edit that mistakenly sets DETERMINISTIC fails loudly here
    // instead of producing a bad request to the model provider, matching buildSystemPrompt's
    // own guard for every other agent.
    throw new Error(`prompt_id "${PLATFORM_PROMPT_ID[input.platform]}" is model_class DETERMINISTIC — it should be plain code, not a model call.`);
  }

  const result = await provider.completeStructured({
    modelClass,
    systemPrompt,
    userPrompt: buildUserPrompt(input),
    schema: PlatformPackageModelOutputSchema,
    promptId: PLATFORM_PROMPT_ID[input.platform],
  });

  const { metadataEntries, ...rest } = result.output;
  return {
    ...rest,
    metadata: metadataEntries.length ? Object.fromEntries(metadataEntries.map((e) => [e.key, e.value])) : null,
  };
}
