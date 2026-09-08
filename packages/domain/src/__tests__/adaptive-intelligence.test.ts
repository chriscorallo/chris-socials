import { describe, it, expect } from "vitest";
import { prisma } from "../prisma";
import { recordEvidenceEntry, listEvidenceEntries } from "../evidence";
import {
  recordTasteFeedback,
  listTasteFeedback,
  recordChrisAcceptanceProbability,
  getLatestAcceptanceProbability,
} from "../taste";
import { createBrandEra, listBrandEras, getCurrentBrandEra, BrandEraStartBeforeCurrentEraError } from "../brand-era";
import {
  createExperiment,
  addExperimentVariant,
  startExperiment,
  concludeExperiment,
  listExperiments,
  ExperimentAlreadyConcludedError,
} from "../experiment";
import { recordWeeklyBrief, getWeeklyBrief } from "../weekly-brief";
import { recordAdversarialCritique, listAdversarialCritiques } from "../adversarial-critique";

describe("Evidence Ledger", () => {
  it("records and lists evidence entries by source type", async () => {
    await recordEvidenceEntry(prisma, {
      statement: "T+7d views for Tuesday posts averaged 20% higher.",
      sourceType: "PERFORMANCE_SNAPSHOT",
      confidence: 0.6,
    });
    const entries = await listEvidenceEntries(prisma, { sourceType: "PERFORMANCE_SNAPSHOT" });
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => e.sourceType === "PERFORMANCE_SNAPSHOT")).toBe(true);
  });
});

describe("Taste Model", () => {
  it("records raw feedback alongside its normalized tag, both preserved", async () => {
    const feedback = await recordTasteFeedback(
      prisma,
      {
        artifactType: "EDIT_PLAN",
        rawFeedback: "this transition is too corny",
        normalizedTag: "too_corny",
      },
      { actorId: "chris" },
    );
    expect(feedback.rawFeedback).toBe("this transition is too corny");
    expect(feedback.normalizedTag).toBe("too_corny");

    const all = await listTasteFeedback(prisma, { normalizedTag: "too_corny" });
    expect(all.some((f) => f.id === feedback.id)).toBe(true);
  });

  it("accumulates ChrisAcceptanceProbability as append-only, latest read wins", async () => {
    await recordChrisAcceptanceProbability(prisma, {
      artifactType: "EDIT_PLAN",
      tag: "too_corny_transitions",
      context: { productionTier: "FAST" },
      probability: 0.3,
      sampleSize: 4,
      generalizes: false,
      confidence: 0.4,
    });
    const second = await recordChrisAcceptanceProbability(prisma, {
      artifactType: "EDIT_PLAN",
      tag: "too_corny_transitions",
      context: { productionTier: "FAST" },
      probability: 0.15,
      sampleSize: 9,
      generalizes: true,
      confidence: 0.7,
    });

    const latest = await getLatestAcceptanceProbability(prisma, "EDIT_PLAN", "too_corny_transitions");
    expect(latest?.id).toBe(second.id);
    expect(latest?.sampleSize).toBe(9);
  });
});

describe("Brand Timeline", () => {
  // BrandEra is a genuinely global singleton-like timeline (only one "current", open-ended
  // era can exist at a time) — unlike almost every other test in this repo, it isn't scoped
  // to a fresh ContentItem, so a fixed *or* `Date.now()`-based literal date can collide with
  // whatever a *previous* run already left as the current era: two real invocations of this
  // suite happening within the same second (routine when iterating) can even see `Date.now()`
  // go backwards relative to the previous run's synthetic future dates. The only genuinely
  // robust base is the real, current global state itself — read whatever era is actually
  // "current" right now and build every synthetic date strictly after it, so correctness
  // never depends on how much real wall-clock time has passed since the last run. See
  // /docs/DECISIONS.md.
  async function safeFutureBase(): Promise<number> {
    const current = await getCurrentBrandEra(prisma);
    const floor = current ? current.startDate.getTime() : Date.now();
    return Math.max(floor, Date.now()) + 60_000; // always at least a minute past both
  }

  it("closes the current era when a new one starts", async () => {
    const base = await safeFutureBase();
    const first = await createBrandEra(
      prisma,
      { name: `Era A ${base}`, startDate: new Date(base), description: "First era." },
      { actorId: "chris" },
    );
    expect(first.endDate).toBeNull();

    const secondStart = new Date(base + 1000);
    const second = await createBrandEra(
      prisma,
      { name: `Era B ${base}`, startDate: secondStart, description: "Second era." },
      { actorId: "chris" },
    );

    const closedFirst = await prisma.brandEra.findUniqueOrThrow({ where: { id: first.id } });
    expect(closedFirst.endDate).toEqual(secondStart);

    const current = await getCurrentBrandEra(prisma);
    expect(current?.id).toBe(second.id);
  });

  it("rejects a new era starting before the current one", async () => {
    const base = await safeFutureBase();
    await createBrandEra(
      prisma,
      { name: `Era C ${base}`, startDate: new Date(base + 2000), description: "x" },
      { actorId: "chris" },
    );
    await expect(
      createBrandEra(
        prisma,
        { name: `Era D ${base}`, startDate: new Date(base + 1500), description: "x" },
        { actorId: "chris" },
      ),
    ).rejects.toBeInstanceOf(BrandEraStartBeforeCurrentEraError);
  });

  it("lists eras in chronological order", async () => {
    const eras = await listBrandEras(prisma);
    for (let i = 1; i < eras.length; i++) {
      expect(eras[i]!.startDate.getTime()).toBeGreaterThanOrEqual(eras[i - 1]!.startDate.getTime());
    }
  });
});

