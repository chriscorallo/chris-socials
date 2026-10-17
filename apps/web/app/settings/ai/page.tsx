import { prisma, getAiSpendOverview } from "@chris/domain";
import { requireSession } from "../../../lib/session";
import { resolveDailyCapUsd } from "../../../lib/model-provider";
import { NavBar } from "../../components/NavBar";
import { PageShell, PageHeader, Panel } from "../../components/ui";

// AI credit — what the AI has cost and one tap to top up. Anthropic has no API for buying
// credit, so the app can't take payment itself (money paid here would never reach Anthropic);
// "Add credit" opens Anthropic's own billing page instead. See /docs/DECISIONS.md ("AI credit
// screen").
const BILLING_URL = "https://console.anthropic.com/settings/billing";

const usd = (n: number) => (n > 0 && n < 0.01 ? "<$0.01" : `$${n.toFixed(2)}`);

export default async function AiCreditPage() {
  await requireSession();
  const now = new Date();
  const o = await getAiSpendOverview(prisma, now);
  const keySet = Boolean(process.env.ANTHROPIC_API_KEY);
  let cap: number | null;
  try {
    cap = resolveDailyCapUsd();
  } catch {
    cap = null;
  }
  const capPct = cap ? Math.min(100, Math.round((o.todayUsd / cap) * 100)) : 0;

  const status = !keySet
    ? { tone: "warn", title: "AI is off", body: "No Anthropic key is set up on the server yet." }
    : o.creditError
      ? { tone: "bad", title: "AI is out of credit", body: "Research, scripts, AI edits and fact-checks are paused. Add credit and they start working again — nothing else is affected." }
      : o.lastSuccessAt
        ? { tone: "good", title: "AI is working", body: `Last used ${o.lastSuccessAt.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}.` }
        : { tone: "warn", title: "AI hasn't been used yet", body: "Your balance can't be checked from here — Anthropic doesn't share it. If the first AI step fails for lack of credit, this will say so. Add credit first if your balance is empty." };
  const dot = status.tone === "good" ? "bg-[var(--color-emerald-400)]" : status.tone === "bad" ? "bg-[var(--color-rose-400)]" : "bg-[var(--color-gold-400)]";

  return (
    <>
      <NavBar />
      <PageShell maxWidth={640}>
        <PageHeader eyebrow="Settings" title="AI credit" description="Only the AI features use credit. Uploading, editing, captions, scheduling and posting never do." />

        <Panel>
          <div className="flex items-start gap-3" data-testid="ai-status">
            <span className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${dot}`} />
            <div className="min-w-0">
              <p className="text-[17px] font-semibold">{status.title}</p>
              <p className="mt-1 text-[14px] leading-snug text-[var(--color-text-muted)]">{status.body}</p>
            </div>
          </div>
          <a href={BILLING_URL} target="_blank" rel="noopener noreferrer" className="btn btn-primary mt-5 w-full !min-h-[56px] !text-[17px]" data-testid="add-credit">
            Add credit
          </a>
          <p className="mt-3 text-[13px] leading-snug text-[var(--color-text-faint)]">
            Opens Anthropic&apos;s billing page (sign in with the account that owns the app&apos;s key). If it offers auto-reload, turn it on so the AI never stops mid-week.
          </p>
        </Panel>

        <Panel className="mt-4">
          <p className="text-[15px] font-semibold">What it&apos;s cost</p>
          <dl className="mt-3 grid grid-cols-2 gap-3" data-testid="ai-spend">
            <div className="rounded-xl bg-[var(--color-surface-raised)] p-3">
              <dt className="text-[12.5px] text-[var(--color-text-faint)]">Today</dt>
              <dd className="mt-0.5 text-[22px] font-semibold tabular-nums">{usd(o.todayUsd)}</dd>
            </div>
            <div className="rounded-xl bg-[var(--color-surface-raised)] p-3">
              <dt className="text-[12.5px] text-[var(--color-text-faint)]">Last 30 days</dt>
              <dd className="mt-0.5 text-[22px] font-semibold tabular-nums">{usd(o.last30Usd)}</dd>
            </div>
            <div className="col-span-2 rounded-xl bg-[var(--color-surface-raised)] p-3">
              <dt className="text-[12.5px] text-[var(--color-text-faint)]">Per video (last 30 days)</dt>
              <dd className="mt-0.5 text-[17px] font-semibold tabular-nums">
                {o.perVideoUsd == null ? "No videos have used AI yet" : `${usd(o.perVideoUsd)} average · ${o.last30Videos} video${o.last30Videos === 1 ? "" : "s"}`}
              </dd>
            </div>
          </dl>
          {cap != null && (
            <div className="mt-4">
              <div className="flex justify-between text-[13px] text-[var(--color-text-muted)]">
                <span>Daily safety limit</span>
                <span className="tabular-nums">{usd(o.todayUsd)} of {usd(cap)}</span>
              </div>
              <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-[var(--color-surface-raised)]">
                <div className="h-full rounded-full bg-[var(--color-gold-400)]" style={{ width: `${capPct}%` }} />
              </div>
              <p className="mt-2 text-[12.5px] leading-snug text-[var(--color-text-faint)]">
                The AI stops for the day at this limit, so a mistake can never run up a big bill. It resets at midnight UTC.
              </p>
            </div>
          )}
        </Panel>

        <p className="mt-4 text-[12.5px] leading-snug text-[var(--color-text-faint)]">
          Why not pay here with Apple Pay? Anthropic doesn&apos;t let apps buy credit for you — money paid inside this app would never reach your Anthropic account. Topping up on their page is the only way that works.
        </p>
      </PageShell>
    </>
  );
}
