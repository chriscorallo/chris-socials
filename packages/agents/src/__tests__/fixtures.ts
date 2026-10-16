import type { ProductionContract } from "@chris/domain";
import type {
  ResearchPacket,
  ClaimsGateResult,
  ScriptVersion,
  BrandGuardianReport,
  ReferenceIntelligenceResult,
  WeeklyProgrammingThesisOutput,
  PortfolioAllocationResult,
} from "../schemas";
import type { BacklogItemSummary } from "../backlog-summary";

export function fixtureContract(overrides: Partial<ProductionContract> = {}): ProductionContract {
  return {
    id: "contract-1",
    contentItemId: "item-1",
    purpose: "Acquisition",
    primaryIdea: "Your credit score can drop right after you pay off a card — here's why",
    audiencePromise: "You'll know why this happens and that it's not a mistake",
    topic: "Credit",
    format: "Talking head",
    productionTier: "FAST",
    targetLengthMinSeconds: 30,
    targetLengthMaxSeconds: 60,
    researchDepth: "LIGHT",
    factualRisk: "MEDIUM",
    experiment: null,
    platformOpportunities: ["instagram", "tiktok"],
    humanEditingBudgetMinutes: 15,
    requiredAssets: [],
    scope: "Explain utilization ratio and average account age effects only.",
    doNotExpandInto: "Do not get into how credit scoring models are built.",
    createdAt: new Date("2026-09-01T00:00:00Z"),
    ...overrides,
  };
}

export function fixtureResearchPacket(overrides: Partial<ResearchPacket> = {}): ResearchPacket {
  return {
    primaryClaim:
      "Paying off a credit card can temporarily lower your utilization-driven score boost and shift your average account age, which can drop your score even though you did something financially healthy.",
    facts: [
      { statement: "Credit utilization is a scoring factor.", type: "FACT", sourceUrl: "https://www.myfico.com/credit-education/whats-in-your-credit-score" },
      { statement: "Closing the account after payoff affects average account age.", type: "FACT", sourceUrl: "https://www.myfico.com/credit-education/whats-in-your-credit-score" },
    ],
    citations: [
      {
        url: "https://www.myfico.com/credit-education/whats-in-your-credit-score",
        title: "What's in my FICO Scores?",
        publisher: "myFICO",
        publishedOrEffectiveDate: null,
        accessedDate: "2026-10-16",
        isPrimarySource: true,
      },
    ],
    numericInputs: [],
    calculationNotes: null,
    caveats: ["Effect size varies by scoring model and existing credit history."],
    confidence: 0.75,
    contradictoryEvidence: [],
    prohibitedClaims: ["Do not claim payoff always lowers score — it does not."],
    contentSafeWording: "paying off a card can sometimes cause a small temporary dip",
    status: "READY",
    stopResearching: true,
    ...overrides,
  };
}

export function fixtureClaimsGateResult(
  overrides: Partial<ClaimsGateResult> = {},
): ClaimsGateResult {
  return {
    claims: [
      {
        claimText: "Paying off a card can cause a temporary score dip",
        sourceSupport: "myfico.com scoring factors",
        evidenceStrength: "STRONG",
        freshnessConcern: false,
        numericConsistency: true,
        omittedCaveatRisk: false,
        overstatesEvidence: false,
      },
    ],
    result: "PASS",
    requiredEdits: [],
    blockReason: null,
    ...overrides,
  };
}

export function fixtureScriptVersion(overrides: Partial<ScriptVersion> = {}): ScriptVersion {
  return {
    spokenScript:
      "Okay, you just paid off a credit card. Score should go up, right? Sometimes it drops instead...",
    beats: [{ label: "HOOK", text: "You just paid off a credit card and your score dropped." }],
    intendedPauses: ["after the hook"],
    emphasizedWords: ["dropped"],
    visualBeats: [],
    requiredFactualCaveats: ["Effect size varies by scoring model."],
    targetRuntimeSeconds: 45,
    estimatedSpeakingRuntimeSeconds: 42,
    followUpIdeas: ["Why does average account age matter so much?"],
    ...overrides,
  };
}

export function fixtureBrandGuardianReport(
  overrides: Partial<BrandGuardianReport> = {},
): BrandGuardianReport {
  return {
    brandScore: 82,
    voiceScore: 88,
    originalityScore: 75,
    strategicFit: "Fits the acquisition wedge — finance topic, plain-English framing.",
    risks: [],
    requiredChanges: [],
    optionalImprovements: ["Could open with a sharper dollar-specific hook."],
    ...overrides,
  };
}

export function fixtureBacklog(): BacklogItemSummary[] {
  return [
    { id: "idea-1", title: "Why your score drops after payoff", pillar: "SKILL" },
    { id: "idea-2", title: "What I actually spend in LA in a week", pillar: "LIFESTYLE" },
  ];
}

export function fixtureReferenceIntelligenceResult(
  overrides: Partial<ReferenceIntelligenceResult> = {},
): ReferenceIntelligenceResult {
  return {
    observations: [
      {
        observed: "Dollar-figure hook in the first two seconds across several videos.",
        likelyPrinciple: "Concrete numbers may earn attention faster than abstract framing.",
        transferabilityToChris: "High — matches the existing evidence-over-folklore principle.",
        reason: "Present across multiple strong-performing examples.",
        risks: ["Could feel gimmicky if overused"],
        testRequired: "A/B a dollar-figure hook against a question hook on two similar topics.",
        confidence: 0.6,
      },
    ],
    ...overrides,
  };
}

export function fixtureWeeklyThesis(
  overrides: Partial<WeeklyProgrammingThesisOutput> = {},
): WeeklyProgrammingThesisOutput {
  return {
    thesis:
      "Continue finance acquisition while increasing personality exposure; avoid excessive retirement repetition.",
    primaryObjectives: ["Grow follower conversion from finance content"],
    activeExperiments: ["Dollar-figure hook vs. question hook"],
    areasToExploit: ["Debt/credit topics"],
    areasToExplore: ["LA life / build-in-public content"],
    areasToReduce: ["Retirement topics (recently over-represented)"],
    risks: ["Becoming 'Debt Guy' if concentration continues unchecked"],
    contentGaps: ["No personality-only video this week yet"],
    productionConstraints: ["~5 hours/week human editing budget"],
    humanDecisionsNeeded: ["No performance data available yet — confirm topic mix with Chris"],
    ...overrides,
  };
}

export function fixturePortfolioAllocation(
  overrides: Partial<PortfolioAllocationResult> = {},
): PortfolioAllocationResult {
  return {
    items: [
      {
        contentItemId: "idea-1",
        purpose: "Acquisition",
        pillar: "SKILL",
        topic: "Credit",
        subtopic: "Utilization",
        format: "Talking head",
        productionTier: "FAST",
        targetLengthSeconds: 45,
        primaryHypothesis: "Dollar-specific hooks convert better than abstract ones",
        historicalAnalogue: null,
        referenceInfluence: "Dollar-figure hook pattern (Jun Yuh) — see reference intelligence",
        whyThisWeek: "Fits this week's acquisition focus",
        duplicateRisk: null,
        researchBurden: "Light",
        productionBurden: "Low",
        selected: true,
      },
    ],
    proposedNewIdeas: [],
    ...overrides,
  };
}
