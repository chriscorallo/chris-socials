"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useJobProgress } from "../../lib/use-job-progress";
import { plainJobError } from "../../lib/heavy-job-text";
import { thumbUrlForMediaUrl } from "../../lib/media-urls";
import {
  attentionStrip,
  isAiUnavailableError,
  fmtT,
  CRAFT_LABEL,
  ENGAGEMENT_LABEL,
  STATE_LABEL,
  TIER_LABEL,
  type ViewerCheckData,
  type ViewerReviewView,
} from "../../lib/viewer-check-view";
import { startViewerReview } from "../viewer/actions";

/**
 * "Viewer check" — an AI first-time viewer watches the whole video (Viewer Panel). One tap with
 * the price on the button → live progress → the verdict, an attention/feeling strip over the
 * video's timeline (tap a beat to jump the player there), where they'd swipe away, and the top
 * fixes. The rest folds away. Advisory only — nothing about the video changes.
 */

const PLATFORMS = [
  { id: "TIKTOK", label: "TikTok" },
  { id: "INSTAGRAM", label: "Reels" },
  { id: "YOUTUBE", label: "Shorts" },
] as const;

const TONE_BG: Record<string, string> = {
  great: "bg-[var(--color-emerald-400)]",
  good: "bg-[var(--color-gold-400)]",
  flat: "bg-white/25",
  bad: "bg-[var(--color-rose-400)]",
};

const TIER_TONE: Record<string, string> = {
  BAD: "badge-rose",
  OKAY: "badge-neutral",
  GOOD: "badge-gold",
  GREAT: "badge-emerald",
  EXCEPTIONAL: "badge-emerald",
};

function AiCreditLink() {
  return (
    <Link href="/settings/ai" className="text-[var(--color-gold-400)] underline" data-testid="viewer-ai-link">
      More → AI credit
    </Link>
  );
}

