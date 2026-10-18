import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma, getActivePostingPlan, getPlanContext, ymdInTz } from "@chris/domain";
import { enabledPlatformsOf, formatYmdShort } from "@chris/domain/plan-import";
import { HIGHLIGHT_LABELS, findHighlights, findPlanCandidates } from "@chris/domain/plan-context";
import { requireSession } from "../../../../lib/session";
import { APP_TZ } from "../../../../lib/calendar-data";
import { NavBar } from "../../../components/NavBar";
import { BackLink, CollapsiblePanel, PageHeader, PageShell, Panel } from "../../../components/ui";
import { deletePlanContextAction, setUseForAiAction } from "../actions";
import { ConversationView } from "./ConversationView";
import { PlanFromConversation } from "./PlanFromConversation";

/** One saved ChatGPT conversation: Highlights (by headings), the plan found inside it
 * ("Update my plan from this conversation" → the normal import preview), the readable,
 * searchable conversation, versions, AI use and delete. */
export default async function PlanContextDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ v?: string }> }) {
  await requireSession();
  const { id } = await params;
  const sp = await searchParams;
  const data = await getPlanContext(prisma, id, sp.v ?? null);
  if (!data || !data.version) notFound();
  const { context, versions, version, isLatest } = data;
  const messages = version.messages;
  const today = ymdInTz(new Date(), APP_TZ);
  const plan = await getActivePostingPlan(prisma);
  const highlights = findHighlights(messages);
  const candidates = findPlanCandidates(messages, { today, enabledPlatforms: enabledPlatformsOf(plan) });

  return (
    <>
      <NavBar />
      <PageShell maxWidth={720}>
        <BackLink href="/plan/context">ChatGPT conversations</BackLink>
        <PageHeader
          eyebrow={`ChatGPT conversation${versions.length > 1 ? ` · version ${version.version} of ${versions.length}` : ""}`}
          title={context.title}
          description={`${version.messageCount} messages · ${version.wordCount.toLocaleString()} words · saved ${version.createdAt.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`}
        />
        {!isLatest && (
          <Panel className="mb-4" padding="p-4">
            <p className="text-[14px]">
              You&apos;re looking at an older version. <Link href={`/plan/context/${context.id}`} className="text-[var(--color-gold-400)] underline">See the latest</Link>
            </p>
          </Panel>
        )}

        <div className="flex flex-col gap-4">
          <PlanFromConversation
            versionId={version.id}
            candidates={candidates.map((c) => ({
              ...c,
              when: c.firstYmd ? `${formatYmdShort(c.firstYmd, false)}${c.lastYmd && c.lastYmd !== c.firstYmd ? ` – ${formatYmdShort(c.lastYmd, false)}` : ""}` : "Relative days",
            }))}
          />

          <section className="panel p-4" data-testid="highlights">
            <p className="eyebrow">Highlights</p>
            <p className="mt-0.5 text-[13px] text-[var(--color-text-faint)]">Sections found by their headings (business model, audience, offer, pillars, cadence, money) — newest first. Not an AI summary.</p>
            {highlights.length === 0 ? (
              <p className="mt-2 text-[14px] text-[var(--color-text-muted)]">No sections with those headings in this chat. Search the conversation below instead.</p>
            ) : (
              <ul className="mt-2 flex flex-col gap-2">
                {highlights.map((h, i) => (
                  <li key={`${h.category}-${h.messageIndex}-${i}`}>
                    <details className="rounded-2xl bg-white/[0.04] px-3 py-2" data-testid="highlight">
                      <summary className="flex min-h-[40px] cursor-pointer items-center justify-between gap-2">
                        <span className="min-w-0">
                          <span className="block text-[12px] font-semibold uppercase tracking-wide text-[var(--color-gold-400)]">{HIGHLIGHT_LABELS[h.category]}</span>
                          <span className="block truncate text-[14.5px] font-medium">{h.heading}</span>
                        </span>
                        <span className="shrink-0 text-[12px] text-[var(--color-text-faint)]">
                          {h.role === "user" ? "You" : h.role === "assistant" ? "ChatGPT" : ""} · #{h.messageIndex + 1}
                        </span>
                      </summary>
                      <p className="whitespace-pre-wrap break-words pb-2 pt-1 text-[14px] leading-snug text-[var(--color-text-muted)]">
                        {h.text.includes("\n") ? h.text.slice(h.text.indexOf("\n") + 1).trim() : h.text}
                      </p>
                    </details>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <ConversationView messages={messages} />

          <CollapsiblePanel eyebrow="Settings" title="AI, versions and delete">
            <div className="flex flex-col gap-4">
              <form action={setUseForAiAction} className="flex items-center justify-between gap-3">
                <input type="hidden" name="id" value={context.id} />
                <input type="hidden" name="on" value={context.useForAi ? "0" : "1"} />
                <span className="text-[14px] leading-snug">
                  {context.useForAi ? "The app's AI uses this conversation as background (scripts, weekly plan, ChatGPT connector)." : "Not used by the app's AI."}
                </span>
                <button type="submit" className="btn btn-ghost shrink-0 !min-h-[40px] !text-[13.5px]" data-testid="toggle-ai">
                  {context.useForAi ? "Stop using" : "Use for AI"}
                </button>
              </form>
              {versions.length > 1 && (
                <div>
                  <p className="field-label">Versions (re-imports never overwrite)</p>
                  <ul className="mt-1 flex flex-col gap-1">
                    {versions.map((v) => (
                      <li key={v.id}>
                        <Link href={`/plan/context/${context.id}?v=${v.id}`} className={`flex min-h-[40px] items-center justify-between rounded-xl px-3 text-[14px] ${v.id === version.id ? "bg-white/[0.07]" : "active:bg-white/5"}`}>
                          <span>Version {v.version}</span>
                          <span className="text-[12.5px] text-[var(--color-text-muted)]">
                            {v.messageCount} messages · {v.createdAt.toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <form action={deletePlanContextAction} className="flex flex-col gap-2">
                <input type="hidden" name="id" value={context.id} />
                <label className="flex items-start gap-2 text-[13.5px] text-[var(--color-text-muted)]">
                  <input type="checkbox" required className="mt-1" data-testid="delete-confirm" />
                  Delete this conversation and all its versions from the app. (A record that it existed is kept; the text isn&apos;t.)
                </label>
                <button type="submit" className="btn btn-danger w-full" data-testid="delete-context">
                  Delete conversation
                </button>
              </form>
            </div>
          </CollapsiblePanel>
        </div>
      </PageShell>
    </>
  );
}
