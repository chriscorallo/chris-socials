import { NavBar } from "./NavBar";
import { PageShell } from "./ui";

/**
 * The instant loading state every main route shows the moment a tab/link is tapped (each
 * route's loading.tsx). Next prefetches it with the link, so the tap paints this — the real nav
 * bar with the new tab already highlighted, plus the page's rough shape — immediately, and the
 * page streams in over it when the server answers. Before, a tap did nothing visible until the
 * whole page had rendered on the server and come back over the phone's connection.
 * See docs/decisions-pending/app-performance.md.
 *
 * `data-skeleton` lets the perf script (and tests) tell skeleton from real content.
 */
type Shape = "cards" | "list" | "detail" | "calendar";

function Bar({ className }: { className: string }) {
  return <div className={`rounded-lg bg-white/[0.06] ${className}`} />;
}

function CardRow() {
  return (
    <div className="panel flex gap-3.5 p-3">
      <div className="h-[128px] w-[72px] shrink-0 rounded-xl bg-white/[0.05]" />
      <div className="flex flex-1 flex-col gap-2 pt-1">
        <Bar className="h-4 w-4/5" />
        <Bar className="h-4 w-2/5" />
        <Bar className="mt-auto h-10 w-28 rounded-full" />
      </div>
    </div>
  );
}

function ListRow() {
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <Bar className="h-11 w-[54px] shrink-0" />
      <div className="flex flex-1 flex-col gap-2">
        <Bar className="h-4 w-3/4" />
        <Bar className="h-3 w-1/3" />
      </div>
    </div>
  );
}

export function RouteSkeleton({ shape = "list", maxWidth = 880, label = "Loading" }: { shape?: Shape; maxWidth?: number; label?: string }) {
  return (
    <>
      <NavBar />
      <PageShell maxWidth={maxWidth}>
        <div data-skeleton="" role="status" aria-label={label} className="animate-pulse motion-reduce:animate-none">
          <Bar className="mb-2 h-3.5 w-32" />
          <Bar className="mb-6 h-8 w-56" />
          {shape === "cards" && (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              <CardRow />
              <CardRow />
              <CardRow />
            </div>
          )}
          {shape === "list" && (
            <div className="panel divide-y divide-[var(--color-border)] overflow-hidden">
              <ListRow />
              <ListRow />
              <ListRow />
              <ListRow />
              <ListRow />
            </div>
          )}
          {shape === "calendar" && (
            <div className="panel p-4">
              <div className="mb-4 grid grid-cols-7 gap-2">
                {Array.from({ length: 7 }, (_, i) => (
                  <Bar key={i} className="h-10" />
                ))}
              </div>
              <div className="flex flex-col gap-3">
                <Bar className="h-14" />
                <Bar className="h-14" />
                <Bar className="h-14" />
              </div>
            </div>
          )}
          {shape === "detail" && (
            <div className="grid grid-cols-[124px_minmax(0,1fr)] items-start gap-4 md:grid-cols-[300px_minmax(0,1fr)] md:gap-x-8">
              <div className="aspect-[9/16] w-full rounded-2xl bg-white/[0.05]" />
              <div className="flex flex-col gap-3">
                <Bar className="h-6 w-4/5" />
                <Bar className="h-4 w-2/5" />
                <Bar className="mt-2 h-12 w-full rounded-full" />
              </div>
            </div>
          )}
        </div>
      </PageShell>
    </>
  );
}
