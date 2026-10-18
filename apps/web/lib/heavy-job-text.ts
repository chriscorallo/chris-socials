/**
 * Plain-English wording for heavy jobs (client-safe: no Node imports). Shared by the job API
 * (GET /api/jobs/[id]) and the progress UI so every screen says the same thing.
 */

export const HEAVY_JOB_TITLE: Record<string, string> = {
  render: "Rendering your video",
  "quality-gate": "Running the quality check",
  "auto-repair": "Fixing and re-rendering",
  transcribe: "Transcribing your takes",
  "subject-track": "Finding you in the frame",
  "person-matte": "Cutting you out for graphics behind you",
  ingest: "Analyzing your footage",
  "motion-design": "Designing visuals",
  "reference-analyze": "Measuring your reference videos",
  "viewer-review": "Watching it like a new viewer",
};

/** "Rendering your video… 40%" */
export function progressLine(kind: string | null | undefined, message: string | null | undefined, pct: number | null | undefined): string {
  const base = (message && message.trim()) || `${HEAVY_JOB_TITLE[kind ?? ""] ?? "Working"}…`;
  return pct != null && pct > 0 && pct < 100 ? `${base.replace(/…?$/, "…")} ${Math.round(pct)}%` : base;
}

/**
 * A job failure as a sentence Chris can act on. `errorName` is the original error's class
 * (e.g. SpendCapExceededError) when the worker recorded it.
 */
export function plainJobError(raw: string | null | undefined, errorName?: string | null): string {
  const msg = (raw ?? "").trim();
  if (errorName === "SpendCapExceededError" || /spend ?cap|spending limit/i.test(msg)) {
    return "Today's AI spending limit has been reached, so the AI step couldn't run. Your work is saved — try again tomorrow, or raise MODEL_SPEND_DAILY_CAP_USD.";
  }
  if (/credit balance|billing|insufficient/i.test(msg)) {
    return "The AI account is out of credit. Your work is saved — add credit (More → AI credit) and try again.";
  }
  if (/api[_ ]?key|authentication|x-api-key|ANTHROPIC|401/i.test(msg)) {
    return "This step needs the AI service, which isn't set up (no Anthropic API key). Your work is saved.";
  }
  if (/ran out of time|SIGTERM|timed out|stopped responding/i.test(msg)) {
    return "The cloud worker ran out of time before finishing. Your work is saved — try again (a very long video may need a longer limit).";
  }
  if (!msg) return "Something went wrong in the cloud worker. Your work is saved — try again.";
  return msg.length > 400 ? `${msg.slice(0, 400)}…` : msg;
}
