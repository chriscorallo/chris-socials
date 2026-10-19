"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { buildSavePayload } from "../../../../lib/editor/reducer";
import { withResolvedPlacements } from "../../../../lib/editor/visuals";
import { warningsForPlatform } from "../../../../lib/editor/platform-warnings";
import { PLATFORM_IDS, PLATFORM_PROFILES, PLATFORM_SHORT_LABEL, type PlatformId } from "../../../../lib/editor/platform-profiles";
import {
  saveFinishingEditAction,
  renderStepAction,
  qualityGateStepAction,
  scheduleStepAction,
  finishJobResultAction,
  qualitySettingsAction,
  setQualityModeAction,
  skipAiCheckAction,
  type QualitySettings,
} from "./actions";
import { waitForJob } from "../../../../lib/use-job-progress";
import { planQualityStep, onAiCheckFailure, skippedDetail } from "../../../../lib/editor/finish-quality";
import { useEditor } from "./context";
import { browserMeasureText } from "./measure";
import { Icon } from "./icons";
import { writeCaptionsAction, type CaptionView, type CaptionPlatform } from "../caption-actions";
import { CaptionEditor } from "../../../components/CaptionEditor";

type StepId = "save" | "render" | "check" | "captions" | "schedule";
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
  captions: "Write the captions",
  schedule: "Put it on the calendar",
};

const RUNNING_DETAIL: Record<StepId, string> = {
  save: "Saving a new version…",
  render: "Rendering in full quality — this can take a minute or two…",
  check: "Checking facts, brand, picture and sound…",
  captions: "Writing a caption for each app (and a YouTube title)…",
  schedule: "Scheduling…",
};

/** Owner override (docs/decisions-pending/quality-override.md). */
const SKIP_LABEL = "Free technical check (AI check skipped)";
const SKIP_RUNNING = "Checking the file, length, size, loudness and on-screen text — free…";

type SkipTrigger = "AI_UNAVAILABLE" | "OWNER_CHOICE";

