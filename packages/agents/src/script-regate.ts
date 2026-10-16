import type { ResearchPacket as ResearchPacketRow } from "@chris/domain";
import { scopeProvider, type ModelProvider } from "./model-provider";
import { runClaimsGateAgent } from "./claims-gate-agent";
import { runBrandGuardianAgent } from "./brand-guardian-agent";
import type { BrandGuardianReport, ClaimsGateResult, ResearchPacket } from "./schemas";

/**
 * Re-runs the hard factual gate (and Brand Guardian) on a HUMAN-edited script before it may be
 * filmed. Brand Guardian is skipped on a BLOCK — a factual failure must be fixed first, and
 * the brand read would be wasted spend. Persist with packages/domain recordScriptRegate.
 */
export async function regateEditedScript(
  provider: ModelProvider,
  input: {
    research: ResearchPacket;
    spokenScript: string;
    requiredFactualCaveats?: string[];
    brandContext: string;
    contentItemId?: string;
  },
): Promise<{ scriptClaimsGateResult: ClaimsGateResult; brandGuardianReport: BrandGuardianReport | null }> {
  const scoped = input.contentItemId ? scopeProvider(provider, { contentItemId: input.contentItemId }) : provider;
  const scriptClaimsGateResult = await runClaimsGateAgent(scoped, {
    research: input.research,
    brandContext: input.brandContext,
    script: { spokenScript: input.spokenScript, requiredFactualCaveats: input.requiredFactualCaveats },
  });
  if (scriptClaimsGateResult.result === "BLOCK") {
    return { scriptClaimsGateResult, brandGuardianReport: null };
  }
  const brandGuardianReport = await runBrandGuardianAgent(scoped, {
    script: { spokenScript: input.spokenScript },
    brandContext: input.brandContext,
  });
  return { scriptClaimsGateResult, brandGuardianReport };
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.map(String) : [];
}

/**
 * Rebuilds the agent-side ResearchPacket from a persisted row — tolerant of rows written
 * before citations/numeric inputs carried source URLs (old string citations become citations
 * with a URL only when the string is one).
 */
export function researchPacketFromRow(row: ResearchPacketRow): ResearchPacket {
  const facts = (Array.isArray(row.facts) ? row.facts : []) as Array<Record<string, unknown>>;
  const nums = (Array.isArray(row.numericInputs) ? row.numericInputs : []) as Array<Record<string, unknown>>;
  const cites = Array.isArray(row.citations) ? row.citations : [];
  return {
    primaryClaim: row.primaryClaim,
    facts: facts.map((f) => ({
      statement: String(f.statement ?? ""),
      type: (["FACT", "INTERPRETATION", "EXAMPLE", "ASSUMPTION", "UNKNOWN"].includes(String(f.type))
        ? f.type
        : "UNKNOWN") as ResearchPacket["facts"][number]["type"],
      sourceUrl: typeof f.sourceUrl === "string" ? f.sourceUrl : null,
    })),
    citations: cites.map((c) => {
      if (typeof c === "string") {
        return {
          url: /^https?:\/\//.test(c) ? c : null,
          title: c,
          publisher: "",
          publishedOrEffectiveDate: null,
          accessedDate: null,
          isPrimarySource: false,
        };
      }
      const o = c as Record<string, unknown>;
      return {
        url: typeof o.url === "string" ? o.url : null,
        title: String(o.title ?? ""),
        publisher: String(o.publisher ?? ""),
        publishedOrEffectiveDate: typeof o.publishedOrEffectiveDate === "string" ? o.publishedOrEffectiveDate : null,
        accessedDate: typeof o.accessedDate === "string" ? o.accessedDate : null,
        isPrimarySource: o.isPrimarySource === true,
      };
    }),
    numericInputs: nums.map((n) => ({
      label: String(n.label ?? ""),
      value: String(n.value ?? ""),
      sourceUrl: typeof n.sourceUrl === "string" ? n.sourceUrl : null,
      asOfDate: typeof n.asOfDate === "string" ? n.asOfDate : null,
    })),
    calculationNotes: row.calculationNotes,
    caveats: strArray(row.caveats),
    confidence: row.confidence,
    contradictoryEvidence: strArray(row.contradictoryEvidence),
    prohibitedClaims: strArray(row.prohibitedClaims),
    contentSafeWording: row.contentSafeWording,
    status: row.status,
    stopResearching: row.stopResearching,
  };
}
