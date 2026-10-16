import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PrismaClient } from "@chris/domain";
import { getCurrentBrandConstitution, getCurrentBrandMemory } from "@chris/domain";
import { REPO_ROOT } from "./prompt-context";

const VOICE_SAMPLES_PATH = join(REPO_ROOT, "brand", "VOICE_SAMPLES.md");
const SAMPLES_RE = /<!-- SAMPLES START -->([\s\S]*?)<!-- SAMPLES END -->/;

/**
 * Real Chris transcripts from /brand/VOICE_SAMPLES.md — only the text between the SAMPLES
 * markers, and only when Chris has actually filled it. Returns "" for the shipped empty
 * scaffold or a missing file (a serverless bundle that didn't trace the file degrades to "no
 * samples", never to an error). `path` is injectable for tests.
 */
export function getVoiceSamplesText(path: string = VOICE_SAMPLES_PATH): string {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return "";
  }
  const inner = SAMPLES_RE.exec(raw)?.[1] ?? "";
  // HTML comments inside the region are authoring notes, not samples.
  return inner.replace(/<!--[\s\S]*?-->/g, "").trim();
}

/**
 * Fetches the live Brand Constitution + Chris Brain content (+ voice samples when present)
 * for grounding a model call. Every specialist prompt requires this per SYSTEM_BASE.md — this
 * is where the *content* (not just the instruction to use it) actually gets supplied. Agents
 * pass it as `stableContext` so the provider can prompt-cache it across calls.
 *
 * Sequential, not Promise.all — see /docs/DECISIONS.md ("the PGlite dev database can't
 * handle concurrently dispatched queries"). Real Postgres would handle either fine.
 */
export async function getBrandContextText(prisma: PrismaClient): Promise<string> {
  const constitution = await getCurrentBrandConstitution(prisma);
  const chrisBrain = await getCurrentBrandMemory(prisma, "CHRIS_BRAIN");

  const parts: string[] = [];
  if (constitution) {
    parts.push(`## Brand Constitution (v${constitution.version})\n\n${constitution.content}`);
  }
  if (chrisBrain) {
    parts.push(`## Chris Brain (v${chrisBrain.version})\n\n${chrisBrain.content}`);
  }
  const samples = getVoiceSamplesText();
  if (samples) {
    parts.push(
      `## Chris Voice Samples (real transcripts — how Chris actually talks; imitate the voice, never copy lines; any sample labelled NOT ME is a counter-example)\n\n${samples}`,
    );
  }
  return parts.join("\n\n---\n\n");
}