interface PendingConfirm {
  trigger: SkipTrigger;
  reason: string | null;
  unverifiedClaims: string[];
  skippedChecks: string[];
}

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
  const [phase, setPhase] = useState<"form" | "running" | "done" | "stopped" | "confirm">("form");
  const [steps, setSteps] = useState<Step[]>([]);
  const [elapsed, setElapsed] = useState(0);
  const [renderPct, setRenderPct] = useState<number | null>(null);
  const [scheduledFor, setScheduledFor] = useState<string | null>(null);
  /** Text each app gets when it posts (written at the captions step, editable on the done screen). */
  const [captions, setCaptions] = useState<{ list: CaptionView[]; missing: { platform: CaptionPlatform; reason: string }[] } | null>(null);
  // "Quality check before scheduling" (Firm / Let me skip it) + can the AI run right now.
  const [quality, setQuality] = useState<QualitySettings | null>(null);
  const [skipThis, setSkipThis] = useState(false);
  const [modeSaving, setModeSaving] = useState(false);
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null);
  const [confirmChecked, setConfirmChecked] = useState(false);
  /** Set once the video went to READY via the owner override (done screen badge). */
  const [skippedAi, setSkippedAi] = useState<{ reason: string | null } | null>(null);
  /** Firm mode stopped because the AI can't run: offer the switch. */
  const [firmAiBlock, setFirmAiBlock] = useState<string | null>(null);
  const startedAt = useRef(0);

  useEffect(() => {
    let live = true;
    qualitySettingsAction()
      .then((q) => {
        if (!live) return;
        setQuality(q);
        setSkipThis(!q.ai.ready);
      })
      .catch(() => live && setQuality({ mode: "FIRM", ai: { ready: true, reason: null } }));
    return () => {
      live = false;
    };
  }, []);

  const sizes = useMemo(() => Object.fromEntries(assets.map((a) => [a.id, { width: a.width, height: a.height }])), [assets]);
  const tracks = useMemo(() => Object.fromEntries(assets.map((a) => [a.id, a.subjectTrack])), [assets]);
  const readiness = useMemo(
    () => Object.fromEntries(PLATFORM_IDS.map((p) => [p, warningsForPlatform(doc, PLATFORM_PROFILES[p], wordsByAsset, browserMeasureText, sizes, { visuals: placement.visuals, tracks })])) as Record<PlatformId, ReturnType<typeof warningsForPlatform>>,
    // fontsVersion: re-measure once webfonts load
    [doc, wordsByAsset, sizes, tracks, placement.visuals, fontsVersion],
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

  const aiReady = quality?.ai.ready ?? true;

  async function changeMode(mode: QualitySettings["mode"]) {
    if (!quality || quality.mode === mode) return;
    setModeSaving(true);
    const res = await setQualityModeAction(mode).catch(() => null);
    setModeSaving(false);
    if (res?.ok) {
      setQuality({ ...quality, mode });
      if (mode === "SKIP_ALLOWED" && !quality.ai.ready) setSkipThis(true);
    }
  }

  /** Captions never stop the Finish: an app the AI couldn't write for is typed on the done screen. */
  async function captionsStep() {
    patch("captions", { status: "running", detail: RUNNING_DETAIL.captions });
    const res = await writeCaptionsAction({ contentItemId: itemId, platforms: [...platforms] }).catch(() => null);
    const missing = res ? res.missing : [...platforms].map((p) => ({ platform: p as CaptionPlatform, reason: "couldn't reach the server" }));
    setCaptions({ list: res?.captions ?? [], missing });
    if (missing.length === 0) patch("captions", { status: "done", detail: "Written for each app — read or edit them below." });
    else patch("captions", { status: "done", detail: `Couldn't write ${missing.map((m) => PLATFORM_SHORT_LABEL[m.platform as PlatformId]).join(", ")} (${missing[0]!.reason}) — type it below before it posts.` });
  }

  async function scheduleStep() {
    await captionsStep();
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

  /** Owner override: free technical check → READY (journaled as Chris's decision) → schedule. */
  async function skipFlow(trigger: SkipTrigger, reason: string | null, factualConfirmed: boolean) {
    setPhase("running");
    setFirmAiBlock(null);
    patch("check", { label: SKIP_LABEL, status: "running", detail: SKIP_RUNNING, reasons: undefined });
    const res = await skipAiCheckAction({ contentItemId: itemId, trigger, aiUnavailableReason: reason, factualConfirmed }).catch(() => null);
    if (!res) {
      patch("check", { status: "failed", detail: "Lost connection during the technical check. Your edit is saved — try again." });
      return setPhase("stopped");
    }
    if (res.state) onStateChange(res.state);
    if (!res.ok) {
      if (res.needsConfirmation) {
        setConfirm({ trigger, reason, unverifiedClaims: res.needsConfirmation.unverifiedClaims, skippedChecks: res.needsConfirmation.skippedChecks });
        setConfirmChecked(false);
        patch("check", { status: "waiting", detail: "Technical check passed. Waiting for you to check the numbers…" });
        return setPhase("confirm");
      }
      patch("check", { status: "failed", detail: res.error, reasons: res.technicalReasons });
      return setPhase("stopped");
    }
    setConfirm(null);
    setSkippedAi({ reason });
    patch("check", { status: "done", detail: skippedDetail(reason) });
    await scheduleStep();
  }

  /** The AI check failed: skip if it couldn't run and the owner allows it, stop firmly if
   * Firm, otherwise show the error. */
  async function onCheckFailed(aiUnavailable: string | null | undefined, state: string | undefined, error: string) {
    const action = onAiCheckFailure(quality?.mode ?? "FIRM", aiUnavailable, state);
    if (action.kind === "SKIP") return skipFlow("AI_UNAVAILABLE", action.reason, false);
    if (action.kind === "FIRM_STOP") setFirmAiBlock(action.reason);
    patch("check", { status: "failed", detail: error });
    setPhase("stopped");
  }

  async function run() {
    if (platforms.size === 0 || !date) return;
    let state = itemState;
    const qPlan = planQualityStep({ mode: quality?.mode ?? "FIRM", ai: quality?.ai ?? { ready: true, reason: null }, skipThis });
    const skipAi = qPlan.kind === "SKIP";
    const needSave = dirty || !["EDIT_PLANNED", "RENDERED", "READY", "SCHEDULED"].includes(state);
    const plan: Step[] = (["save", "render", "check", "captions", "schedule"] as StepId[]).map((id) => ({ id, label: id === "check" && skipAi ? SKIP_LABEL : LABELS[id], status: "waiting" }));
    setSteps(plan);
    setPhase("running");
    setSkippedAi(null);
    setFirmAiBlock(null);
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
    // and we follow its progress; locally it runs during the request, as before. Skipping the
    // AI check: render only — the free technical check runs right after, here.
    let cloudCheck: { passed: boolean; reasons: string[] } | null = null;
    if (state === "EDIT_PLANNED") {
      patch("render", { status: "running", detail: RUNNING_DETAIL.render });
      const res = await renderStepAction(itemId, { thenQualityGate: !skipAi }).catch(() => null);
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
        if (out.check && !out.check.ok) return onCheckFailed(out.check.aiUnavailable, state, out.check.error);
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
      if (qPlan.kind === "SKIP") return skipFlow(qPlan.trigger, qPlan.reason, false);
      patch("check", { status: "running", detail: RUNNING_DETAIL.check });
      const res = await qualityGateStepAction(itemId).catch(() => null);
      if (!res) {
        patch("check", { status: "failed", detail: "Lost connection during the quality check. Your edit is saved — try again." });
        return setPhase("stopped");
      }
      if (!res.ok) {
        if (res.state) onStateChange(res.state);
        return onCheckFailed("aiUnavailable" in res ? res.aiUnavailable : null, res.state, res.error);
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
    await scheduleStep();
  }

  /** Firm mode stopped for lack of AI: switch the setting (audited) and finish without it. */
  async function switchToSkipAndContinue() {
    const reason = firmAiBlock;
    if (!quality) return;
    setModeSaving(true);
    const res = await setQualityModeAction("SKIP_ALLOWED").catch(() => null);
    setModeSaving(false);
    if (!res?.ok) return;
    setQuality({ ...quality, mode: "SKIP_ALLOWED" });
    await skipFlow("AI_UNAVAILABLE", reason, false);
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
              We&apos;ll save your edit, render it in full quality, run the quality check, write the caption for each app, and put it on the calendar — all in one go.
            </p>
            <div className="ed-finish-steps" aria-hidden>
              <span>1 Save</span>
              <i>›</i>
              <span>2 Render</span>
              <i>›</i>
              <span>3 Check</span>
              <i>›</i>
              <span>4 Captions</span>
              <i>›</i>
              <span>5 Schedule</span>
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
            {quality && (
              <div className="mt-5" data-testid="finish-quality">
                <span className="ed-label">Quality check before scheduling</span>
                <div className="ed-seg flex w-full" role="group" aria-label="Quality check before scheduling">
                  {(
                    [
                      ["FIRM", "Firm"],
                      ["SKIP_ALLOWED", "Let me skip it"],
                    ] as const
                  ).map(([m, label]) => (
                    <button key={m} type="button" className="!h-9 flex-1 !text-[13px]" aria-pressed={quality.mode === m} disabled={modeSaving} onClick={() => void changeMode(m)}>
                      {label}
                    </button>
                  ))}
                </div>
                {quality.mode === "FIRM" ? (
                  <p className="mt-2 text-[12px] leading-relaxed text-[var(--color-text-muted)]">
                    The AI checks (picture, brand &amp; voice, fact-check) must pass before it&apos;s scheduled.
                    {!aiReady && (
                      <span className="text-[var(--color-gold-400)]"> The AI can&apos;t run right now ({quality.ai.reason ?? "unavailable"}), so Finish will stop after rendering.</span>
                    )}
                  </p>
                ) : (
                  <>
                    <label className="ed-card mt-2 flex cursor-pointer items-center gap-3 px-3 py-2.5 text-[13px] font-medium">
                      <input
                        type="checkbox"
                        className="h-4 w-4 accent-[var(--color-gold-500)]"
                        checked={skipThis || !aiReady}
                        disabled={!aiReady}
                        onChange={(e) => setSkipThis(e.target.checked)}
                        data-testid="skip-ai-check"
                      />
                      Skip the AI check for this video
                    </label>
                    <p className="mt-2 text-[12px] leading-relaxed text-[var(--color-text-muted)]">
                      {!aiReady && <span className="text-[var(--color-gold-400)]">The AI can&apos;t run right now ({quality.ai.reason ?? "unavailable"}). </span>}
                      Free checks always run: the file, length, size, loudness and on-screen text. Skipped: the AI picture check, brand &amp; voice review and AI fact-check. It&apos;s logged as your decision and the video is marked &ldquo;Scheduled without AI quality check&rdquo;.
                    </p>
                  </>
                )}
              </div>
            )}
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
            {phase === "confirm" && confirm && (
              <div className="ed-card mt-4 px-4 py-3" data-testid="factual-confirm">
                <p className="text-[13.5px] font-semibold">Check the numbers first</p>
                <p className="mt-1 text-[12.5px] leading-relaxed text-[var(--color-text-muted)]">
                  These haven&apos;t been fact-checked against a source. Skipping the AI check means you&apos;re vouching for them:
                </p>
                <ul className="mt-2 list-disc space-y-1 pl-4 text-[12.5px] leading-relaxed">
                  {confirm.unverifiedClaims.map((c, j) => (
                    <li key={j}>{c}</li>
                  ))}
                </ul>
                <label className="mt-3 flex cursor-pointer items-center gap-3 text-[13px] font-medium">
                  <input type="checkbox" className="h-5 w-5 accent-[var(--color-gold-500)]" checked={confirmChecked} onChange={(e) => setConfirmChecked(e.target.checked)} data-testid="factual-confirm-check" />
                  I&apos;ve checked the numbers in this video
                </label>
                <div className="mt-3 flex gap-2">
                  <button type="button" className="btn btn-primary flex-1 !text-[13px]" disabled={!confirmChecked} onClick={() => void skipFlow(confirm.trigger, confirm.reason, true)}>
                    Skip the AI check &amp; schedule
                  </button>
                  <button type="button" className="btn btn-ghost flex-1 !text-[13px]" onClick={onClose}>
                    Keep editing
                  </button>
                </div>
              </div>
            )}
            {phase === "done" && skippedAi && (
              <p className="mt-3 flex items-center gap-1.5 text-[12.5px] text-[var(--color-gold-400)]" data-testid="skipped-ai-badge">
                <Icon name="warn" size={13} /> Scheduled without AI quality check
              </p>
            )}
            {phase === "stopped" && firmAiBlock && (
              <div className="ed-card mt-4 px-4 py-3" data-testid="firm-ai-block">
                <p className="text-[12.5px] leading-relaxed text-[var(--color-text-muted)]">
                  The quality check is set to <b>Firm</b>. To schedule now without the AI check (the free technical check still runs), switch to &ldquo;Let me skip it&rdquo;.
                </p>
                <button type="button" className="btn btn-primary mt-3 w-full !text-[13px]" disabled={modeSaving} onClick={() => void switchToSkipAndContinue()}>
                  Let me skip it &amp; schedule
                </button>
              </div>
            )}
            {phase === "done" && captions && (
              <div className="mt-5" data-testid="finish-captions">
                <p className="ed-label">What each app will show</p>
                <CaptionEditor contentItemId={itemId} platforms={[...platforms] as CaptionPlatform[]} initial={captions.list} missing={captions.missing} />
              </div>
            )}
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
