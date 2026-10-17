"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { buildSavePayload } from "../../../../lib/editor/reducer";
import { withResolvedPlacements } from "../../../../lib/editor/visuals";
import { warningsForPlatform } from "../../../../lib/editor/platform-warnings";
import { PLATFORM_IDS, PLATFORM_PROFILES, PLATFORM_SHORT_LABEL, type PlatformId } from "../../../../lib/editor/platform-profiles";
import { saveFinishingEditAction, renderStepAction, qualityGateStepAction, scheduleStepAction, finishJobResultAction } from "./actions";
import { waitForJob } from "../../../../lib/use-job-progress";
import { useEditor } from "./context";
import { browserMeasureText } from "./measure";
import { Icon } from "./icons";

type StepId = "save" | "render" | "check" | "schedule";
type StepStatus = "waiting" | "running" | "done" | "skipped" | "failed";

interface Step {
  id: StepId;
  label: string;
  status: StepStatus;
  detail?: string;
  reasons?: string[];
}

const LABELS: Record<StepId, string> = {
  save: "Save your edit",
  render: "Render the video",
  check: "Quality check",
  schedule: "Put it on the calendar",
};

const RUNNING_DETAIL: Record<StepId, string> = {
  save: "Saving a new version…",
  render: "Rendering in full quality — this can take a minute or two…",
  check: "Checking facts, brand, picture and sound…",
  schedule: "Scheduling…",
};

