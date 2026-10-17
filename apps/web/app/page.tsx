import type { ReactNode } from "react";
import Link from "next/link";
import { prisma, countContentItems, type Nudge } from "@chris/domain";
import { requireSession } from "../lib/session";
import { NavBar } from "./components/NavBar";
import { PageShell, QuietLink } from "./components/ui";
import { VideoCard, NextActionButton } from "./components/VideoCard";
import { loadTodo } from "../lib/todo-data";
import { loadVideoCards, sortInProgress, type VideoCardData } from "../lib/video-cards";
import { APP_TZ } from "../lib/calendar-data";
import { CourseStatusPill } from "./calendar/nudges";
import { scheduleFromNudge } from "./calendar/actions";
import { SubmitButton } from "./components/SubmitButton";

// Home = your videos. Chris's words: "Where is the editor??? The flow of this app is
// confusing." So Home answers two questions and nothing else: what should I do right now
// (one big card), and where are my videos (big cards, one button each that does the next
// step). Strategy/analytics/learnings are one tap away under More. See
// docs/decisions-pending/flow.md.

const PER_GROUP = 6;

function greeting(now: Date): string {
  const h = Number(now.toLocaleString("en-US", { timeZone: APP_TZ, hour: "numeric", hour12: false }));
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

/** The single most important thing: a real problem first, then the posting-plan nudge, then
 * the first video waiting on Chris. */
function pickHero(nudges: Nudge[], inProgress: VideoCardData[]):
  | { kind: "nudge"; nudge: Nudge }
  | { kind: "video"; card: VideoCardData }
  | null {
  const fix = inProgress.find((c) => c.next.kind === "FIX");
  if (fix) return { kind: "video", card: fix };
  const nudge = nudges.find((n) => n.bucket !== "setup" || n.severity === "critical");
  const waiting = inProgress.find((c) => c.next.needsYou && c.next.kind !== "OPEN");
  // An item already mid-edit beats a generic plan nudge — finishing it is the next step.
  if (waiting && (waiting.next.kind === "EDIT" || waiting.next.kind === "START_EDIT" || waiting.next.kind === "UPLOAD")) {
    return { kind: "video", card: waiting };
  }
  if (nudge) return { kind: "nudge", nudge };
  if (waiting) return { kind: "video", card: waiting };
  return null;
}

function Section({ title, count, children, more }: { title: string; count: number; children: ReactNode; more?: ReactNode }) {
  return (
    <section className="mt-7">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="text-[20px] font-semibold tracking-tight">
          {title} <span className="text-[15px] font-medium text-[var(--color-text-faint)]">{count}</span>
        </h2>
        {more}
      </div>
      {children}
    </section>
  );
}

export default async function HomePage() {
  const session = await requireSession();
  // Sequential, not Promise.all — the PGlite dev database can't take concurrent queries.
  const cards = await loadVideoCards({ limit: 200 });
  const ideaCount = await countContentItems(prisma, { state: "IDEA" });
  const { course, todo } = await loadTodo();

  const now = new Date();
  const firstName = session.user?.name?.split(" ")[0] ?? "Chris";
  const inProgress = sortInProgress(cards.filter((c) => c.group === "IN_PROGRESS"));
  const ready = cards.filter((c) => c.group === "READY");
  const posted = cards.filter((c) => c.group === "POSTED");
  const hasVideos = inProgress.length + ready.length + posted.length > 0;
  const hero = pickHero(todo.nudges, inProgress);

  return (
    <>
      <NavBar />
      <PageShell maxWidth={960}>
        <header className="mb-4">
          <p className="text-[14px] text-[var(--color-text-faint)]">
            {now.toLocaleDateString("en-US", { timeZone: APP_TZ, weekday: "long", month: "long", day: "numeric" })}
          </p>
          <h1 className="text-[30px] font-semibold leading-tight tracking-tight">
            {greeting(now)}, {firstName}
          </h1>
        </header>

        {!hasVideos ? (
          <FirstRun ideaCount={ideaCount} />
        ) : (
          <>
            {hero && <HeroCard hero={hero} />}

            {/* Stay on course — compact: one line + the full list one tap away. */}
            <Link
              href="/todo"
              className="panel mt-3 flex min-h-[56px] items-center gap-3 px-4 py-3 active:bg-white/[0.04]"
            >
              <CourseStatusPill status={course.status} />
              <span className="min-w-0 flex-1 truncate text-[14px] text-[var(--color-text-muted)]">{course.headline}</span>
              <svg width="8" height="14" viewBox="0 0 8 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className="shrink-0 text-[var(--color-text-faint)]" aria-hidden>
                <path d="m1 1 6 6-6 6" />
              </svg>
            </Link>

            {inProgress.length > 0 && (
              <Section title="In progress" count={inProgress.length} more={inProgress.length > PER_GROUP ? <QuietLink href="/content">See all →</QuietLink> : undefined}>
                <CardGrid cards={inProgress.slice(0, PER_GROUP)} />
              </Section>
            )}
            {ready.length > 0 && (
              <Section title="Ready to post" count={ready.length} more={ready.length > PER_GROUP ? <QuietLink href="/content?show=ready">See all →</QuietLink> : undefined}>
                <CardGrid cards={ready.slice(0, PER_GROUP)} />
              </Section>
            )}
            {posted.length > 0 && (
              <Section title="Posted" count={posted.length} more={posted.length > 3 ? <QuietLink href="/content?show=posted">See all →</QuietLink> : undefined}>
                <CardGrid cards={posted.slice(0, 3)} />
              </Section>
            )}

            <div className="mt-8 flex flex-col gap-2.5 sm:flex-row">
              <Link href="/upload" className="btn btn-primary !min-h-[52px] flex-1 !text-[16px]">
                Upload a video
              </Link>
              <Link href="/ideas" className="btn btn-ghost !min-h-[52px] flex-1 !text-[16px]">
                {ideaCount > 0 ? `Ideas (${ideaCount})` : "Plan a new video"}
              </Link>
            </div>
          </>
        )}
      </PageShell>
    </>
  );
}

function CardGrid({ cards }: { cards: VideoCardData[] }) {
  return (
    <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
      {cards.map((c) => (
        <VideoCard key={c.id} card={c} />
      ))}
    </ul>
  );
}

function HeroCard({ hero }: { hero: NonNullable<ReturnType<typeof pickHero>> }) {
  const shell = "panel panel-action flex flex-col gap-3 p-5";
  if (hero.kind === "video") {
    const c = hero.card;
    return (
      <section className={shell}>
        <p className="eyebrow">Do this next</p>
        <div>
          <p className="text-[20px] font-semibold leading-snug">
            {c.next.label}: {c.title}
          </p>
          <p className="mt-1 text-[15px] leading-snug text-[var(--color-text-muted)]">{c.next.hint}</p>
        </div>
        <NextActionButton id={c.id} next={c.next} postUrl={c.postUrl} size="lg" className="w-full" />
      </section>
    );
  }
  const n = hero.nudge;
  const a = n.action;
  return (
    <section className={shell}>
      <p className="eyebrow">Do this next</p>
      <div>
        <p className="text-[20px] font-semibold leading-snug">{n.title}</p>
        {n.detail && <p className="mt-1 text-[15px] leading-snug text-[var(--color-text-muted)]">{n.detail}</p>}
      </div>
      {a?.kind === "link" && (
        <Link href={a.href} className="btn btn-primary w-full !min-h-[54px] !text-[17px]">
          {a.label}
        </Link>
      )}
      {a?.kind === "schedule" && (
        <form action={scheduleFromNudge}>
          <input type="hidden" name="contentItemId" value={a.contentItemId} />
          <input type="hidden" name="atIso" value={a.atIso} />
          <input type="hidden" name="back" value="/" />
          {a.platforms.map((p) => (
            <input key={p} type="hidden" name="platforms" value={p} />
          ))}
          <SubmitButton className="btn btn-primary w-full !min-h-[54px] !text-[17px]" pendingLabel="Scheduling…">
            {a.label}
          </SubmitButton>
        </form>
      )}
    </section>
  );
}

function FirstRun({ ideaCount }: { ideaCount: number }) {
  return (
    <section className="panel flex flex-col gap-4 p-6 text-center">
      <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-[var(--color-gold-500)]/15 text-[var(--color-gold-400)]" aria-hidden>
        <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <rect x="2.5" y="6" width="13.5" height="12" rx="2.5" />
          <path d="m16 10.5 5.5-3v9l-5.5-3" />
        </svg>
      </div>
      <div>
        <h2 className="text-[22px] font-semibold tracking-tight">Let&apos;s make your first video</h2>
        <p className="mx-auto mt-2 max-w-md text-[15px] leading-snug text-[var(--color-text-muted)]">
          Upload something you filmed and it opens straight in the editor with captions — then pick a day to post it.
        </p>
      </div>
      <div className="flex flex-col gap-2.5">
        <Link href="/upload" className="btn btn-primary w-full !min-h-[56px] !text-[17px]">
          Upload a video I filmed
        </Link>
        <Link href="/ideas" className="btn btn-ghost w-full !min-h-[56px] !text-[17px]">
          Plan a new video
        </Link>
      </div>
      {ideaCount > 0 && (
        <p className="text-[13px] text-[var(--color-text-faint)]">
          You have {ideaCount} idea{ideaCount === 1 ? "" : "s"} saved — <QuietLink href="/ideas">see them</QuietLink>.
        </p>
      )}
    </section>
  );
}
