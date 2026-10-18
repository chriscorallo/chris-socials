import Link from "next/link";
import { prisma, listPlanContexts } from "@chris/domain";
import { requireSession } from "../../../lib/session";
import { NavBar } from "../../components/NavBar";
import { BackLink, PageHeader, PageShell, Panel } from "../../components/ui";
import { ContextImportClient } from "./ContextImportClient";

export const maxDuration = 60;

/**
 * Plan context: bring Chris's ChatGPT planning conversation into the app (official export
 * .zip read on the phone, share link, or paste), versioned and private. Used by the in-app
 * Script agent / Weekly Strategist / ChatGPT connector, and readable here.
 * See docs/decisions-pending/plan-context.md.
 */
export default async function PlanContextPage({ searchParams }: { searchParams: Promise<{ notice?: string }> }) {
  await requireSession();
  const sp = await searchParams;
  const contexts = await listPlanContexts(prisma);
  return (
    <>
      <NavBar />
      <PageShell maxWidth={680}>
        <BackLink href="/plan">Plan</BackLink>
        <PageHeader eyebrow="Plan" title="Your ChatGPT conversation" />
        <p className="-mt-2 mb-4 text-[15px] leading-snug text-[var(--color-text-muted)]">
          Bring in the chat where you planned your videos and business. You can read and search it here, update your plan from it, and the app&apos;s AI uses it as background
          when you run it. Private to you — sent nowhere except AI steps you start.
        </p>
        {sp.notice && (
          <Panel className="mb-4" padding="p-4">
            <p className="text-[14px]">{sp.notice}</p>
          </Panel>
        )}
        {contexts.length > 0 && (
          <section className="mb-5 flex flex-col gap-2" data-testid="context-list">
            <p className="eyebrow px-1">Saved</p>
            {contexts.map((c) => (
              <Link key={c.id} href={`/plan/context/${c.id}`} className="panel flex min-h-[60px] items-center justify-between gap-3 px-4 py-3 active:opacity-70">
                <span className="min-w-0">
                  <span className="block truncate text-[15.5px] font-medium">{c.title}</span>
                  <span className="block text-[12.5px] text-[var(--color-text-muted)]">
                    {c.latest ? `${c.latest.messageCount} messages · ${c.latest.wordCount.toLocaleString()} words` : "Empty"}
                    {c.versionCount > 1 ? ` · version ${c.latest?.version}` : ""}
                    {c.useForAi ? "" : " · not used by AI"}
                  </span>
                </span>
                <span className="shrink-0 text-[13.5px] text-[var(--color-gold-400)]">Open</span>
              </Link>
            ))}
          </section>
        )}
        <p className="eyebrow mb-2 px-1">{contexts.length ? "Bring in another (or an updated export)" : "Bring it in"}</p>
        <ContextImportClient existing={contexts.map((c) => ({ id: c.id, title: c.title }))} />
      </PageShell>
    </>
  );
}
