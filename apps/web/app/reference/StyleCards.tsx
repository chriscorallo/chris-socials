import { describeStyle, sampleSizeText, type StyleLine, type StyleProfile } from "@chris/domain/style-metrics";
import { describeStyleModel, type StyleModel } from "@chris/domain/style-model";

function Lines({ lines, testId }: { lines: StyleLine[]; testId: string }) {
  return (
    <ul className="mt-3 grid gap-2 sm:grid-cols-2" data-testid={testId}>
      {lines.map((l) => (
        <li key={l.key} className="rounded-xl border border-[var(--color-border)] bg-white/[0.03] px-3.5 py-2.5">
          <p className="text-[15.5px] font-semibold leading-snug">{l.text}</p>
          {l.detail && <p className="mt-0.5 text-[12.5px] leading-snug text-[var(--color-text-faint)]">{l.detail}</p>}
        </li>
      ))}
    </ul>
  );
}

/** The style fingerprint in plain English, with an honest sample-size line. */
export function StyleCard({ eyebrow, title, profile }: { eyebrow: string; title: string; profile: StyleProfile }) {
  const lines = describeStyle(profile);
  const early = profile.confidence === "early";
  return (
    <section className="panel p-4 sm:p-5" data-testid="style-card">
      <p className="eyebrow">{eyebrow}</p>
      <h2 className="mt-0.5 text-[19px] font-semibold">{title}</h2>
      <p className={`mt-1 text-[13px] ${early ? "text-[var(--color-gold-400)]" : "text-[var(--color-text-faint)]"}`} data-testid="style-sample">
        {sampleSizeText(profile.sampleSize)}
      </p>
      {lines.length > 0 ? <Lines lines={lines} testId="style-lines" /> : <p className="mt-3 text-[14px] text-[var(--color-text-muted)]">Add a few videos and their style shows up here.</p>}
    </section>
  );
}

export function CompareCard({ lines, takes, refs }: { lines: StyleLine[]; takes: number; refs: number }) {
  if (lines.length === 0) return null;
  return (
    <section className="panel p-4 sm:p-5" data-testid="compare-card">
      <p className="eyebrow">You vs them</p>
      <h2 className="mt-0.5 text-[19px] font-semibold">How your raw takes compare</h2>
      <p className="mt-1 text-[13px] text-[var(--color-text-faint)]">
        Your last {takes} take{takes === 1 ? "" : "s"} (before editing) vs {refs} reference video{refs === 1 ? "" : "s"}
        {refs < 3 ? " — an early read" : ""}.
      </p>
      <Lines lines={lines} testId="compare-lines" />
    </section>
  );
}

/**
 * What the references DO, in one paragraph a creator can agree with (the StyleModel: bands from
 * what a viewer sees and hears, his own hand edits weighted double). Reference learning,
 * docs/PREMIUM_EDITOR_PLAN.md round 4. Measured on-screen text needs videos re-measured with
 * the current version — until then the paragraph covers cuts, pauses and sound only.
 */
export function StyleModelCard({ model, eyebrow = "What they do", title = "Your references, in a paragraph" }: { model: StyleModel; eyebrow?: string; title?: string }) {
  const text = describeStyleModel(model);
  if (!text) return null;
  const screenMeasured = model.headlinesPer10s != null || model.captions.preset != null;
  return (
    <section className="panel p-4 sm:p-5" data-testid="style-model-card">
      <p className="eyebrow">{eyebrow}</p>
      <h2 className="mt-0.5 text-[19px] font-semibold">{title}</h2>
      <p className="mt-2 text-[15px] leading-relaxed">{text}</p>
      {!screenMeasured && <p className="mt-2 text-[13px] text-[var(--color-text-faint)]">On-screen text, captions and punch-ins show up here once the videos are re-measured (the Measure button above).</p>}
      {model.exclusions.length > 0 && <p className="mt-2 text-[13px] text-[var(--color-text-faint)]">Left out on purpose: {model.exclusions.join("; ")}.</p>}
    </section>
  );
}
