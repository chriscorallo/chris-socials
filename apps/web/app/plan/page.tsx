import Link from "next/link";
import {
  prisma,
  getActivePostingPlan,
  listPlannedVideos,
  listPlanImports,
  addDaysYmd,
  mondayOfYmd,
  parseYmd,
  ymdInTz,
  type PlannedVideo,
} from "@chris/domain";
import { formatTime12, formatYmdShort, plannedVideoStatus, PRE_FILM_STATES } from "@chris/domain/plan-import";
import { requireSession } from "../../lib/session";
import { storageMode } from "../../lib/storage";
import { APP_TZ } from "../../lib/calendar-data";
import { NavBar } from "../components/NavBar";
import { Badge, PageHeader, PageShell, Panel } from "../components/ui";
import { PlanItemUpload } from "./PlanItemUpload";
import { FilmChecklist, type ChecklistItem } from "./FilmChecklist";
import { editPlannedVideo, undoImportAction } from "./actions";

export const maxDuration = 300;

// Plan — every planned (dated) video, grouped by day, each with its plain-English status and
// the one next step: upload footage (not filmed yet) or edit (footage in). Filters: this week /
// next 30 days / all. "Filming checklist" mode lists what to film in a date range with hooks
// and notes. Imports: /plan/import; batch clip upload with auto-matching: /plan/upload.
// See docs/decisions-pending/plan-import.md.

type Range = "week" | "month" | "all";
const FINISHED = new Set(["READY", "SCHEDULED", "PUBLISHING", "PUBLISHED", "MEASURING", "ARCHIVED"]);

