import Link from "next/link";
import { prisma, listContentItems, countContentItems } from "@chris/domain";
import { requireSession } from "../../lib/session";
import { NavBar } from "../components/NavBar";
import { PageShell, PageHeader, Panel, Badge, EmptyState, contentStateTone } from "../components/ui";

const LIMIT = 50;

// Capped at LIMIT (most recent first), with the real total shown alongside — found by
// actually loading this page against the dev DB, where thousands of accumulated test
// ContentItem rows produced a genuinely 307,000px-tall page. Same discipline as Home's NEEDS
// YOU queue and Calendar's window: bound the render, tell the truth about the rest.
export default async function ContentListPage() {
  await requireSession();
  const items = await listContentItems(prisma, { limit: LIMIT });
  const total = await countContentItems(prisma);

  return (
    <>
      <NavBar />
      <PageShell>
        <PageHeader
          eyebrow="Production"
          title="Content"
          description={
            total > LIMIT ? `Showing the ${LIMIT} most recent of ${total} total.` : undefined
          }
        />

        <Panel padding="p-0">
          {items.length === 0 ? (
            <div className="p-6">
              <EmptyState>Nothing yet — add one on the Ideas page.</EmptyState>
            </div>
          ) : (
            <ul className="divide-y divide-[var(--color-border)]">
              {items.map((item) => (
                <li key={item.id}>
                  <Link
                    href={`/content/${item.id}`}
                    className="flex items-center justify-between gap-4 px-5 py-3.5 transition-colors hover:bg-white/[0.03]"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{item.title}</p>
                      <p className="mt-0.5 text-xs text-[var(--color-text-faint)]">
                        {item.pillar ?? "No pillar"} · {item.createdAt.toLocaleDateString()}
                      </p>
                    </div>
                    <Badge tone={contentStateTone(item.currentState)}>{item.currentState}</Badge>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </PageShell>
    </>
  );
}