describe("Experiment engine", () => {
  it("creates an experiment with variants and runs it through the real lifecycle", async () => {
    const experiment = await createExperiment(
      prisma,
      {
        hypothesis: "A number-forward hook increases 3s retention over a question hook.",
        confounders: ["Different topics between variants"],
        minSampleSize: 10,
        minDurationDays: 7,
        portfolioMapping: "adjacent",
      },
      { actorId: "chris" },
    );
    expect(experiment.status).toBe("PROPOSED");

    await addExperimentVariant(prisma, {
      experimentId: experiment.id,
      label: "A",
      description: "Number-forward hook.",
    });
    await addExperimentVariant(prisma, {
      experimentId: experiment.id,
      label: "B",
      description: "Question hook.",
    });

    await startExperiment(prisma, experiment.id, { actorId: "chris" });
    const concluded = await concludeExperiment(
      prisma,
      experiment.id,
      { status: "INCONCLUSIVE", conclusion: "Not enough sample yet to distinguish from noise." },
      { actorId: "chris" },
    );
    expect(concluded.status).toBe("INCONCLUSIVE");

    await expect(
      concludeExperiment(prisma, experiment.id, { status: "CONCLUDED", conclusion: "x" }, { actorId: "chris" }),
    ).rejects.toBeInstanceOf(ExperimentAlreadyConcludedError);

    const withVariants = await listExperiments(prisma, { status: "INCONCLUSIVE" });
    const found = withVariants.find((e) => e.id === experiment.id);
    expect(found?.variants).toHaveLength(2);
  });
});

describe("Weekly Brief", () => {
  it("upserts per week — a re-run the same week replaces, not duplicates", async () => {
    const weekStartDate = new Date(Date.now() + 1000 * 60 * 60 * 24 * 365 * 5); // far future, unique
    await recordWeeklyBrief(
      prisma,
      {
        weekStartDate,
        whatHappened: "First draft.",
        whatItMeans: "x",
        stillUncertain: ["a"],
        recommendationsForNextWeek: ["b"],
      },
      { actorId: "chris" },
    );
    await recordWeeklyBrief(
      prisma,
      {
        weekStartDate,
        whatHappened: "Revised after more data came in.",
        whatItMeans: "y",
        stillUncertain: [],
        recommendationsForNextWeek: ["c", "d"],
      },
      { actorId: "chris" },
    );

    const brief = await getWeeklyBrief(prisma, weekStartDate);
    expect(brief?.whatHappened).toBe("Revised after more data came in.");
    const count = await prisma.weeklyBrief.count({ where: { weekStartDate } });
    expect(count).toBe(1);
  });
});

describe("Adversarial Critique", () => {
  it("persists a real critique with concerns", async () => {
    const critique = await recordAdversarialCritique(
      prisma,
      {
        artifactType: "SCRIPT",
        artifactId: "some-script-id",
        concerns: [
          { description: "Claim overstates the source study.", whyItMatters: "Factual risk.", evidence: "Source says correlation, script implies causation." },
        ],
        noMaterialWeaknessesFound: false,
      },
      { actorId: "chris" },
    );
    expect(critique.noMaterialWeaknessesFound).toBe(false);

    const all = await listAdversarialCritiques(prisma);
    expect(all.some((c) => c.id === critique.id)).toBe(true);
  });

  it("allows a clean 'no material weaknesses found' result — not padded with nitpicks", async () => {
    const critique = await recordAdversarialCritique(
      prisma,
      { artifactType: "SCRIPT", artifactId: "another-script-id", concerns: [], noMaterialWeaknessesFound: true },
      { actorId: "chris" },
    );
    expect(critique.concerns).toEqual([]);
    expect(critique.noMaterialWeaknessesFound).toBe(true);
  });
});