export default async function PlanPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string; mode?: string; from?: string; to?: string; notice?: string }>;
}) {
  await requireSession();
  const sp = await searchParams;
  const range: Range = sp.range === "week" || sp.range === "all" ? sp.range : "month";
  const mode = sp.mode === "film" ? "film" : "board";
  const today = ymdInTz(new Date(), APP_TZ);
  const plan = await getActivePostingPlan(prisma);
  const all = await listPlannedVideos(prisma, { tz: APP_TZ });
  const imports = await listPlanImports(prisma, 5);

  const weekEnd = addDaysYmd(mondayOfYmd(today), 7); // exclusive: next Monday
  const end = range === "week" ? weekEnd : range === "month" ? addDaysYmd(today, 31) : "9999-12-31";
  const overdue = all.filter((v) => v.ymd < today && !FINISHED.has(v.state));
  const upcoming = all.filter((v) => v.ymd >= today && v.ymd < end);
  const later = all.filter((v) => v.ymd >= end).length;

  const groups: { key: string; title: string; items: PlannedVideo[]; tone?: "warn" }[] = [];
  if (overdue.length) groups.push({ key: "overdue", title: "Behind — catch up", items: overdue, tone: "warn" });
  const todayItems = upcoming.filter((v) => v.ymd === today);
  if (todayItems.length) groups.push({ key: "today", title: "Today", items: todayItems });
  const thisWeek = upcoming.filter((v) => v.ymd > today && v.ymd < weekEnd);
  if (thisWeek.length) groups.push({ key: "week", title: "This week", items: thisWeek });
  const byWeek = new Map<string, PlannedVideo[]>();
  for (const v of upcoming.filter((x) => x.ymd >= weekEnd)) {
    const m = mondayOfYmd(v.ymd);
    byWeek.set(m, [...(byWeek.get(m) ?? []), v]);
  }
  for (const [m, items] of byWeek) groups.push({ key: m, title: m === weekEnd ? "Next week" : `Week of ${formatYmdShort(m, false)}`, items });

  // Filming checklist window (by film-by day = post day − the plan's filming lead).
  const filmLead = plan?.filmLeadDays ?? 3;
  const from = sp.from && parseYmd(sp.from) ? sp.from : today;
  const to = sp.to && parseYmd(sp.to) ? sp.to : addDaysYmd(today, 7);
  const checklist: ChecklistItem[] = all
    .filter((v) => PRE_FILM_STATES.has(v.state))
    .map((v) => ({ v, filmBy: addDaysYmd(v.ymd, -filmLead) }))
    .filter(({ v, filmBy }) => filmBy <= to && (filmBy >= from || v.ymd >= today))
    .map(({ v, filmBy }) => ({ id: v.id, title: v.title, ymd: v.ymd, filmBy, platforms: v.platforms, ...splitDescription(v.description) }));

  const toFilm = all.filter((v) => v.ymd >= today && PRE_FILM_STATES.has(v.state)).length;
  const qs = (p: Record<string, string>) => `/plan?${new URLSearchParams({ range, mode, ...p })}`;

  return (
    <>
      <NavBar />
      <PageShell maxWidth={760}>
        <PageHeader
          eyebrow="Plan"
          title="Your plan"
          description={all.length ? `${toFilm} to film · ${all.filter((v) => v.ymd >= today).length} coming up` : undefined}
          actions={
            all.length ? (
              <>
                <Link href="/plan/upload" className="btn btn-ghost !min-h-[40px] !text-[14px]">
                  Upload clips
                </Link>
                <Link href="/plan/import" className="btn btn-primary !min-h-[40px] !text-[14px]">
                  Import plan
                </Link>
              </>
            ) : undefined
          }
        />

        {sp.notice && (
          <Panel className="mb-4" padding="p-4">
            <p className="text-[14px]">{sp.notice}</p>
          </Panel>
        )}

        {all.length === 0 ? (
          <Panel padding="p-5 sm:p-6">
            <p className="text-[19px] font-semibold">Bring in your video plan</p>
            <p className="mt-1.5 text-[15px] leading-snug text-[var(--color-text-muted)]">
              Paste it from Notes or ChatGPT, upload the spreadsheet, or share a Google Sheet — a day, a week, a month or a year. Every video lands on its day, ready for
              you to film and upload.
            </p>
            <Link href="/plan/import" className="btn btn-primary mt-4 w-full sm:w-auto" data-testid="import-cta">
              Import your plan
            </Link>
          </Panel>
        ) : (
          <>
            <div className="mb-4 flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
              <div className="grid grid-cols-2 gap-1 rounded-2xl bg-white/[0.05] p-1 sm:w-[300px]">
                <Seg href={qs({ mode: "board" })} on={mode === "board"}>
                  Board
                </Seg>
                <Seg href={qs({ mode: "film" })} on={mode === "film"}>
                  Filming checklist
                </Seg>
              </div>
              {mode === "board" && (
                <div className="grid grid-cols-3 gap-1 rounded-2xl bg-white/[0.05] p-1 sm:w-[320px]">
                  <Seg href={qs({ range: "week" })} on={range === "week"}>
                    This week
                  </Seg>
                  <Seg href={qs({ range: "month" })} on={range === "month"}>
                    30 days
                  </Seg>
                  <Seg href={qs({ range: "all" })} on={range === "all"}>
                    All
                  </Seg>
                </div>
              )}
            </div>

            {mode === "film" ? (
              <>
                <form className="mb-3 flex items-end gap-2" action="/plan">
                  <input type="hidden" name="mode" value="film" />
                  <label className="block flex-1">
                    <span className="field-label">Film from</span>
                    <input type="date" name="from" defaultValue={from} className="field-input" />
                  </label>
                  <label className="block flex-1">
                    <span className="field-label">to</span>
                    <input type="date" name="to" defaultValue={to} className="field-input" />
                  </label>
                  <button className="btn btn-ghost">Show</button>
                </form>
                <FilmChecklist items={checklist} mode={storageMode} />
              </>
            ) : (
              <div className="flex flex-col gap-5">
                {groups.length === 0 && (
                  <Panel padding="p-5">
                    <p className="text-[15px] text-[var(--color-text-muted)]">
                      Nothing planned {range === "week" ? "this week" : "in the next 30 days"}.{" "}
                      {later > 0 && (
                        <Link href={qs({ range: "all" })} className="link-quiet">
                          See all {later} later
                        </Link>
                      )}
                    </p>
                  </Panel>
                )}
                {groups.map((g) => (
                  <section key={g.key} data-testid={`group-${g.key}`}>
                    <h2 className={`mb-2 px-1 text-[13px] font-semibold uppercase tracking-wider ${g.tone ? "text-[var(--color-gold-400)]" : "text-[var(--color-text-faint)]"}`}>
                      {g.title} <span className="font-normal">· {g.items.length}</span>
                    </h2>
                    <ul className="panel divide-y divide-[var(--color-border)]">
                      {g.items.map((v) => (
                        <PlanRow key={v.id} v={v} today={today} />
                      ))}
                    </ul>
                  </section>
                ))}
                {range !== "all" && later > 0 && groups.length > 0 && (
                  <Link href={qs({ range: "all" })} className="link-quiet px-1 text-[14px]">
                    + {later} more later
                  </Link>
                )}
              </div>
            )}
          </>
        )}

        {imports.length > 0 && (
          <details className="panel mt-6 min-w-0">
            <summary className="flex min-h-[52px] cursor-pointer items-center justify-between gap-3 px-4 py-3">
              <span className="text-[15px] font-medium">Imports</span>
              <span className="text-[13px] text-[var(--color-text-faint)]">{imports.length} recent</span>
            </summary>
            <ul className="divide-y divide-[var(--color-border)] px-4 pb-2">
              {imports.map((imp) => (
                <li key={imp.id} className="flex items-center justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-[14.5px]">{imp.sourceRef && !imp.sourceRef.startsWith("http") ? imp.sourceRef : sourceName(imp.sourceKind)}</p>
                    <p className="text-[12.5px] text-[var(--color-text-faint)]">
                      {formatYmdShort(ymdInTz(imp.createdAt, APP_TZ))} · {imp.createdCount} video{imp.createdCount === 1 ? "" : "s"}
                      {imp.undoneAt ? " · undone" : ""}
                    </p>
                  </div>
                  {!imp.undoneAt && (
                    <form action={undoImportAction}>
                      <input type="hidden" name="importId" value={imp.id} />
                      <button className="btn btn-ghost !min-h-[38px] !text-[13px]">Undo this import</button>
                    </form>
                  )}
                </li>
              ))}
            </ul>
            <p className="px-4 pb-4 text-[12.5px] text-[var(--color-text-faint)]">Undo removes the videos you haven&apos;t started yet. Anything you&apos;ve filmed stays.</p>
          </details>
        )}
      </PageShell>
    </>
  );
}

