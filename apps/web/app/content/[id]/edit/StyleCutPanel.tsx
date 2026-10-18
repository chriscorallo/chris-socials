"use client";

import { useState } from "react";
import type { FullEditChoices } from "@chris/media/timeline";
import { useEditor } from "./context";
import { setAutoEditModeAction, styleCutAction } from "./actions";

/**
 * "Auto edit" — the automatic edits, side by side (docs/decisions-pending/full-edit.md):
 *  - Full edit (free): hook first, the story said once and tight, graphics with his numbers.
 *  - Cuts only: the style cut — pauses out, punch-ins on his face.
 *  - AI edit: later (needs AI credit).
 * Every choice is saved as a NEW version (undo brings the previous edit back). The full edit's
 * hook, title, graphics and removed lines can each be changed in one tap.
 */

const KIND_LABEL: Record<string, string> = {
  REPEAT: "Said twice",
  RETAKE: "Retake",
  FLUFF: "Filler line",
  TANGENT: "Tangent",
  GREETING: "Greeting",
  META: "About the video",
  SIGN_OFF: "Sign-off",
  RECAP: "Recap",
  LOW_VALUE: "Trimmed for length",
  DANGLING: "Needs a cut line",
  EXTRA_CTA: "Extra call to action",
  SLOW_START: "Slow start",
};

export function StyleCutPanel() {
  const { itemId, dirty, loadSavedVersion, toast, styleCut, setStyleCut, doc, apply } = useEditor();
  const [busy, setBusy] = useState<null | string>(null);
  const [error, setError] = useState<string | null>(null);
  const [showRemoved, setShowRemoved] = useState(false);
  const [showHooks, setShowHooks] = useState(false);
  const hasCaptions = styleCut.hasWords;
  const fe = styleCut.fullEdit;
  const current: "FULL" | "CUTS" | null = styleCut.fullEditActive ? "FULL" : styleCut.active ? "CUTS" : null;
  const hasExtras = doc.texts.length + doc.visuals.length + doc.zooms.length + doc.sfx.length > 0;

  const run = async (mode: "STYLE" | "PLAIN" | "FULL", choices?: FullEditChoices, label?: string) => {
    if (busy) return;
    if ((dirty || (hasExtras && mode !== "FULL")) && !window.confirm(`${dirty ? "Your unsaved changes will be replaced. " : ""}${hasExtras && mode !== "FULL" ? "Text and graphics are timed to the current cut, so they'll be removed. " : ""}You can undo this.`)) return;
    setBusy(label ?? mode);
    setError(null);
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
      toast(mode === "FULL" ? "Full edit saved as a new version." : mode === "STYLE" ? "Cuts-only edit saved as a new version." : "Back to your full take — saved as a new version.");
    } catch {
      setError("Couldn't reach the server. Your edit is unchanged — try again.");
    } finally {
      setBusy(null);
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

  const setDefault = async (mode: "FULL" | "CUTS") => {
    const r = await setAutoEditModeAction(mode);
    if (r.ok) {
      setStyleCut({ ...styleCut, autoMode: mode });
      toast(mode === "FULL" ? "New uploads get the Full edit." : "New uploads get Cuts only.");
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
        <Choice id="FULL" title="Full edit (free)" blurb="Strong hook first, every point said once, graphics with your numbers. No AI, free." onClick={() => void run("FULL", {}, "FULL")} />
        <Choice id="CUTS" title="Cuts only" blurb="Just takes out your pauses, with punch-ins on your face." onClick={() => void run("STYLE")} />
        <Choice id="AI" title="AI edit" blurb="Needs AI credit — coming later." disabled badge="Later" />
      </div>

      {fe && (
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
                        <span className="block text-[11px] text-[var(--color-text-faint)]">{KIND_LABEL[r.kind] ?? r.kind} — {r.why}</span>
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