export function FinishModal({
  itemId,
  itemState,
  dirty,
  defaultDate,
  defaultPlatforms,
  onClose,
  onSaved,
  onStateChange,
}: {
  itemId: string;
  itemState: string;
  dirty: boolean;
  defaultDate: string;
  defaultPlatforms: string[];
  onClose: () => void;
  onSaved: (state: string) => void;
  onStateChange: (state: string) => void;
}) {
  const { doc, wordsByAsset, assets, setUi, focus, fontsVersion, touch, placement } = useEditor();
  const [date, setDate] = useState(defaultDate);
  const [platforms, setPlatforms] = useState<Set<PlatformId>>(new Set(defaultPlatforms.filter((p): p is PlatformId => p in PLATFORM_PROFILES)));
  const [phase, setPhase] = useState<"form" | "running" | "done" | "stopped">("form");
  const [steps, setSteps] = useState<Step[]>([]);
  const [elapsed, setElapsed] = useState(0);
  const [renderPct, setRenderPct] = useState<number | null>(null);
  const [scheduledFor, setScheduledFor] = useState<string | null>(null);
  const startedAt = useRef(0);

  const sizes = useMemo(() => Object.fromEntries(assets.map((a) => [a.id, { width: a.width, height: a.height }])), [assets]);
  const readiness = useMemo(
    () => Object.fromEntries(PLATFORM_IDS.map((p) => [p, warningsForPlatform(doc, PLATFORM_PROFILES[p], wordsByAsset, browserMeasureText, sizes)])) as Record<PlatformId, ReturnType<typeof warningsForPlatform>>,
    // fontsVersion: re-measure once webfonts load
    [doc, wordsByAsset, sizes, fontsVersion],
  );

  useEffect(() => {
    if (phase !== "running") return;
    const id = setInterval(() => setElapsed(Math.round((Date.now() - startedAt.current) / 1000)), 1000);
    return () => clearInterval(id);
  }, [phase]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && phase !== "running") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, onClose]);

  const patch = (id: StepId, p: Partial<Step>) => setSteps((s) => s.map((x) => (x.id === id ? { ...x, ...p } : x)));

  async function run() {
    if (platforms.size === 0 || !date) return;
    let state = itemState;
    const needSave = dirty || !["EDIT_PLANNED", "RENDERED", "READY", "SCHEDULED"].includes(state);
    const plan: Step[] = (["save", "render", "check", "schedule"] as StepId[]).map((id) => ({ id, label: LABELS[id], status: "waiting" }));
    setSteps(plan);
    setPhase("running");
    startedAt.current = Date.now();
    setElapsed(0);

    // 1. save
    if (needSave) {
      patch("save", { status: "running", detail: RUNNING_DETAIL.save });
      // Same as Save: AUTO graphics are saved where the preview shows them.
      const payload = buildSavePayload(withResolvedPlacements(doc, placement.visuals));
      if (!payload.ok) {
        patch("save", { status: "failed", detail: `Something in the edit isn't valid: ${payload.error}` });
        return setPhase("stopped");
      }
      const res = await saveFinishingEditAction({ contentItemId: itemId, timeline: payload.timeline }).catch(() => null);
      if (!res || !res.ok) {
        patch("save", { status: "failed", detail: res ? res.error : "Couldn't reach the server. Check your connection and try again." });
        return setPhase("stopped");
      }
      state = res.state;
      onSaved(state);
      patch("save", { status: "done", detail: "Saved as a new version." });
    } else {
      patch("save", { status: "skipped", detail: "Already saved." });
    }

    // 2. render
    // On the live site the render (+ the quality check right after it) runs in the cloud worker
    // and we follow its progress; locally it runs during the request, as before.
    let cloudCheck: { passed: boolean; reasons: string[] } | null = null;
    if (state === "EDIT_PLANNED") {
      patch("render", { status: "running", detail: RUNNING_DETAIL.render });
      const res = await renderStepAction(itemId, { thenQualityGate: true }).catch(() => null);
      if (!res || !res.ok) {
        if (res?.state) onStateChange(res.state);
        patch("render", { status: "failed", detail: res ? res.error : "Lost connection while rendering. Your edit is saved — try again." });
        return setPhase("stopped");
      }
      if ("pending" in res) {
        const jobRunId = res.jobRunId;
        const view = await waitForJob(jobRunId, (v) => {
          if (v.status !== "RUNNING") return;
          if (v.stage === "check") {
            patch("render", { status: "done", detail: "Rendered." });
            patch("check", { status: "running", detail: RUNNING_DETAIL.check });
          } else {
            setRenderPct(v.pct);
            patch("render", { status: "running", detail: v.message ?? RUNNING_DETAIL.render });
          }
        }).catch(() => null);
        const out = view ? await finishJobResultAction(itemId, jobRunId).catch(() => null) : null;
        if (!out || !out.ok) {
          if (out && !out.ok && out.state) onStateChange(out.state);
          patch("render", { status: "failed", detail: out ? out.error : "Lost track of the render (connection). It may still finish — reopen the video in a minute." });
          return setPhase("stopped");
        }
        state = out.state;
        onStateChange(state);
        if (!out.render.ok) {
          patch("render", { status: "failed", detail: out.render.error ?? "The render failed. Your edit is saved." });
          return setPhase("stopped");
        }
        patch("render", { status: "done", detail: "Rendered." });
        if (out.check && !out.check.ok) {
          patch("check", { status: "failed", detail: out.check.error });
          return setPhase("stopped");
        }
        if (out.check?.ok) cloudCheck = { passed: out.check.passed, reasons: out.check.reasons };
      } else {
        state = res.state;
        onStateChange(state);
        patch("render", { status: "done", detail: "Rendered." });
      }
    } else {
      patch("render", { status: "skipped", detail: "Already rendered from this edit." });
    }

    // 3. quality gate
    if (cloudCheck) {
      if (!cloudCheck.passed) {
        patch("check", {
          status: "failed",
          detail: "The quality check found something to fix before this can be scheduled. Your edit is saved.",
          reasons: cloudCheck.reasons,
        });
        return setPhase("stopped");
      }
      patch("check", { status: "done", detail: "Passed every check." });
    } else if (state === "RENDERED") {
      patch("check", { status: "running", detail: RUNNING_DETAIL.check });
      const res = await qualityGateStepAction(itemId).catch(() => null);
      if (!res || !res.ok) {
        if (res?.state) onStateChange(res.state);
        patch("check", { status: "failed", detail: res ? res.error : "Lost connection during the quality check. Your edit is saved — try again." });
        return setPhase("stopped");
      }
      state = res.state;
      onStateChange(state);
      if (!res.passed) {
        patch("check", {
          status: "failed",
          detail: "The quality check found something to fix before this can be scheduled. Your edit is saved.",
          reasons: res.reasons,
        });
        return setPhase("stopped");
      }
      patch("check", { status: "done", detail: "Passed every check." });
    } else if (state === "READY" || state === "SCHEDULED") {
      patch("check", { status: "skipped", detail: "Already passed." });
    } else {
      patch("check", { status: "failed", detail: `This video is “${state.toLowerCase().replace(/_/g, " ")}”, so it can't be checked right now.` });
      return setPhase("stopped");
    }

    // 4. schedule
    patch("schedule", { status: "running", detail: RUNNING_DETAIL.schedule });
    const res = await scheduleStepAction({ contentItemId: itemId, scheduledDate: date, platforms: [...platforms] }).catch(() => null);
    if (!res || !res.ok) {
      patch("schedule", { status: "failed", detail: res ? res.error : "Couldn't reach the server to schedule. Try again." });
      return setPhase("stopped");
    }
    onStateChange(res.state);
    setScheduledFor(res.scheduledFor);
    patch("schedule", { status: "done", detail: `Scheduled for ${res.scheduledFor} on ${[...platforms].map((p) => PLATFORM_SHORT_LABEL[p]).join(", ")}.` });
    setPhase("done");
  }

  const toggle = (p: PlatformId) =>
    setPlatforms((s) => {
      const n = new Set(s);
      if (n.has(p)) n.delete(p);
      else n.add(p);
      return n;
    });

  return (
    <div className="ed-modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && phase !== "running" && onClose()}>
      <div className={`ed-modal ${touch ? "ed-modal-touch" : ""}`} role="dialog" aria-modal="true" aria-labelledby="finish-title">
        <div className="flex items-start justify-between gap-4 px-6 pb-2 pt-6">
          <div>
            <p className="ed-eyebrow">Last step</p>
            <h2 id="finish-title" className="mt-1 text-[19px] font-semibold tracking-tight">
              {phase === "done" ? "It's on the calendar" : "Finish & schedule"}
            </h2>
          </div>
          {phase !== "running" && (
            <button type="button" className="ed-iconbtn" onClick={onClose} aria-label="Close">
              <Icon name="close" />
            </button>
          )}
        </div>

        {phase === "form" && (
          <div className="px-6 pb-6">
            <p className="mb-5 text-[13px] leading-relaxed text-[var(--color-text-muted)]">
              We&apos;ll save your edit, render it in full quality, run the quality check, and put it on the calendar — all in one go.
            </p>
            <div className="ed-finish-steps" aria-hidden>
              <span>1 Save</span>
              <i>›</i>
              <span>2 Render</span>
              <i>›</i>
              <span>3 Check</span>
              <i>›</i>
              <span>4 Schedule</span>
            </div>
            <label className="block">
              <span className="ed-label">When should it go out?</span>
              <input type="datetime-local" className="ed-input ed-date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Publish date and time" />
            </label>
            <div className="mt-5">
              <span className="ed-label">Where?</span>
              <div className="flex flex-col gap-1.5">
                {PLATFORM_IDS.map((p) => {
                  const warns = readiness[p];
                  const on = platforms.has(p);
                  return (
                    <div key={p} className={`ed-card ed-plat-row flex items-center gap-3 px-3 py-2.5 ${on ? "" : "opacity-70"}`} aria-pressed={on}>
                      <label htmlFor={`plat-${p}`} className="flex flex-1 cursor-pointer items-center gap-3 self-stretch text-[13.5px] font-medium">
                        <input type="checkbox" checked={on} onChange={() => toggle(p)} id={`plat-${p}`} className="ed-plat-check h-4 w-4 accent-[var(--color-gold-500)]" />
                        {PLATFORM_SHORT_LABEL[p]}
                      </label>
                      {warns.length === 0 ? (
                        <span className="flex items-center gap-1 text-[12px] text-[var(--color-emerald-400)]">
                          <Icon name="check" size={13} /> Ready
                        </span>
                      ) : (
                        <button
                          type="button"
                          className="flex items-center gap-1 text-[12px] text-[var(--color-gold-400)] underline decoration-dotted underline-offset-2"
                          title={warns.map((w) => w.message).join("\n")}
                          onClick={() => {
                            setUi({ platformView: p });
                            const first = warns.find((w) => w.target);
                            if (first?.target) focus(first.target);
                            onClose();
                          }}
                        >
                          <Icon name="warn" size={13} /> {warns.length} to check
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
              <p className="mt-2 text-[11.5px] leading-relaxed text-[var(--color-text-faint)]">
                Warnings are things the app&apos;s buttons might cover. You can still schedule — {touch ? "tap" : "click"} one to see it in the editor.
              </p>
            </div>
            <button type="button" className="btn btn-primary ed-finish-cta mt-6 w-full !py-2.5 !text-[14px]" disabled={platforms.size === 0 || !date} onClick={() => void run()}>
              Finish &amp; schedule
            </button>
          </div>
        )}

        {phase !== "form" && (
          <div className="px-6 pb-6">
            <ol className="mt-1">
              {steps.map((s, i) => (
                <li key={s.id} className={`ed-step ${s.status === "done" || s.status === "skipped" ? "ed-step-done" : s.status === "failed" ? "ed-step-fail" : s.status === "running" ? "ed-step-run" : ""}`}>
                  <span className="ed-step-dot">
                    {s.status === "running" ? <span className="ed-spinner" /> : s.status === "done" || s.status === "skipped" ? <Icon name="check" size={13} /> : s.status === "failed" ? <Icon name="close" size={12} /> : i + 1}
                  </span>
                  <div className="min-w-0 flex-1 pt-0.5">
                    <p className={`text-[13.5px] font-medium ${s.status === "waiting" ? "text-[var(--color-text-faint)]" : ""}`}>
                      {s.label}
                      {s.status === "running" && s.id === "render" && <span className="ml-2 text-[12px] font-normal tabular-nums text-[var(--color-text-faint)]">{renderPct != null && renderPct > 0 ? `${Math.round(renderPct)}% · ` : ""}{elapsed}s</span>}
                    </p>
                    {s.detail && <p className={`mt-0.5 text-[12.5px] leading-relaxed ${s.status === "failed" ? "text-[var(--color-rose-400)]" : "text-[var(--color-text-muted)]"}`}>{s.detail}</p>}
                    {s.reasons && s.reasons.length > 0 && (
                      <ul className="mt-2 list-disc space-y-1 pl-4 text-[12px] leading-relaxed text-[var(--color-text-muted)]">
                        {s.reasons.slice(0, 6).map((r, j) => (
                          <li key={j}>{r}</li>
                        ))}
                      </ul>
                    )}
                    {s.status === "running" && <div className="ed-progress" />}
                  </div>
                </li>
              ))}
            </ol>
            {phase === "done" && (
              <div className="mt-4 flex gap-2">
                <Link href="/calendar" className="btn btn-primary flex-1 !text-[13px]">
                  <Icon name="calendar" size={14} /> Open calendar
                </Link>
                <Link href={`/content/${itemId}`} className="btn btn-ghost flex-1 !text-[13px]">
                  Back to the video
                </Link>
              </div>
            )}
            {phase === "stopped" && (
              <div className="mt-4 flex gap-2">
                <button type="button" className="btn btn-ghost flex-1 !text-[13px]" onClick={onClose}>
                  Keep editing
                </button>
                <Link href={`/content/${itemId}`} className="btn btn-ghost flex-1 !text-[13px]">
                  Video page
                </Link>
              </div>
            )}
            {phase === "done" && scheduledFor && <p className="sr-only">Scheduled for {scheduledFor}</p>}
          </div>
        )}
      </div>
    </div>
  );
}
