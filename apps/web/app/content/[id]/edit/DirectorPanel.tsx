"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DirectorMessageView, DirectorStateView, PreparedTurn } from "../../../../lib/director/server";
import { blobToBase64, composeFramesImage, type SpriteRef } from "../../../../lib/director/frames-image";
import { useEditor } from "./context";
import {
  directorPackAction,
  loadDirectorAction,
  requestUnderstandingAction,
  sendDirectorMessageAction,
  submitDirectorAnswerAction,
  undoDirectorAction,
} from "./director-actions";

/**
 * Director chat (docs/decisions-pending/director-chat.md): Chris describes his vision for the
 * video (type or dictate with the keyboard mic) and an editor builds it — for free through his
 * own ChatGPT (send the message + the frames image, paste the answer back), or with Claude when
 * he has AI credit. Every applied answer is a NEW version with a plain change list; Undo goes
 * back (as another new version). Follow-ups ("make the bills drop faster") are deltas.
 */

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    let ok: boolean;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

function newKey(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function DirectorPanel() {
  const { itemId, dirty, save, loadSavedVersion, toast } = useEditor();
  const [state, setState] = useState<DirectorStateView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [turn, setTurn] = useState<PreparedTurn | null>(null);
  const [busy, setBusy] = useState<null | "send" | "apply" | "ai" | "undo" | "pack">(null);
  const [answer, setAnswer] = useState("");
  const [errors, setErrors] = useState<string[]>([]);
  const [repair, setRepair] = useState<string | null>(null);
  const [copied, setCopied] = useState<"" | "ok" | "fix" | "manual">("");
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const imageBlob = useRef<Blob | null>(null);
  const keyRef = useRef(newKey());
  const askedUnderstanding = useRef(false);
  const listEnd = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    const r = await loadDirectorAction(itemId);
    if (!r.ok) {
      setLoadError(r.error);
      return null;
    }
    setLoadError(null);
    setState(r.state);
    return r.state;
  }, [itemId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Takes not read yet → start the free face read once, then poll until it's in.
  useEffect(() => {
    if (!state || state.missing.length === 0) return;
    if (!askedUnderstanding.current) {
      askedUnderstanding.current = true;
      void requestUnderstandingAction(itemId);
    }
    const t = window.setTimeout(() => void refresh(), 6000);
    return () => window.clearTimeout(t);
  }, [state, itemId, refresh]);

  // Reopening the panel with an unanswered message → rebuild its pack so the paste box is ready
  // (once, on open — never after an answer was just applied).
  const restoredPending = useRef(false);
  useEffect(() => {
    if (!state || restoredPending.current) return;
    restoredPending.current = true;
    if (!state.pendingMessage || turn) return;
    void (async () => {
      const r = await directorPackAction({ itemId, messageId: state.pendingMessage!.id });
      if (r.ok) setTurn(r.turn);
    })();
  }, [state, turn, itemId]);

  const sprites = useMemo(() => {
    const out: Record<string, SpriteRef> = {};
    for (const t of state?.takes ?? []) if (t.sprite) out[t.id] = { url: t.sprite.url, cols: t.sprite.cols, cellW: t.sprite.cellW, cellH: t.sprite.cellH };
    return out;
  }, [state?.takes]);

  // Compose the frames image for the current turn (free, in the browser).
  useEffect(() => {
    let alive = true;
    imageBlob.current = null;
    setImageUrl((u) => {
      if (u) URL.revokeObjectURL(u);
      return null;
    });
    if (!turn?.sheet) return;
    void composeFramesImage(turn.sheet, sprites).then((b) => {
      if (!alive || !b) return;
      imageBlob.current = b;
      setImageUrl(URL.createObjectURL(b));
    });
    return () => {
      alive = false;
    };
  }, [turn, sprites]);

  useEffect(() => {
    listEnd.current?.scrollIntoView({ block: "end" });
  }, [state?.messages.length, turn]);

  async function send() {
    const text = draft.trim();
    if (!text || busy) return;
    setBusy("send");
    setErrors([]);
    setRepair(null);
    try {
      if (dirty && !(await save())) {
        toast("Save your edit first — the Director works on the saved version.", "warn");
        return;
      }
      const r = await sendDirectorMessageAction({ itemId, message: text, clientKey: keyRef.current });
      if (!r.ok) {
        toast(r.error, "error");
        return;
      }
      keyRef.current = newKey();
      setDraft("");
      setAnswer("");
      setTurn(r.turn);
      await refresh();
    } finally {
      setBusy(null);
    }
  }

  async function share() {
    if (!turn) return;
    try {
      const files = imageBlob.current ? [new File([imageBlob.current], "frames.jpg", { type: "image/jpeg" })] : [];
      const data: ShareData = { text: turn.pack, ...(files.length ? { files } : {}) };
      if (navigator.canShare?.(data)) {
        await navigator.share(data);
        return;
      }
    } catch {
      /* fall back to copy */
    }
    setCopied((await copyText(turn.pack)) ? "ok" : "manual");
  }

  function applied(r: { timeline: unknown; state: string; changes: Array<{ text: string }>; noop: boolean }) {
    loadSavedVersion(r.timeline as never, r.state);
    setTurn(null);
    setAnswer("");
    setErrors([]);
    setRepair(null);
    toast(r.noop ? "Nothing to change — see the note." : `Done — ${r.changes.length} change${r.changes.length === 1 ? "" : "s"}, saved as a new version.`);
  }

  async function apply() {
    if (!turn || !answer.trim() || busy) return;
    setBusy("apply");
    try {
      const r = await submitDirectorAnswerAction({ itemId, replyToId: turn.messageId, text: answer });
      if (!r.ok) {
        setErrors(r.errors);
        setRepair(r.repairMessage || null);
      } else applied(r);
      await refresh();
    } finally {
      setBusy(null);
    }
  }

  async function askAi() {
    if (!turn || busy || !state?.ai.available) return;
    setBusy("ai");
    setErrors([]);
    try {
      const imageBase64 = imageBlob.current ? await blobToBase64(imageBlob.current) : null;
      const res = await fetch("/api/director/ask", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ itemId, messageId: turn.messageId, imageBase64 }) });
      const r = (await res.json()) as { ok: boolean; errors?: string[]; repairMessage?: string; timeline?: unknown; state?: string; changes?: Array<{ text: string }>; noop?: boolean };
      if (!r.ok) {
        setErrors(r.errors ?? ["The AI couldn't answer."]);
        setRepair(r.repairMessage || null);
      } else applied(r as { timeline: unknown; state: string; changes: Array<{ text: string }>; noop: boolean });
      await refresh();
    } catch {
      setErrors(["Couldn't reach the server. Nothing was changed."]);
    } finally {
      setBusy(null);
    }
  }

  async function undo(m: DirectorMessageView) {
    if (busy) return;
    setBusy("undo");
    try {
      let r = await undoDirectorAction({ itemId, appliedMessageId: m.id });
      if (!r.ok && "needsConfirm" in r && r.needsConfirm) {
        if (!window.confirm(`${r.error} Go back anyway? (It's saved as a new version — nothing is lost.)`)) return;
        r = await undoDirectorAction({ itemId, appliedMessageId: m.id, force: true });
      }
      if (!r.ok) toast(r.error, "error");
      else {
        loadSavedVersion(r.timeline as never, r.state);
        toast("Back to the version before that change (saved as a new version).");
      }
      await refresh();
    } finally {
      setBusy(null);
    }
  }

  const reading = (state?.missing.length ?? 0) > 0;

  return (
    <div className="ed-section dc-panel" data-testid="director-panel">
      <p className="text-[12px] leading-snug text-[var(--color-text-muted)]">
        Tell me the video you want — the story, the beats, what shows up where. I read your face and moves, then build it. Free with your ChatGPT{state?.ai.available ? ", or with AI credit" : ""}.
      </p>
      {reading && (
        <p className="dc-status mt-2" data-testid="director-reading">
          <span className="ed-spinner" /> Reading your face and moves… (free, about a minute)
        </p>
      )}
      {loadError && <p className="mt-2 text-[13px] text-[var(--color-rose-400)]">{loadError}</p>}

      <div className="dc-thread mt-3" data-testid="director-thread">
        {(state?.messages ?? []).map((m) => (
          <Bubble key={m.id} m={m} onUndo={() => void undo(m)} busy={!!busy} />
        ))}
        <div ref={listEnd} />
      </div>

      {turn && (
        <section className="dc-ask mt-3" data-testid="director-ask">
          <p className="ed-eyebrow mb-1">Ask ChatGPT (free)</p>
          <div className="grid grid-cols-2 gap-2">
            <button type="button" className="btn btn-primary !min-h-[48px]" onClick={() => void share()} data-testid="director-share">
              Send to ChatGPT
            </button>
            <button type="button" className="btn btn-ghost !min-h-[48px]" onClick={async () => setCopied((await copyText(turn.pack)) ? "ok" : "manual")} data-testid="director-copy">
              {copied === "ok" ? "Copied ✓" : "Copy message"}
            </button>
          </div>
          {imageUrl && (
            <a href={imageUrl} download="frames.jpg" className="btn btn-ghost mt-2 w-full" data-testid="director-frames">
              Save the frames image (attach it in ChatGPT)
            </a>
          )}
          <a href="https://chatgpt.com/" target="_blank" rel="noopener noreferrer" className="mt-2 block text-center text-[13px] text-[var(--color-gold-400)]">
            Open ChatGPT ↗
          </a>
          <p className="mt-1 text-center text-[11px] text-[var(--color-text-faint)]">
            {Math.round(turn.chars / 1000)}k characters{turn.sheet ? ` + ${turn.sheet.cells.length} frames` : ""} — paste it as one message{imageUrl ? " with the image attached" : ""}.
          </p>
          {copied === "manual" && <textarea readOnly value={turn.pack} rows={4} className="ed-input mt-2 w-full !text-[12px]" onFocus={(e) => e.currentTarget.select()} />}
          <label htmlFor="dc-answer" className="mt-3 block text-[14px] font-semibold">
            Paste ChatGPT&apos;s answer
          </label>
          <textarea
            id="dc-answer"
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            rows={4}
            placeholder="Paste the whole answer — the code block is enough."
            className="ed-input mt-1 w-full !text-[16px]"
            data-testid="director-answer"
          />
          <button type="button" className="btn btn-primary mt-2 w-full !min-h-[48px]" disabled={!answer.trim() || !!busy} onClick={() => void apply()} data-testid="director-apply">
            {busy === "apply" ? "Building it…" : "Build it"}
          </button>
          <button
            type="button"
            className="btn btn-ghost mt-2 w-full !min-h-[44px]"
            disabled={!state?.ai.available || !!busy}
            onClick={() => void askAi()}
            data-testid="director-ai"
            title={state?.ai.reason ?? undefined}
          >
            {busy === "ai" ? "The AI is editing…" : state?.ai.available ? `Ask AI instead · ≈ $${(turn.estimateUsd || state.ai.estimateUsd).toFixed(2)}` : "Ask AI · needs AI credit"}
          </button>
          {!state?.ai.available && state?.ai.reason && <p className="mt-1 text-center text-[11px] text-[var(--color-text-faint)]">{state.ai.reason}</p>}
        </section>
      )}

      {errors.length > 0 && (
        <div className="dc-errors mt-3" data-testid="director-errors">
          <p className="text-[13px] font-semibold text-[var(--color-rose-400)]">That answer didn&apos;t fit — nothing was changed.</p>
          <ul className="mt-1 list-disc pl-5 text-[12px] leading-snug text-[var(--color-text-muted)]">
            {errors.slice(0, 5).map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
          {repair && (
            <button type="button" className="btn btn-ghost mt-2 w-full" onClick={async () => setCopied((await copyText(repair)) ? "fix" : "manual")} data-testid="director-fixup">
              {copied === "fix" ? "Copied — paste it to ChatGPT ✓" : "Copy the fix-up message for ChatGPT"}
            </button>
          )}
        </div>
      )}

      <div className="dc-composer mt-3">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={3}
          placeholder={state?.messages.length ? "Change something… (“make the bills drop faster”, “move rent to the right”)" : "Describe your video… (tap the mic on your keyboard to talk)"}
          className="ed-input w-full !text-[16px]"
          aria-label="Your message to the Director"
          data-testid="director-input"
        />
        <button type="button" className="btn btn-primary mt-2 w-full !min-h-[48px]" disabled={!draft.trim() || !!busy} onClick={() => void send()} data-testid="director-send">
          {busy === "send" ? "Getting it ready…" : "Send"}
        </button>
      </div>
    </div>
  );
}