function Seg({ href, on, children }: { href: string; on: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      aria-current={on ? "page" : undefined}
      className={`flex min-h-[40px] items-center justify-center rounded-xl px-2 text-center text-[13.5px] font-medium ${on ? "bg-white/[0.12] text-[var(--color-text)]" : "text-[var(--color-text-muted)] active:bg-white/10"}`}
    >
      {children}
    </Link>
  );
}

function PlanRow({ v, today }: { v: PlannedVideo; today: string }) {
  const st = plannedVideoStatus(v.state);
  const { hook } = splitDescription(v.description);
  return (
    <li className="flex items-center gap-3 px-4 py-3" data-testid="plan-row">
      <div className={`w-[54px] shrink-0 text-center ${v.ymd === today ? "text-[var(--color-gold-400)]" : ""}`}>
        <p className="text-[11.5px] font-semibold uppercase leading-tight tracking-wide">{formatYmdShort(v.ymd).split(" ")[0]}</p>
        <p className="text-[19px] font-semibold leading-tight">{Number(v.ymd.slice(8))}</p>
        <p className="text-[11px] leading-tight text-[var(--color-text-faint)]">{formatTime12(v.time).replace(":00", "")}</p>
      </div>
      <div className="min-w-0 flex-1">
        <Link href={`/content/${v.id}`} className="line-clamp-2 text-[15.5px] font-medium leading-snug active:opacity-60">
          {v.title}
        </Link>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          <Badge tone={st.tone}>{st.label}</Badge>
          {v.takes > 0 && <span className="text-[12px] text-[var(--color-text-faint)]">{v.takes} take{v.takes === 1 ? "" : "s"}</span>}
          <span className="truncate text-[12px] text-[var(--color-text-faint)]">{v.platforms.map((p) => (p === "TIKTOK" ? "TikTok" : p === "INSTAGRAM" ? "Reels" : "Shorts")).join(" · ")}</span>
        </div>
        {hook && st.action.kind === "UPLOAD" && <p className="mt-1 line-clamp-1 text-[13px] text-[var(--color-text-muted)]">“{hook}”</p>}
      </div>
      <div className="shrink-0">
        {st.action.kind === "UPLOAD" ? (
          <PlanItemUpload contentItemId={v.id} mode={storageMode} label="Upload" compact />
        ) : st.action.kind === "START_EDIT" ? (
          <form action={editPlannedVideo}>
            <input type="hidden" name="contentItemId" value={v.id} />
            <button className="btn btn-primary !min-h-[38px] !px-3.5 !text-[13.5px]">Edit</button>
          </form>
        ) : st.action.kind === "EDIT" ? (
          <Link href={`/content/${v.id}/edit`} className="btn btn-primary !min-h-[38px] !px-3.5 !text-[13.5px]">
            Edit
          </Link>
        ) : (
          <Link href={`/content/${v.id}`} className="btn btn-ghost !min-h-[38px] !px-3.5 !text-[13.5px]">
            {st.action.label}
          </Link>
        )}
      </div>
    </li>
  );
}

/** Imported items keep "Hook: …" as the description's first paragraph. */
function splitDescription(d: string | null): { hook: string | null; notes: string | null } {
  if (!d) return { hook: null, notes: null };
  const m = /^Hook: (.*)(?:\n\n([\s\S]*))?$/.exec(d);
  if (m) return { hook: m[1]!.trim() || null, notes: m[2]?.trim() || null };
  return { hook: null, notes: d.trim() || null };
}

function sourceName(kind: string): string {
  return kind === "XLSX" ? "Excel file" : kind === "CSV" ? "CSV file" : kind === "GOOGLE_SHEETS" ? "Google Sheet" : kind === "AI_CLEANUP" ? "Pasted plan (AI cleanup)" : "Pasted plan";
}