export function ViewerCheck({ data, variant = "video" }: { data: ViewerCheckData; variant?: "video" | "reference" }) {
  const router = useRouter();
  const [jobRunId, setJobRunId] = useState<string | null>(data.activeJobRunId);
  const [platform, setPlatform] = useState<string>(data.defaultPlatform);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const { view, error: pollError } = useJobProgress(jobRunId);
  const finished = view && view.status !== "RUNNING";
  const refreshedFor = useRef<string | null>(null);

  useEffect(() => {
    if (finished && view && refreshedFor.current !== view.id) {
      refreshedFor.current = view.id;
      router.refresh();
    }
  }, [finished, view, router]);

  const running = !!jobRunId && (!view || view.status === "RUNNING") && !pollError;
  const failed = view?.status === "FAILED" ? view : null;
  const errorName = (failed?.result as { errorName?: string } | null)?.errorName ?? null;
  const aiDown = failed ? isAiUnavailableError(failed.error, errorName) : false;

  async function start() {
    setStarting(true);
    setStartError(null);
    const r = await startViewerReview(
      data.subject.kind === "RENDER"
        ? { contentItemId: data.subject.contentItemId, platform: platform as "TIKTOK" }
        : { referenceContentId: data.subject.referenceContentId, platform: platform as "TIKTOK" },
    );
    setStarting(false);
    if ("error" in r) setStartError(r.error);
    else setJobRunId(r.jobRunId);
  }

  const latest = data.latest;
  const canRun = !data.unavailable && data.ai.state === "ok" && !!data.estimate;
  const title = variant === "reference" ? "What a viewer thinks" : "What a new viewer would think";

  return (
    <section className={variant === "video" ? "panel p-4 sm:p-5" : "mt-3 rounded-xl border border-[var(--color-border)] p-3"} data-testid="viewer-check">
      <p className="eyebrow">Viewer check</p>
      <h2 className="mt-0.5 text-[17px] font-semibold leading-tight">{title}</h2>
      {!latest && !running && (
        <p className="mt-1 text-[13.5px] leading-snug text-[var(--color-text-muted)]">
          {variant === "reference"
            ? "An AI viewer watches this video start to finish and says why it works — which cuts tell the story and which just remove pauses."
            : "An AI viewer who's never seen you watches it start to finish and tells you when they'd be hooked, bored or confused — and what to fix."}
        </p>
      )}

      {latest && <ViewerResult latest={latest} mediaUrl={data.mediaUrl} variant={variant} />}

      {running && (
        <div className="mt-3 flex flex-col gap-1.5" data-testid="viewer-running">
          <p className="text-[14px] text-[var(--color-text-muted)]">{view?.queued ? "Waiting for a free cloud worker…" : (view?.line ?? "Watching it like a new viewer…")}</p>
          <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
            <div className="h-full rounded-full bg-[var(--color-gold-400)] transition-[width]" style={{ width: `${Math.max(4, view?.pct ?? 0)}%` }} />
          </div>
        </div>
      )}
      {pollError && jobRunId && <p className="mt-2 text-[13px] text-[var(--color-text-muted)]">Lost track of it ({pollError}). It keeps going — pull to refresh in a minute.</p>}

      {failed && (
        <p className="mt-3 text-[13.5px] leading-snug text-[var(--color-rose-400)]" data-testid="viewer-failed">
          {aiDown ? (
            <>
              {plainJobError(failed.error, errorName)} <AiCreditLink />
            </>
          ) : (
            plainJobError(failed.error, errorName)
          )}
        </p>
      )}

      {!running && (
        <div className="mt-3 flex flex-col gap-2.5">
          {data.unavailable ? (
            <p className="text-[13.5px] text-[var(--color-text-faint)]" data-testid="viewer-unavailable">{data.unavailable}</p>
          ) : data.ai.state !== "ok" ? (
            <p className="text-[13.5px] leading-snug text-[var(--color-text-muted)]" data-testid="viewer-ai-off">
              {data.ai.message} <AiCreditLink />
            </p>
          ) : null}
          {canRun && (
            <>
              <div className="grid grid-cols-3 gap-1.5" role="radiogroup" aria-label="Which feed">
                {PLATFORMS.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    role="radio"
                    aria-checked={platform === p.id}
                    onClick={() => setPlatform(p.id)}
                    className={`min-h-[40px] rounded-lg border text-[13.5px] ${platform === p.id ? "border-[var(--color-gold-500)]/60 bg-[var(--color-gold-500)]/10 text-[var(--color-text)]" : "border-[var(--color-border)] text-[var(--color-text-muted)]"}`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <button type="button" className="btn btn-primary w-full !min-h-[52px] !text-[16px]" disabled={starting} onClick={() => void start()} data-testid="viewer-start">
                {starting ? "Starting…" : `${latest ? "Watch it again" : "Watch it like a new viewer"} (${data.estimate!.label})`}
              </button>
              <p className="text-[12px] leading-snug text-[var(--color-text-faint)]">
                One AI call · {data.estimate!.frames} moments of the video · up to ${data.estimate!.highUsd.toFixed(2)}. Uses AI credit; it never changes your video.
              </p>
            </>
          )}
          {startError && <p className="text-[13.5px] text-[var(--color-rose-400)]">{startError}</p>}
        </div>
      )}
    </section>
  );
}

function TimeChip({ t, onSeek }: { t: number; onSeek: (t: number) => void }) {
  return (
    <button type="button" onClick={() => onSeek(t)} className="shrink-0 rounded-md bg-white/[0.07] px-1.5 py-0.5 font-mono text-[12px] tabular-nums text-[var(--color-gold-400)]">
      {fmtT(t)}
    </button>
  );
}

function ViewerResult({ latest, mediaUrl, variant }: { latest: ViewerReviewView; mediaUrl: string | null; variant: "video" | "reference" }) {
  const r = latest.review;
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [now, setNow] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);
  const duration = latest.durationS ?? Math.max(1, ...r.beats.map((b) => b.tEnd));
  const strip = attentionStrip(r, duration);
  const seek = (t: number) => {
    const v = videoRef.current;
    if (v) {
      v.currentTime = Math.max(0, t);
      void v.play().catch(() => undefined);
    }
    setNow(t);
    const i = r.beats.findIndex((b) => t >= b.tStart && t < b.tEnd);
    if (i >= 0) setSelected(i);
  };
  const beat = selected != null ? r.beats[selected] : null;
  const problems = r.craft.filter((c) => c.verdict !== "GOOD");
  const goods = r.craft.filter((c) => c.verdict === "GOOD");

  return (
    <div className="mt-3 flex flex-col gap-3" data-testid="viewer-result">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <span className={`badge ${TIER_TONE[r.verdict.tier] ?? "badge-neutral"}`} data-testid="viewer-tier">
            {TIER_LABEL[r.verdict.tier]}
          </span>
          <span className="text-[12px] text-[var(--color-text-faint)]">
            {latest.persona === "FOLLOWER" ? "Follower" : "New viewer"} · {latest.platform === "TIKTOK" ? "TikTok" : latest.platform === "YOUTUBE" ? "Shorts" : "Reels"}
          </span>
        </div>
        <p className="mt-1.5 text-[16px] font-semibold leading-snug" data-testid="viewer-headline">{r.verdict.headline}</p>
        <p className="mt-1 text-[13.5px] leading-snug text-[var(--color-text-muted)]">{r.verdict.biggestReason}</p>
        {!latest.isForCurrentVersion && <p className="mt-1.5 text-[12.5px] text-[var(--color-gold-400)]">This was for an earlier version — watch again to check the new one.</p>}
      </div>

      {mediaUrl && (
        <video
          ref={videoRef}
          src={`${mediaUrl}#t=0.1`}
          controls
          playsInline
          preload="none"
          poster={thumbUrlForMediaUrl(mediaUrl)}
          onTimeUpdate={(e) => setNow(e.currentTarget.currentTime)}
          className="aspect-[9/16] max-h-[340px] w-auto self-center rounded-xl bg-black"
          data-testid="viewer-player"
        />
      )}

      <div>
        <div className="flex items-baseline justify-between text-[12px] text-[var(--color-text-faint)]">
          <span>How they feel, second by second</span>
          <span>tap to jump</span>
        </div>
        <div className="relative mt-1.5 h-14 w-full overflow-hidden rounded-lg bg-white/[0.04]" data-testid="viewer-strip">
          {strip.map((s) => (
            <button
              key={s.index}
              type="button"
              aria-label={s.label}
              onClick={() => {
                setSelected(s.index);
                seek(s.tStart);
              }}
              className={`absolute bottom-0 rounded-t-sm ${TONE_BG[s.tone]} ${selected === s.index ? "opacity-100 ring-2 ring-white/70" : "opacity-75"}`}
              style={{ left: `${s.leftPct}%`, width: `calc(${s.widthPct}% - 2px)`, height: `${s.heightPct}%` }}
            />
          ))}
          {r.dropOffs.map((d, i) => (
            <span key={i} className="pointer-events-none absolute top-0 h-full w-[2px] bg-[var(--color-rose-500)]" style={{ left: `${(Math.min(duration, d.t) / duration) * 100}%` }} aria-hidden />
          ))}
          <span className="pointer-events-none absolute top-0 h-full w-[2px] bg-white" style={{ left: `${(Math.min(duration, now) / duration) * 100}%` }} aria-hidden />
        </div>
        <div className="mt-1 flex justify-between text-[11px] tabular-nums text-[var(--color-text-faint)]">
          <span>0s</span>
          <span className="flex items-center gap-3">
            <span><i className="mr-1 inline-block h-2 w-2 rounded-full bg-[var(--color-emerald-400)]" />with you</span>
            <span><i className="mr-1 inline-block h-2 w-2 rounded-full bg-[var(--color-rose-400)]" />losing them</span>
          </span>
          <span>{fmtT(duration)}</span>
        </div>
        {beat && (
          <div className="mt-2 rounded-lg bg-white/[0.04] p-2.5 text-[13.5px]" data-testid="viewer-beat">
            <p className="font-medium">
              {fmtT(beat.tStart)}–{fmtT(beat.tEnd)} · {STATE_LABEL[beat.state]}
              {beat.secondaryState ? ` + ${STATE_LABEL[beat.secondaryState].toLowerCase()}` : ""} · attention {Math.round(beat.attention)}
            </p>
            <p className="mt-0.5 italic text-[var(--color-text)]">“{beat.thinking}”</p>
            <p className="mt-0.5 text-[var(--color-text-muted)]">{beat.driver}</p>
            <ul className="mt-1 text-[12.5px] text-[var(--color-text-faint)]">
              {beat.evidence.map((e, i) => (
                <li key={i}>
                  {fmtT(e.t)} · {e.kind.toLowerCase()}: {e.detail}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div className="text-[13.5px] leading-snug">
        <p className="font-medium">
          First {fmtT(r.hook.tEnd)}: {r.hook.wouldStopScrolling === "YES" ? "they'd stop scrolling" : r.hook.wouldStopScrolling === "MAYBE" ? "maybe they'd stop" : "they'd keep scrolling"}{" "}
          <span className="font-normal text-[var(--color-text-faint)]">(≈{Math.round(r.hook.stopChancePct)}%, estimate)</span>
        </p>
        <p className="text-[var(--color-text-muted)]">{r.hook.why}</p>
      </div>

      {r.dropOffs.length > 0 && (
        <div data-testid="viewer-dropoffs">
          <p className="text-[13px] font-semibold">Where they&apos;d swipe away</p>
          <ul className="mt-1 flex flex-col gap-1.5">
            {r.dropOffs.map((d, i) => (
              <li key={i} className="flex items-start gap-2 text-[13.5px] leading-snug">
                <TimeChip t={d.t} onSeek={seek} />
                <span className="text-[var(--color-text-muted)]">
                  {d.reason} <span className="text-[var(--color-text-faint)]">(≈{Math.round(d.riskPct)}% risk)</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {r.fixes.length > 0 && (
        <div data-testid="viewer-fixes">
          <p className="text-[13px] font-semibold">{variant === "reference" ? "What could be better" : "Top fixes"}</p>
          <ol className="mt-1 flex flex-col gap-2">
            {r.fixes.map((f, i) => (
              <li key={i} className="flex items-start gap-2 text-[13.5px] leading-snug">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[var(--color-gold-500)]/20 text-[11px] font-semibold text-[var(--color-gold-400)]">{i + 1}</span>
                <span className="min-w-0">
                  <span className="mr-1.5 inline-block align-middle">
                    <TimeChip t={f.tStart} onSeek={seek} />
                  </span>
                  {f.instruction}
                  <span className="block text-[12.5px] text-[var(--color-text-faint)]">Expected: {f.expectedEffect}</span>
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}

      <details className="rounded-lg border border-[var(--color-border)] px-3 py-1">
        <summary className="cursor-pointer py-2 text-[13.5px] text-[var(--color-gold-400)]">Everything the viewer noticed</summary>
        <div className="flex flex-col gap-3 pb-3 text-[13.5px] leading-snug">
          <div>
            <p className="font-semibold">Story</p>
            <p className="text-[var(--color-text-muted)]">
              Promise: “{r.story.corePromise}”{r.story.promiseClearAtS != null ? ` — clear by ${fmtT(r.story.promiseClearAtS)}` : " — never quite clear"}. {r.story.clarity === "CLEAR" ? "Clear" : r.story.clarity === "MOSTLY_CLEAR" ? "Mostly clear" : "Muddy"}, {r.story.cohesive ? "hangs together" : "doesn't hang together"}.
            </p>
            <p className="text-[var(--color-text-muted)]">{r.story.summary}</p>
            {r.story.confusingJumps.map((j, i) => (
              <p key={i} className="mt-1 flex items-start gap-2 text-[var(--color-text-muted)]">
                <TimeChip t={j.t} onSeek={seek} /> {j.what}
              </p>
            ))}
          </div>
          {problems.length > 0 && (
            <div>
              <p className="font-semibold">Craft — what got in the way</p>
              <ul className="mt-1 flex flex-col gap-1.5">
                {problems.map((c, i) => (
                  <li key={i} className="flex items-start gap-2">
                    <TimeChip t={c.tStart} onSeek={seek} />
                    <span>
                      <span className={c.verdict === "PROBLEM" ? "text-[var(--color-rose-400)]" : "text-[var(--color-gold-400)]"}>{CRAFT_LABEL[c.category] ?? c.category}</span>
                      <span className="text-[var(--color-text-muted)]"> — {c.finding}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {(goods.length > 0 || r.strengths.length > 0) && (
            <div>
              <p className="font-semibold">What works</p>
              <ul className="mt-1 flex flex-col gap-1.5">
                {r.strengths.map((s, i) => (
                  <li key={`s${i}`} className="flex items-start gap-2 text-[var(--color-text-muted)]">
                    <TimeChip t={s.t} onSeek={seek} /> {s.what}
                  </li>
                ))}
                {goods.map((c, i) => (
                  <li key={`g${i}`} className="flex items-start gap-2 text-[var(--color-text-muted)]">
                    {/* A GOOD check's category names the problem it looked for ("Music over the voice"),
                        so only the finding is shown here. */}
                    <TimeChip t={c.tStart} onSeek={seek} /> <span>{c.finding}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div data-testid="viewer-engagement">
            <p className="font-semibold">Likely reactions <span className="font-normal text-[var(--color-text-faint)]">— estimates from one viewing, not predictions of views</span></p>
            <dl className="mt-1.5 flex flex-col gap-1.5">
              {(Object.keys(ENGAGEMENT_LABEL) as Array<keyof typeof ENGAGEMENT_LABEL>).map((k) => {
                const e = r.engagement[k];
                return (
                  <div key={k}>
                    <div className="flex items-center gap-2">
                      <dt className="w-[118px] shrink-0 text-[12.5px] text-[var(--color-text-muted)]">{ENGAGEMENT_LABEL[k]}</dt>
                      <dd className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/10">
                        <div className="h-full rounded-full bg-[var(--color-gold-400)]" style={{ width: `${Math.max(2, Math.min(100, e.score))}%` }} />
                      </dd>
                      <span className="w-[74px] shrink-0 text-right text-[11.5px] tabular-nums text-[var(--color-text-faint)]">
                        {Math.round(e.score)} · {e.uncertainty === "HIGH" ? "unsure" : e.uncertainty === "MEDIUM" ? "rough" : "firm"}
                      </span>
                    </div>
                    <p className="pl-[126px] text-[12px] text-[var(--color-text-faint)]">{e.rationale}</p>
                  </div>
                );
              })}
            </dl>
          </div>
          {(r.limitations.length > 0 || latest.warnings.length > 0) && (
            <div className="text-[12.5px] text-[var(--color-text-faint)]">
              <p className="font-semibold text-[var(--color-text-muted)]">What it couldn&apos;t judge</p>
              <ul className="list-disc pl-4">
                {[...r.limitations, ...latest.warnings].map((l, i) => (
                  <li key={i}>{l}</li>
                ))}
              </ul>
            </div>
          )}
          <p className="text-[11.5px] text-[var(--color-text-faint)]">
            Watched {new Date(latest.createdAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}
            {latest.frames ? ` · ${latest.frames} moments` : ""}
            {latest.costUsd != null ? ` · cost $${latest.costUsd.toFixed(2)}` : ` · estimated $${latest.estimatedCostUsd.toFixed(2)}`}
            {" · advice only — it never blocks or changes the video"}
          </p>
        </div>
      </details>
    </div>
  );
}
