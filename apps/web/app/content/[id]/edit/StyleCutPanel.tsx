"use client";

import { useState } from "react";
import type { FullEditChoices } from "@chris/media/timeline";
import { useEditor } from "./context";
import { setAutoEditModeAction, styleCutAction, designVisualsAction, designVisualsResultAction, type DesignUnderstanding } from "./actions";
import { aiPickHookAction, ensureBriefAction, aiFlowCheckAction } from "./ai-edit-actions";
import { waitForJob } from "../../../../lib/use-job-progress";

/**
 * "Auto edit" — the automatic edits, side by side (docs/decisions-pending/full-edit.md):
 *  - Full edit (free): hook first, the story said once and tight, graphics with his numbers.
 *  - Cuts only: the style cut — pauses out, punch-ins on his face.
 *  - AI edit (uses AI credit): the Full edit, then the AI picks the opening line and redesigns
 *    the graphics (docs/DECISIONS.md "AI edit").
 * Every choice is saved as a NEW version (undo brings the previous edit back). The full edit's
 * hook, title, graphics and removed lines can each be changed in one tap.
 */

export function StyleCutPanel() {
  const { itemId, dirty, loadSavedVersion, toast, styleCut, setStyleCut, doc, apply } = useEditor();
  const [busy, setBusy] = useState<null | string>(null);
  const [error, setError] = useState<string | null>(null);
  const [showRemoved, setShowRemoved] = useState(false);
  const [showHooks, setShowHooks] = useState(false);
  /** AI edit progress line while it runs; the AI's reason for its hook once done. */
  const [aiStep, setAiStep] = useState<string | null>(null);
  const [aiDone, setAiDone] = useState<{ hook: string; reason: string; graphics: number; added: number; dropped: Array<{ template: string; at: number; reason: string }>; flow: { fixed: number; issues: string[]; hookProblem: string | null; quotable: string | null } | null; understanding: DesignUnderstanding | null } | null>(null);
  /** A Full edit / AI edit ran in this session — the "older cut" notice no longer applies. */
  const [recut, setRecut] = useState(false);
  const current: "FULL" | "CUTS" | "AI" | null = styleCut.fullEditActive ? (aiDone ? "AI" : "FULL") : styleCut.active ? "CUTS" : null;
  const hasCaptions = styleCut.hasWords;
  const fe = styleCut.fullEdit;
  const hasExtras = doc.texts.length + doc.visuals.length + doc.zooms.length + doc.sfx.length > 0;

  const run = async (mode: "STYLE" | "PLAIN" | "FULL", choices?: FullEditChoices, label?: string) => {
    if (busy) return;
    if ((dirty || (hasExtras && mode !== "FULL")) && !window.confirm(`${dirty ? "Your unsaved changes will be replaced. " : ""}${hasExtras && mode !== "FULL" ? "Text and graphics are timed to the current cut, so they'll be removed. " : ""}You can undo this.`)) return;
    setBusy(label ?? mode);
    setError(null);
    setAiDone(null);
    try {
      const res = await styleCutAction({ contentItemId: itemId, mode, choices });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      loadSavedVersion(res.timeline, res.state);
      setStyleCut({
        ...styleCut,
        active: mode === "STYLE",
        fullEditActive: mode === "FULL",
        fullEdit: mode === "FULL" ? res.fullEdit : mode === "PLAIN" ? null : styleCut.fullEdit,
        summary: mode === "STYLE" ? (res.summary ?? styleCut.summary) : styleCut.summary,
        profileNote: res.profileNote ?? styleCut.profileNote,
      });
      if (mode === "FULL") setRecut(true);
      toast(mode === "FULL" ? "Full edit saved as a new version." : mode === "STYLE" ? "Cuts-only edit saved as a new version." : "Back to your full take — saved as a new version.");
    } catch {
      setError("Couldn't reach the server. Your edit is unchanged — try again.");
    } finally {
      setBusy(null);
    }
  };

  /** AI edit: Full edit base → AI picks the hook → AI designs the graphics. Each step saves a version. */
  const runAi = async () => {
    if (busy) return;
    if (dirty && !window.confirm("Your unsaved changes will be replaced. You can undo this.")) return;
    setBusy("AI");
    setError(null);
    setAiDone(null);
    try {
      // 0. The plan. A video filmed from the script or the ChatGPT paste has its Creative Brief;
      //    an older or footage-first one gets it recovered from the take, so the Full edit, the
      //    hook pick and the visuals all follow the playbook.
      if (!styleCut.brief) {
        setAiStep("AI is reading the footage and writing this video's plan…");
        const b = await ensureBriefAction({ contentItemId: itemId });
        if (!b.ok) return setError(b.error);
        setStyleCut({ ...styleCut, brief: b.brief });
      }
      // 1. The Full edit is the base (2026-10-23: back to the flow Chris judged better by
      //    watching — the Editor's cut is opt-in via "For new uploads: Editor" until it beats the
      //    free cut on the golden set). Then the AI picks the hook, reads the cut through, designs.
      let report: typeof fe = null;
      let sc = styleCut;
      {
        setAiStep("Making the Full edit from your take…");
        const res = await styleCutAction({ contentItemId: itemId, mode: "FULL", choices: styleCut.autoMode === "EDITOR" ? { useEditor: true } : {} });
        if (!res.ok) return setError(res.error);
        loadSavedVersion(res.timeline, res.state);
        report = res.fullEdit ?? null;
        sc = { ...sc, active: false, fullEditActive: true, fullEdit: report, profileNote: res.profileNote ?? sc.profileNote };
        setStyleCut(sc);
      }
      if (!report) return setError("The Full edit didn't come back — try again.");

      // 2. The AI picks the opening line among the sentences he said (only when no Editor plan —
      //    the Editor already chose the hook and read the cut through as a cold viewer).
      let hookText = report.hook.text;
      let hookReason = report.editor ? report.editor.rationale || "The Editor's opening line." : "Kept the Full edit's hook.";
      if (!report.editor && report.hook.candidates.length > 1) {
        setAiStep("AI is picking the strongest hook…");
        const pick = await aiPickHookAction({ contentItemId: itemId, candidates: report.hook.candidates });
        if (!pick.ok) return setError(pick.error);
        hookReason = pick.reason;
        if (pick.chosenIndex !== report.hook.chosenIndex) {
          setAiStep("Re-cutting with the AI's hook…");
          const res = await styleCutAction({ contentItemId: itemId, mode: "FULL", choices: { ...((report.choices ?? {}) as FullEditChoices), hookIndex: pick.chosenIndex } });
          if (!res.ok) return setError(res.error);
          loadSavedVersion(res.timeline, res.state);
          report = res.fullEdit ?? report;
          sc = { ...sc, fullEditActive: true, fullEdit: report };
          setStyleCut(sc);
        }
        hookText = report.hook.text;
      }

      // 2b. Read-through: a cold viewer hears only the kept lines in order. Junctions that
      //     don't follow get one surgical fix each (restore the cut line / drop the dependent),
      //     applied as Full-edit choices and re-cut. The hook is never touched.
      let flow: { fixed: number; issues: string[]; hookProblem: string | null; quotable: string | null } | null = null;
      if (!report.editor && report.kept.length > 1) {
        setAiStep("AI is reading the cut through as a cold viewer…");
        const chosen = report.hook.candidates[report.hook.chosenIndex];
        const fc = await aiFlowCheckAction({ contentItemId: itemId, kept: report.kept, removed: report.removed.map((r) => ({ sentenceId: r.sentenceId, text: r.text, kind: r.kind, why: r.why })), hookSentenceIds: chosen?.sentenceIds ?? [] });
        if (fc.ok) {
          flow = { fixed: fc.forceKeep.length + fc.forceDrop.length, issues: fc.issues.filter((i) => i.fix !== "NONE").map((i) => i.problem), hookProblem: fc.hookProblem, quotable: fc.quotable };
          if (fc.forceKeep.length || fc.forceDrop.length) {
            setAiStep("Re-cutting so every line follows the one before…");
            const prev = (report.choices ?? {}) as FullEditChoices;
            const res = await styleCutAction({ contentItemId: itemId, mode: "FULL", choices: { ...prev, hookIndex: report.hook.chosenIndex, forceKeep: [...new Set([...(prev.forceKeep ?? []), ...fc.forceKeep])], forceDrop: [...new Set([...(prev.forceDrop ?? []), ...fc.forceDrop])] } });
            if (!res.ok) return setError(res.error);
            loadSavedVersion(res.timeline, res.state);
            report = res.fullEdit ?? report;
            sc = { ...sc, fullEditActive: true, fullEdit: report };
            setStyleCut(sc);
            hookText = report.hook.text;
          }
        }
      }

      // 3. The AI designs the graphics for what he's saying (replaces the template ones).
      setAiStep("AI is understanding the video and planning what the viewer needs to see…");
      // The free edit's graphics (numbers he said) are the floor; the AI adds the concept
      // graphics the viewer needs on top, replacing one only on the same phrase.
      let vis = await designVisualsAction({ contentItemId: itemId, replaceExisting: false, strategize: true });
      if (vis.ok && "pending" in vis) {
        const jobRunId = vis.jobRunId;
        const done = await waitForJob(jobRunId, (v) => v.status === "RUNNING" && setAiStep(v.line ?? "AI is designing the graphics…"));
        vis = done.status === "SUCCEEDED" || done.status === "FAILED" ? await designVisualsResultAction(itemId, jobRunId) : { ok: false, error: "Designing didn't finish — try again." };
      }
      if (!vis.ok) return setError(`The hook is done, but the graphics step failed: ${vis.error}`);
      loadSavedVersion(vis.timeline, vis.state);
      setRecut(true);
      setAiDone({ hook: hookText, reason: hookReason, graphics: vis.timeline.visuals.length, added: vis.added.length, dropped: (vis.rejected ?? []).map((r) => ({ template: r.template, at: r.start, reason: r.reason })), flow, understanding: vis.understanding ?? null });
      toast("AI edit saved as a new version.");
    } catch {
      setError("Couldn't reach the server. Whatever finished is saved — try again.");
    } finally {
      setBusy(null);
      setAiStep(null);
    }
  };

  const prevChoices = (fe?.choices ?? {}) as FullEditChoices;
  const tryHook = (index: number) => run("FULL", { ...prevChoices, hookIndex: index }, `hook-${index}`);
  const restore = (sentenceId: number) =>
    run("FULL", { ...prevChoices, hookIndex: fe?.hook.chosenIndex, forceKeep: [...new Set([...(prevChoices.forceKeep ?? []), sentenceId])] }, `restore-${sentenceId}`);

  const titleId = fe?.hook.titleTextId ?? "fe-hook-title";
  const titleNow = doc.texts.find((t) => t.id === titleId)?.text ?? null;
  const setTitle = (text: string | null) =>
    apply((d) => {
      const t = d.texts.find((x) => x.id === titleId);
      if (!t) return d;
      return text == null ? { ...d, texts: d.texts.filter((x) => x.id !== titleId) } : { ...d, texts: d.texts.map((x) => (x.id === titleId ? { ...x, text } : x)) };
    });
  const removeVisual = (id: string) => apply((d) => ({ ...d, visuals: d.visuals.filter((v) => v.id !== id) }));

  const setDefault = async (mode: "EDITOR" | "FULL" | "CUTS") => {
    const r = await setAutoEditModeAction(mode);
    if (r.ok) {
      setStyleCut({ ...styleCut, autoMode: mode });
      toast(mode === "EDITOR" ? "New uploads get the Editor's cut (AI)." : mode === "FULL" ? "New uploads get the Full edit." : "New uploads get Cuts only.");
    } else setError(r.error);
  };

  if (!hasCaptions) {
    return (
      <div className="ed-section">
        <div className="ed-ai-card">
          <p className="text-[14px] font-semibold">Auto edit</p>
          <p className="mt-1 text-[12px] leading-relaxed text-[var(--color-text-muted)]">Needs captions first — they appear once your words are transcribed. Reopen the editor in a minute.</p>
        </div>
      </div>
    );
  }

  const Choice = (p: { id: "FULL" | "CUTS" | "AI"; title: string; blurb: string; onClick?: () => void; disabled?: boolean; badge?: string }) => (
    <button
      type="button"
      className={`fe-choice ${current === p.id ? "fe-choice-on" : ""}`}
      onClick={p.onClick}
      disabled={p.disabled || !!busy}
      data-testid={`auto-edit-${p.id.toLowerCase()}`}
    >
      <span className="flex items-center justify-between gap-2">
        <span className="text-[14px] font-semibold">{p.title}</span>
        {current === p.id ? <span className="fe-badge">Current</span> : p.badge ? <span className="fe-badge fe-badge-muted">{p.badge}</span> : null}
      </span>
      <span className="mt-0.5 block text-left text-[12px] leading-snug text-[var(--color-text-muted)]">
        {busy === (p.id === "FULL" ? "FULL" : "STYLE") && p.id !== "AI" ? "Working…" : p.blurb}
      </span>
    </button>
  );

  return (
    <div className="ed-section fe-panel">
      <div className="flex flex-col gap-2">
        <Choice id="FULL" title="Full edit (free)" blurb={styleCut.brief ? "Opens on your planned hook, keeps the story beats, every point said once, graphics with your numbers. No AI, free." : "Strong hook first, every point said once, graphics with your numbers. No AI, free."} onClick={() => void run("FULL", {}, "FULL")} />
        <Choice id="CUTS" title="Cuts only" blurb="Just takes out your pauses, with punch-ins on your face." onClick={() => void run("STYLE")} />
        <Choice id="AI" title="AI edit" blurb={busy === "AI" ? (aiStep ?? "Working…") : styleCut.brief ? "Full edit, then the AI picks the strongest hook, reads the cut through and designs the graphics. Uses AI credit." : "Writes this video's plan from the footage, then the Full edit, the AI's hook, the read-through and the graphics. Uses AI credit."} onClick={() => void runAi()} badge="AI" />
      </div>

      {styleCut.fullEditStale && !busy && !recut && (
        <p className="fe-summary mt-3 text-[12.5px] leading-snug" data-testid="fe-stale">
          The cut style was updated (cuts land right after the word, like your hand edits). This video still has the older cut — tap <span className="font-semibold">Full edit</span> to re-cut it; the current version stays in history.
        </p>
      )}

      <p className="mt-3 text-[12px] leading-snug text-[var(--color-text-muted)]" data-testid="fe-brief">
        {styleCut.brief ? (
          <>
            <span className="font-semibold">Plan:</span> {styleCut.brief.series} · opens on “{styleCut.brief.hook}” · ends to get a {styleCut.brief.objective.toLowerCase()}
            {styleCut.brief.source === "FOOTAGE" ? " (recovered from the footage)" : ""}
          </>
        ) : (
          <>No plan on record for this video. The free Full edit works from your words alone; <span className="font-semibold">AI edit</span> writes the plan from the footage first (about a cent).</>
        )}
      </p>

      {aiDone && (
        <div className="fe-summary mt-3" data-testid="ai-edit-summary">
          <p className="text-[13px] font-semibold leading-snug">AI hook: “{aiDone.hook}”</p>
          <p className="mt-1 text-[12px] leading-snug text-[var(--color-text-muted)]">{aiDone.reason}</p>
          {aiDone.flow && (
            <p className="mt-2 text-[12px] leading-snug" data-testid="ai-edit-flow">
              <span className="font-semibold">Read-through:</span>{" "}
              {aiDone.flow.fixed ? `${aiDone.flow.fixed} junction${aiDone.flow.fixed === 1 ? "" : "s"} fixed so every line follows the one before` : "every line follows the one before"}
              {aiDone.flow.issues.length ? ` — ${aiDone.flow.issues.slice(0, 3).join("; ")}` : ""}.
              {aiDone.flow.hookProblem ? ` Hook: ${aiDone.flow.hookProblem}` : ""}
              {aiDone.flow.quotable ? ` The line they'd quote: “${aiDone.flow.quotable}”` : ""}
            </p>
          )}
          <p className="mt-2 text-[12px] leading-snug" data-testid="ai-edit-graphics">
            <span className="font-semibold">{aiDone.graphics} graphic{aiDone.graphics === 1 ? "" : "s"} on the timeline</span> — {aiDone.added} added by the AI{aiDone.dropped.length ? `, ${aiDone.dropped.length} idea${aiDone.dropped.length === 1 ? "" : "s"} dropped` : ""}.
          </p>
          {aiDone.dropped.length > 0 && (
            <ul className="mt-1 flex flex-col gap-0.5" data-testid="ai-edit-dropped">
              {aiDone.dropped.slice(0, 6).map((d, i) => (
                <li key={i} className="text-[11.5px] leading-snug text-[var(--color-text-muted)]">
                  <span className="tabular-nums">{d.at.toFixed(1)} s</span> · {d.template.toLowerCase().replace(/_/g, " ")} — {d.reason}
                </li>
              ))}
            </ul>
          )}
          {aiDone.understanding && (
            <>
              <p className="mt-2 text-[12px] leading-snug"><span className="font-semibold">Message:</span> {aiDone.understanding.coreMessage}</p>
              <p className="mt-1 text-[12px] leading-snug text-[var(--color-text-muted)]"><span className="font-semibold">Viewer takeaway:</span> {aiDone.understanding.viewerTakeaway}</p>
              {aiDone.understanding.moments.length > 0 && (
                <ul className="mt-2 flex flex-col gap-1" data-testid="ai-edit-moments">
                  {aiDone.understanding.moments.map((m, i) => (
                    <li key={i} className="text-[11.5px] leading-snug text-[var(--color-text-muted)]">
                      <span className="tabular-nums">{m.start.toFixed(1)} s</span> · {m.need.toLowerCase().replace(/_/g, " ")} — {m.concept}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
          <p className="mt-2 text-[12px] text-[var(--color-text-muted)]">{aiDone.graphics} graphic{aiDone.graphics === 1 ? "" : "s"} designed for those moments.</p>
        </div>
      )}

      {fe && !aiDone && (
        <div className="fe-summary mt-3" data-testid="full-edit-summary">
          <p className="text-[13px] font-semibold leading-snug">
            Hook: “{fe.hook.text}”{fe.hook.coldOpen ? <span className="text-[var(--color-text-muted)] font-normal"> (moved to the start)</span> : null}
          </p>
          <p className="mt-1 text-[12px] text-[var(--color-text-muted)]" data-testid="full-edit-length">{fe.lengthLine} · {fe.visuals.length} graphic{fe.visuals.length === 1 ? "" : "s"}</p>

          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" className="btn btn-ghost fe-small" disabled={!!busy || fe.hook.candidates.length < 2} onClick={() => void tryHook((fe.hook.chosenIndex + 1) % fe.hook.candidates.length)}>
              {busy?.startsWith("hook-") ? "Re-cutting…" : "Try another hook"}
            </button>
            <button type="button" className="btn btn-ghost fe-small" onClick={() => setShowHooks((x) => !x)}>
              {showHooks ? "Hide hook options" : `All ${fe.hook.candidates.length} hook options`}
            </button>
          </div>
          {showHooks && (
            <ul className="mt-2 flex flex-col gap-1.5">
              {fe.hook.candidates.map((c) => (
                <li key={c.index}>
                  <button type="button" className={`fe-row ${c.index === fe.hook.chosenIndex ? "fe-row-on" : ""}`} disabled={!!busy || c.index === fe.hook.chosenIndex} onClick={() => void tryHook(c.index)}>
                    <span className="text-[12.5px] font-medium">“{c.text}”</span>
                    <span className="block text-[11px] text-[var(--color-text-faint)]">{c.reason}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {fe.hook.titles.length > 0 && (
            <div className="mt-3">
              <p className="fe-label">Hook title</p>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {fe.hook.titles.map((t) => (
                  <button key={t.text} type="button" className={`fe-chip ${titleNow === t.text ? "fe-chip-on" : ""}`} onClick={() => setTitle(t.text)} disabled={!titleNow}>
                    {t.text}
                  </button>
                ))}
                {titleNow && (
                  <button type="button" className="fe-chip" onClick={() => setTitle(null)}>
                    No title
                  </button>
                )}
              </div>
            </div>
          )}

          {fe.visuals.length > 0 && (
            <div className="mt-3">
              <p className="fe-label">Graphics</p>
              <ul className="mt-1 flex flex-col gap-1">
                {fe.visuals.map((v) => {
                  const there = doc.visuals.some((x) => x.id === v.id);
                  return (
                    <li key={v.id} className="flex items-center justify-between gap-2 text-[12.5px]">
                      <span className={`min-w-0 flex-1 ${there ? "" : "line-through opacity-50"}`}>
                        {v.start.toFixed(1)} s · {v.name} <span className="text-[var(--color-text-faint)]">— {v.reason}</span>
                      </span>
                      {there && (
                        <button type="button" className="fe-link" onClick={() => removeVisual(v.id)}>
                          Remove
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {fe.removed.length > 0 && (
            <div className="mt-3">
              <button type="button" className="fe-label fe-link" onClick={() => setShowRemoved((x) => !x)} data-testid="removed-lines-toggle">
                {showRemoved ? "▾" : "▸"} Removed lines ({fe.removed.length})
              </button>
              {showRemoved && (
                <ul className="mt-1 flex flex-col gap-1.5" data-testid="removed-lines">
                  {fe.removed.map((r) => (
                    <li key={r.sentenceId} className="fe-row flex items-start gap-2">
                      <span className="min-w-0 flex-1">
                        <span className="block text-[12.5px]">“{r.text}”</span>
                        <span className="block text-[11px] text-[var(--color-text-faint)]">{r.why}</span>
                      </span>
                      <button type="button" className="fe-link shrink-0" disabled={!!busy} onClick={() => void restore(r.sentenceId)}>
                        {busy === `restore-${r.sentenceId}` ? "…" : "Restore"}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <div className="mt-3">
            <p className="fe-label">Checks</p>
            <ul className="mt-1 flex flex-col gap-1">
              {fe.checks.map((c) => (
                <li key={c.id} className="text-[12px] leading-snug">
                  <span className={c.status === "WARN" ? "text-[var(--color-warn,#fbbf24)]" : "text-[var(--color-success,#6ee7b0)]"}>{c.status === "WARN" ? "!" : "✓"}</span>{" "}
                  <span className="font-medium">{c.name}</span> <span className="text-[var(--color-text-muted)]">{c.detail}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {current === "CUTS" && styleCut.summary && (
        <p className="mt-3 text-[12.5px] leading-relaxed text-[var(--color-text-muted)]">Cuts only: {styleCut.summary.charAt(0).toLowerCase() + styleCut.summary.slice(1)}.</p>
      )}

      {(current || fe) && (
        <button type="button" className="btn btn-ghost mt-3 w-full" onClick={() => void run("PLAIN")} disabled={!!busy}>
          {busy === "PLAIN" ? "Restoring…" : "Use my full take instead"}
        </button>
      )}

      <div className="mt-3 flex items-center justify-between gap-2 border-t border-[var(--color-border,#ffffff1a)] pt-3 text-[12px]">
        <span className="text-[var(--color-text-muted)]">New uploads get</span>
        <span className="flex gap-1">
          <button type="button" className={`fe-chip ${styleCut.autoMode === "EDITOR" ? "fe-chip-on" : ""}`} onClick={() => void setDefault("EDITOR")}>
            Editor (AI)
          </button>
          <button type="button" className={`fe-chip ${styleCut.autoMode === "FULL" ? "fe-chip-on" : ""}`} onClick={() => void setDefault("FULL")}>
            Full edit
          </button>
          <button type="button" className={`fe-chip ${styleCut.autoMode === "CUTS" ? "fe-chip-on" : ""}`} onClick={() => void setDefault("CUTS")}>
            Cuts only
          </button>
        </span>
      </div>
      {error && <p className="mt-2 text-[12.5px] text-[var(--color-danger,#f87171)]">{error}</p>}
    </div>
  );
}