function Bubble({ m, onUndo, busy }: { m: DirectorMessageView; onUndo: () => void; busy: boolean }) {
  if (m.kind === "MESSAGE") {
    return (
      <div className="dc-bubble dc-me" data-testid="director-msg-chris">
        {m.text}
      </div>
    );
  }
  if (m.kind === "APPLIED") {
    return (
      <div className="dc-bubble dc-them" data-testid="director-msg-applied">
        {m.reply && <p className="mb-1">{m.reply}</p>}
        <ul className="dc-changes">
          {(m.changes ?? []).map((c, i) => (
            <li key={i} className={c.kind === "SKIPPED" ? "opacity-70" : ""}>
              {c.text}
            </li>
          ))}
        </ul>
        {(m.notes ?? []).length > 0 && (
          <ul className="dc-notes">
            {m.notes!.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        )}
        <p className="mt-1 text-[11px] text-[var(--color-text-faint)]">
          {m.provider === "AI" ? `By the AI${m.costUsd != null ? ` · $${m.costUsd.toFixed(3)}` : ""}` : "From your ChatGPT"} · new version saved
        </p>
        {m.undoable && (
          <button type="button" className="btn btn-ghost fe-small mt-1" onClick={onUndo} disabled={busy} data-testid="director-undo">
            Undo this change
          </button>
        )}
      </div>
    );
  }
  if (m.kind === "REJECTED") {
    return (
      <div className="dc-bubble dc-sys" data-testid="director-msg-rejected">
        {m.text}
        {(m.errors ?? []).slice(0, 3).map((e, i) => (
          <div key={i} className="text-[11px] opacity-80">
            · {e}
          </div>
        ))}
      </div>
    );
  }
  return <div className="dc-bubble dc-sys">{m.text}</div>;
}
