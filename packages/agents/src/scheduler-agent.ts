import type { ModelProvider } from "./model-provider";
import { buildSystemPrompt } from "./prompt-context";
import { SchedulerResultSchema, type SchedulerResult } from "./schemas";

export interface ReadyItemSummary {
  contentItemId: string;
  title: string;
  pillar: string | null;
  format: string | null;
}

export interface ScheduleHistoryEntry {
  contentItemId: string;
  scheduledDate: string;
  platforms: string[];
}

export interface PlatformQuotaSummary {
  platform: "INSTAGRAM" | "TIKTOK" | "YOUTUBE";
  note: string; // e.g. "62/100 YouTube uploads used today" — plain text, not a judgment call
}

export class SchedulerInvalidContentItemIdError extends Error {
  constructor(id: string) {
    super(`Scheduler proposed a schedule entry for contentItemId="${id}", which is not one of the READY items it was given.`);
    this.name = "SchedulerInvalidContentItemIdError";
  }
}

function buildUserPrompt(input: {
  readyItems: ReadyItemSummary[];
  history: ScheduleHistoryEntry[];
  quota: PlatformQuotaSummary[];
  brandContext: string;
}): string {
  const itemList = input.readyItems
    .map((i) => `- [${i.contentItemId}] "${i.title}" (pillar: ${i.pillar ?? "unset"}, format: ${i.format ?? "unset"})`)
    .join("\n");
  const historyList =
    input.history.length === 0
      ? "(no recent scheduling history)"
      : input.history.map((h) => `- ${h.scheduledDate}: [${h.contentItemId}] -> ${h.platforms.join(", ")}`).join("\n");
  const quotaList = input.quota.map((q) => `- ${q.platform}: ${q.note}`).join("\n");

  return `${input.brandContext}

## READY items awaiting a schedule slot (reference each by its exact id in brackets)

${itemList}

## Recent scheduling history

${historyList}

## Platform quota/rate-limit state (observations, not permission to ignore — see your instructions)

${quotaList}

## Task

Propose a schedule placement for some or all of the READY items above per your instructions.
contentItemId must be an exact id from the list above — never invent one. scheduledDate must
be a real ISO 8601 timestamp.`;
}

export async function runSchedulerAgent(
  provider: ModelProvider,
  input: {
    readyItems: ReadyItemSummary[];
    history: ScheduleHistoryEntry[];
    quota: PlatformQuotaSummary[];
    brandContext: string;
  },
): Promise<SchedulerResult> {
  if (input.readyItems.length === 0) {
    throw new Error("runSchedulerAgent requires at least one READY item to schedule.");
  }

  const { systemPrompt, modelClass } = buildSystemPrompt("SCHEDULER");
  const result = await provider.completeStructured({
    modelClass,
    systemPrompt,
    userPrompt: buildUserPrompt(input),
    schema: SchedulerResultSchema,
    promptId: "SCHEDULER",
  });

  const validIds = new Set(input.readyItems.map((i) => i.contentItemId));
  for (const proposal of result.output.items) {
    if (!validIds.has(proposal.contentItemId)) {
      throw new SchedulerInvalidContentItemIdError(proposal.contentItemId);
    }
  }

  return result.output;
}
