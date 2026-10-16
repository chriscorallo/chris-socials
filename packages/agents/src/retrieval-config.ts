import type { ModelToolOptions } from "./model-provider";

/**
 * Web retrieval for factual agents (Research, Claims Gate). Without it, facts and citations
 * come from model memory — unacceptable for finance content whose limits change yearly.
 *
 * Env (all optional):
 * - RESEARCH_WEB_SEARCH=on|off           (default on) master switch for Research + Claims Gate
 * - RESEARCH_WEB_SEARCH_MAX_USES=N       (default 5) searches per Research call
 * - CLAIMS_GATE_WEB_SEARCH_MAX_USES=N    (default 3) searches per Claims Gate call
 * - RESEARCH_WEB_FETCH_MAX_USES=N        (default 3) page fetches per call (primary-source pages)
 *
 * Budget: web search is $0.01/search (pricing.ts), so the defaults cap retrieval at ~$0.05 per
 * Research call and ~$0.03 per Claims Gate call on top of tokens.
 */
export type RetrievalRole = "RESEARCH" | "CLAIMS_GATE";

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

export function isWebRetrievalEnabled(): boolean {
  return (process.env.RESEARCH_WEB_SEARCH ?? "on").toLowerCase() !== "off";
}

export function getRetrievalTools(role: RetrievalRole): ModelToolOptions | undefined {
  if (!isWebRetrievalEnabled()) return undefined;
  const searchUses =
    role === "RESEARCH" ? intEnv("RESEARCH_WEB_SEARCH_MAX_USES", 5) : intEnv("CLAIMS_GATE_WEB_SEARCH_MAX_USES", 3);
  const fetchUses = intEnv("RESEARCH_WEB_FETCH_MAX_USES", 3);
  return { webSearch: { maxUses: searchUses }, webFetch: { maxUses: fetchUses } };
}

/** Appended to factual prompts so the model knows whether it can (and must) retrieve. */
export function retrievalInstruction(tools: ModelToolOptions | undefined): string {
  if (!tools?.webSearch) {
    return `## Retrieval

Web retrieval is OFF for this run. You cannot verify current figures. Do not present any
number, limit, rate, or rule as current unless it is in the material provided to you; set
sourceUrl/url to null for anything you cannot source and say so explicitly. Prefer
NEEDS_MORE_RESEARCH (or BLOCK, for the Claims Gate) over unsourced certainty.`;
  }
  return `## Retrieval

You have web search (up to ${tools.webSearch.maxUses} searches) and web fetch (up to
${tools.webFetch?.maxUses ?? 0} fetches). Use them — do not answer from memory for anything
that can change (limits, rates, thresholds, dates, rules). Prefer primary sources: irs.gov,
ssa.gov, federalreserve.gov, bls.gov, treasury.gov, consumerfinance.gov, sec.gov,
investor.gov, finra.org, fdic.gov, the statute or the official notice itself. Use secondary
sources only to locate a primary one, and say so when you could not reach the primary.
Every URL you cite must be a page you actually retrieved in this session — never reconstruct
a URL from memory. Record the source's own publication/effective date and today's access date.`;
}
