import Link from "next/link";
import type { NextAction } from "@chris/domain";
import { startEditing } from "../content/[id]/flow-actions";
import { SubmitButton } from "./SubmitButton";
import { StatusPill } from "./ui";
import type { VideoCardData } from "../../lib/video-cards";

/** Where a next action goes. START_EDIT is a form (it creates the starter edit first). */
export function nextActionHref(id: string, next: NextAction, postUrl: string | null): string {
  switch (next.kind) {
    case "EDIT":
      return `/content/${id}/edit`;
    case "UPLOAD":
      return `/content/${id}#upload`;
    case "FILM":
      return "/film";
    case "CONTINUE_FILMING":
      return `/film/teleprompter?id=${id}`;
    case "SCHEDULE":
      return `/content/${id}#schedule`;
    case "VIEW_POST":
      return postUrl ?? `/content/${id}`;
    default:
      return `/content/${id}`;
  }
}

/** The one primary button for a video's next step — the same on its card, its page and the
 * sticky bar, so a button never means two different things. */
export function NextActionButton({
  id,
  next,
  postUrl,
  className = "",
  size = "md",
}: {
  id: string;
  next: NextAction;
  postUrl: string | null;
  className?: string;
  size?: "md" | "lg";
}) {
  const cls = `btn ${next.needsYou || next.kind === "VIEW_POST" ? "btn-primary" : "btn-ghost"} ${size === "lg" ? "!min-h-[54px] !text-[17px]" : ""} ${className}`;
  if (next.kind === "START_EDIT") {
    return (
      <form action={startEditing} className={className.includes("w-full") ? "w-full" : ""}>
        <input type="hidden" name="contentItemId" value={id} />
        <SubmitButton className={`${cls} w-full`} pendingLabel="Opening editor…">
          {next.label}
        </SubmitButton>
      </form>
    );
  }
  const href = nextActionHref(id, next, postUrl);
  if (/^https?:/.test(href)) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className={cls}>
        {next.label}
      </a>
    );
  }
  return (
    <Link href={href} className={cls}>
      {next.label}
    </Link>
  );
}

/** A 9:16 frame of the video (latest render, else the first take) or a soft placeholder.
 * `url` is a small poster JPEG (/api/thumb — lib/poster.ts), never the video file: a list of
 * <video> elements made every card download its whole take on a phone connection. */
// `title` stays in the props for callers; the image itself is decorative (alt="") because the
// surrounding link already names the video — and a failed poster must never show alt text.
export function VideoThumb({ url, className = "" }: { url: string | null; title: string; className?: string }) {
  return (
    <div className={`relative shrink-0 overflow-hidden rounded-xl bg-[linear-gradient(160deg,#2a2418,#151219_60%,#1b1626)] ${className}`}>
      {url ? (
        // Plain <img>: an authenticated, already-sized poster (next/image's optimizer can't fetch it).
        <img src={url} alt="" loading="lazy" decoding="async" className="pointer-events-none h-full w-full object-cover" />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-[var(--color-gold-400)]/70" aria-hidden>
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2.5" y="6" width="13.5" height="12" rx="2.5" />
            <path d="m16 10.5 5.5-3v9l-5.5-3" />
          </svg>
        </div>
      )}
    </div>
  );
}

/** "Draft" — an unfinished teleprompter recording (docs/decisions-pending/segmented-recording-drafts.md). */
export function DraftBadge({ label = "Draft" }: { label?: string }) {
  return (
    <span className="inline-flex min-h-[22px] items-center gap-1 rounded-full border border-[var(--color-gold-500)]/50 bg-[var(--color-gold-500)]/[0.12] px-2 text-[12px] font-semibold text-[var(--color-gold-400)]" data-testid="draft-badge">
      <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-gold-400)]" aria-hidden />
      {label}
    </span>
  );
}

export function VideoCard({ card }: { card: VideoCardData }) {
  return (
    <li className="panel flex min-w-0 gap-3.5 p-3">
      <Link href={`/content/${card.id}`} className="shrink-0 active:opacity-70" aria-label={`Open ${card.title}`}>
        <VideoThumb url={card.thumbUrl} title={card.title} className="h-[128px] w-[72px]" />
      </Link>
      <div className="flex min-w-0 flex-1 flex-col">
        <Link href={`/content/${card.id}`} className="line-clamp-2 text-[16px] font-semibold leading-snug active:opacity-70 sm:text-[15px]">
          {card.title}
        </Link>
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          {card.draft ? <DraftBadge /> : <StatusPill state={card.state} />}
        </div>
        <p className="mt-1.5 line-clamp-2 text-[13px] leading-snug text-[var(--color-text-faint)]">{card.when ?? card.next.hint}</p>
        <div className="mt-auto flex pt-2.5">
          <NextActionButton id={card.id} next={card.next} postUrl={card.postUrl} className="!min-h-[40px] !px-4 !text-[14px]" />
        </div>
      </div>
    </li>
  );
}
