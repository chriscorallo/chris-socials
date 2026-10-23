"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useJobProgress } from "../../lib/use-job-progress";
import { plainJobError } from "../../lib/heavy-job-text";
import type { WatchBackData } from "../../lib/watch-back";
import { rateWatchBack, startWatchBack } from "../watch/actions";

/**
 * "Watch it back" — the gate's card (docs/PREMIUM_EDITOR_PLAN.md round 2): one tap runs the
 * watch-back on the latest render; the verdict comes back as a checklist in words with the
 * fixes it named; on a HOLD Chris gets Fix it / Post anyway; after posting, one tap rates the
 * edit (👍 posted as-is / 👎 had to change it) — the label autonomy is earned against.
 */
const CHECK_LABEL: Record<string, string> = {
  HOOK_BY_1_5S: "Hook by 1.5 s",
  STORY_READS: "Story reads",
  NOTHING_COMPETES: "Nothing competes",
  CUTS_INVISIBLE: "Cuts invisible",
  ENDING_SERVES: "Ending serves",
  LIKE_THE_REFERENCES: "Like the references",
};
const fmtT = (t: number) => `${t.toFixed(1)}s`;

export function WatchBack({ data }: { data: WatchBackData }) {
  const router = useRouter();
  const [jobRunId, setJobRunId] = useState<string | null>(data.activeJobRunId);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const { view: job, error: pollError } = useJobProgress(jobRunId);
  const finished = job && job.status !== "RUNNING";
  const refreshedFor = useRef<string | null>(null);
  useEffect(() => {
    if (finished && job && refreshedFor.current !== job.id) {
      refreshedFor.current = job.id;
      setJobRunId(null);
      router.refresh();
    }
  }, [finished, job, router]);
  const v = data.latest;
  if (!data.hasRender) return null;

  const start = async (applyFixes = false) => {
    setError(null);
    const r = await startWatchBack({ contentItemId: data.contentItemId, applyFixes });
    if ("error" in r) setError(r.error);
    else setJobRunId(r.jobRunId);
  };
  const rate = async (rating: "UP" | "DOWN", action: Parameters<typeof rateWatchBack>[0]["action"]) => {
    setBusy(action);
    setError(null);
    const r = await rateWatchBack({ contentItemId: data.contentItemId, rating, action });
    setBusy(null);
    if ("error" in r) setError(r.error);
    else router.refresh();
  };
  const tone = v?.verdict === "PASS" ? "text-[var(--color-emerald-400)]" : v?.verdict === "FIX" ? "text-[var(--color-gold-400)]" : "text-[var(--color-rose-400)]";
  const title = !v ? "Not watched back yet" : v.verdict === "PASS" ? "Passes the watch-back" : v.verdict === "FIX" ? `${v.fixes.length} fix${v.fixes.length === 1 ? "" : "es"} named` : "On hold — needs you";

  return (
    <section className="panel p-4 sm:p-5" data-testid="watch-back-card">
      <p className="eyebrow">Watch-back {data.gating ? "· gating" : "· shadow"}</p>
      <h2 className={`mt-0.5 text-[19px] font-semibold ${v ? tone : ""}`}>{title}</h2>
      {v && !v.isForCurrentVersion && <p className="mt-1 text-[12.5px] text-[var(--color-text-faint)]">For an earlier render — watch the new one back.</p>}
      {jobRunId && <p className="mt-2 text-[13px] text-[var(--color-text-muted)]">{job?.line ?? "Watching it back…"}</p>}
      {error && <p className="mt-2 text-[13px] text-[var(--color-rose-400)]">{error}</p>}
      {(job?.error || pollError) && <p className="mt-2 text-[13px] text-[var(--color-rose-400)]">{plainJobError(job?.error ?? pollError ?? "")}</p>}

      {v && (
        <>
          <p className="mt-2 text-[14px] leading-relaxed">{v.coldViewer}</p>
          {v.hookTest && (
            <p className="mt-1 text-[13px] text-[var(--color-text-muted)]">
              First second alone: <strong>{v.hookTest.wouldKeepWatching === "YES" ? "keeps watching" : v.hookTest.wouldKeepWatching === "MAYBE" ? "maybe" : "scrolls"}</strong> — {v.hookTest.why}
              {v.hookTest.missing ? ` Missing: ${v.hookTest.missing}` : ""}
            </p>
          )}
          <ul className="mt-3 grid gap-1 text-[13.5px]">
            {v.checklist.map((c) => (
              <li key={c.check} className="flex gap-2">
                <span className={c.ok ? "text-[var(--color-emerald-400)]" : "text-[var(--color-rose-400)]"}>{c.ok ? "✓" : "✗"}</span>
                <span>
                  <strong>{CHECK_LABEL[c.check] ?? c.check}</strong> — {c.finding}
                  {c.evidence[0] ? <span className="text-[var(--color-text-faint)]"> ({fmtT(c.evidence[0].t)}: {c.evidence[0].detail})</span> : null}
                </span>
              </li>
            ))}
          </ul>
          {v.fixes.length > 0 && (
            <ul className="mt-3 list-disc space-y-1 pl-4 text-[13.5px] text-[var(--color-text-muted)]">
              {v.fixes.map((f, i) => (
                <li key={i}>
                  <strong>{f.stage} {f.op}</strong>
                  {"elementId" in f ? ` ${String(f.elementId)}` : ""}
                  {"sentenceId" in f ? ` line ${String(f.sentenceId)}` : ""}
                  {"cutIndex" in f ? ` cut ${String(f.cutIndex)} ${String(f.deltaMs)} ms` : ""} — {f.why}
                </li>
              ))}
            </ul>
          )}
          <button type="button" className="mt-2 text-[12.5px] text-[var(--color-text-faint)] underline" onClick={() => setOpen((o) => !o)}>
            {open ? "Hide" : "Show"} what was measured ({v.audits.length})
          </button>
          {open && (
            <ul className="mt-1 space-y-0.5 text-[12.5px] text-[var(--color-text-faint)]">
              {v.audits.length === 0 && <li>Clean: no gap, no clipped word, nothing on the face, the story in order.</li>}
              {v.audits.map((a, i) => (
                <li key={i}>{a.stage} {a.kind} at {fmtT(a.atS)}: {a.detail}</li>
              ))}
              {v.contrast.map((c, i) => (
                <li key={`c${i}`}>vs reference at {fmtT(c.t)}: theirs — {c.reference}; ours — {c.ours}</li>
              ))}
              <li>Model {v.model}{v.costUsd != null ? ` · ≈$${v.costUsd.toFixed(2)}` : ""}</li>
            </ul>
          )}
        </>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        {!jobRunId && (
          <button type="button" className="btn" onClick={() => start(false)}>
            {v ? "Watch it back again" : "Watch it back"}
          </button>
        )}
        {v && v.verdict !== "PASS" && !jobRunId && (
          <>
            <button type="button" className="btn btn-primary" disabled={busy != null} onClick={async () => { await rate("DOWN", "FIX_IT"); await start(true); }}>
              Fix it
            </button>
            <button type="button" className="btn" disabled={busy != null} onClick={() => rate("UP", "POST_ANYWAY")}>
              Post anyway
            </button>
          </>
        )}
        {v && !data.rating && (
          <>
            <button type="button" className="btn" disabled={busy != null} onClick={() => rate("UP", "POSTED_UNCHANGED")} title="The edit was good as-is">👍 Good as-is</button>
            <button type="button" className="btn" disabled={busy != null} onClick={() => rate("DOWN", "EDITED_FIRST")} title="I had to change it">👎 Had to change it</button>
          </>
        )}
        {v && data.published && data.rating?.action !== "PULLED" && (
          <button type="button" className="btn" disabled={busy != null} onClick={() => rate("DOWN", "PULLED")} title="I took this post down — the series loses hands-off posting until ten clean ratings">
            I pulled this post
          </button>
        )}
      </div>
      {data.rating && <p className="mt-2 text-[12.5px] text-[var(--color-text-faint)]">You rated this {data.rating.rating === "UP" ? "👍" : "👎"} ({data.rating.action.toLowerCase().replace(/_/g, " ")}).</p>}
      <p className="mt-2 text-[12.5px] text-[var(--color-text-faint)]">
        {data.agreement.series ? `${data.agreement.series.replace(/_/g, " ")}: ` : "No series: "}
        {data.agreement.earned ? "earned hands-off posting" : "not earned yet"} — {data.agreement.why}.
        {data.fixLoop ? "" : " Fixes are named, not applied (watch_back.fix_loop is off)."}
      </p>
    </section>
  );
}
