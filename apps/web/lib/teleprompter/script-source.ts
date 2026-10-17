/**
 * Teleprompter script source (pure, no AI, no I/O). Picks what Chris reads while filming:
 *   1. the video's latest script version (what the Script step / Chris's own edit produced),
 *   2. else the Creator Card (hook + talking points — "only what Chris needs to film"),
 *   3. else the imported plan's hook + notes (ContentItem.description, "Hook: …\n\nnotes"),
 *   4. else nothing → the screen offers a box to paste/type.
 * See docs/decisions-pending/teleprompter.md.
 */

export type PrompterSourceKind = "script" | "card" | "plan" | "none";

export interface PrompterSource {
  kind: PrompterSourceKind;
  /** Plain-language label shown above the text ("Your script (v3)"). */
  label: string;
  text: string;
}

export interface PrompterInputs {
  /** Newest first (as getContentItem returns them). Only the first one is used. */
  scriptVersions?: ReadonlyArray<{ spokenScript: string; authorType?: string | null }>;
  scriptVersionCount?: number;
  creatorCard?: { hook: string; talkingPoints: unknown; notes?: string | null } | null;
  description?: string | null;
}

/** Imported plan items keep "Hook: …" as the description's first paragraph (plannedDescription). */
export function splitPlanDescription(d: string | null | undefined): { hook: string | null; notes: string | null } {
  if (!d) return { hook: null, notes: null };
  const m = /^Hook: (.*)(?:\n\n([\s\S]*))?$/.exec(d);
  if (m) return { hook: m[1]!.trim() || null, notes: m[2]?.trim() || null };
  return { hook: null, notes: d.trim() || null };
}

/** Normalizes whitespace for reading: keeps paragraph breaks, collapses runs of spaces. */
export function cleanPrompterText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function pickPrompterSource(input: PrompterInputs): PrompterSource {
  const latest = input.scriptVersions?.[0];
  if (latest && latest.spokenScript.trim()) {
    const n = input.scriptVersionCount ?? input.scriptVersions!.length;
    return {
      kind: "script",
      label: `Your script${n > 1 ? ` (v${n}${latest.authorType === "HUMAN" ? ", your edit" : ""})` : latest.authorType === "HUMAN" ? " (your edit)" : ""}`,
      text: cleanPrompterText(latest.spokenScript),
    };
  }
  const card = input.creatorCard;
  if (card && (card.hook.trim() || (Array.isArray(card.talkingPoints) && card.talkingPoints.length))) {
    const points = Array.isArray(card.talkingPoints) ? card.talkingPoints.filter((p): p is string => typeof p === "string" && !!p.trim()) : [];
    const parts = [card.hook.trim(), ...points.map((p) => `• ${p.trim()}`)];
    if (card.notes?.trim()) parts.push(card.notes.trim());
    return { kind: "card", label: "Your shot notes (hook + talking points)", text: cleanPrompterText(parts.filter(Boolean).join("\n\n")) };
  }
  const { hook, notes } = splitPlanDescription(input.description);
  if (hook || notes) {
    return { kind: "plan", label: "From your plan (hook + notes)", text: cleanPrompterText([hook, notes].filter(Boolean).join("\n\n")) };
  }
  return { kind: "none", label: "No script yet — type or paste one", text: "" };
}

/** Small, stable fingerprint of the source text so a saved per-video edit is dropped once the
 * underlying script changes (a new script version wins over an old local tweak). */
export function textFingerprint(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${text.length.toString(36)}-${(h >>> 0).toString(36)}`;
}

/** A local (this phone) prompter edit, valid only while the source is unchanged. */
export interface SavedPrompterEdit {
  base: string;
  text: string;
}

export function resolveSavedEdit(source: PrompterSource, saved: SavedPrompterEdit | null | undefined): { text: string; edited: boolean } {
  if (saved && saved.base === textFingerprint(source.text) && typeof saved.text === "string" && saved.text !== source.text) {
    return { text: saved.text, edited: true };
  }
  return { text: source.text, edited: false };
}

/** Title for a brand-new video filmed with the prompter: typed title, else the first words. */
export function titleForNewVideo(typed: string, script: string): string {
  if (typed.trim()) return typed.trim().slice(0, 140);
  const words = script.replace(/[•\n]+/g, " ").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "New video";
  const t = words.slice(0, 8).join(" ").replace(/[,;:.!?-]+$/, "");
  return words.length > 8 ? `${t}…` : t;
}
