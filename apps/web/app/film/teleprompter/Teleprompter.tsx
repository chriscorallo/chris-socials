"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { RecordMode } from "./RecordMode";
import { FloatMode } from "./FloatMode";
import { DEFAULT_SETTINGS, loadEdit, loadSettings, saveEdit, saveSettings, type PrompterSettings } from "../../../lib/teleprompter/settings";
import { resolveSavedEdit, textFingerprint, titleForNewVideo, type PrompterSource } from "../../../lib/teleprompter/script-source";
import { estimateSeconds, formatDuration, speedToWpm, wordCount } from "../../../lib/teleprompter/scroll";
import type { HandoffTarget } from "../../../lib/teleprompter/handoff";
import type { PrompterDraft } from "../../../lib/teleprompter/data";
import { totalSeconds } from "../../../lib/teleprompter/segments";
import { discardRecordingDraft } from "./actions";

type Screen = "setup" | "record" | "float";

/**
 * Teleprompter: one screen to check the script, then either record here (camera + script) or
 * float the script over the iPhone Camera app. Script edits are for this session only (kept on
 * this phone per video) — they never overwrite the video's script versions.
 */
export function Teleprompter({
  video,
  source,
  mode,
  draft: initialDraft = null,
}: {
  /** null = a brand-new video (created footage-first when a take is used). */
  video: { id: string; title: string } | null;
  source: PrompterSource;
  mode: "blob" | "local";
  /** The video's open recording draft (segmented "Record here"), if any. */
  draft?: PrompterDraft | null;
}) {
  const [draft, setDraft] = useState<PrompterDraft | null>(initialDraft);
  const [discarding, setDiscarding] = useState(false);
  const [discardError, setDiscardError] = useState<string | null>(null);
  const [screen, setScreen] = useState<Screen>("setup");
  const [settings, setSettingsState] = useState<PrompterSettings>(DEFAULT_SETTINGS);
  const [text, setText] = useState(source.text);
  const [edited, setEdited] = useState(false);
  const [title, setTitle] = useState("");
  const editId = video?.id ?? "new";

  // Per-phone preferences + this video's local script tweak (if the script hasn't changed since).
  useEffect(() => {
    setSettingsState(loadSettings());
    const r = resolveSavedEdit(source, video ? loadEdit(editId) : loadEdit("new"));
    setText(r.text);
    setEdited(r.edited);
  }, [source, video, editId]);

  function setSettings(s: PrompterSettings) {
    setSettingsState(s);
    saveSettings(s);
  }

  function onText(next: string) {
    setText(next);
    const changed = next !== source.text;
    setEdited(changed);
    saveEdit(editId, changed ? { base: textFingerprint(source.text), text: next } : null);
  }

  const target: HandoffTarget = video ? { kind: "existing", contentItemId: video.id } : { kind: "new", title: titleForNewVideo(title, text) };
  const words = wordCount(text);
  const ready = words > 0;
  const uploadManyHref = "/plan/upload";
  const draftParts = draft?.segments.length ?? 0;

  async function discard() {
    if (!draft) return;
    if (!window.confirm(`Discard this draft? ${draftParts === 1 ? "The part you filmed" : `All ${draftParts} parts you filmed`} will be deleted.`)) return;
    setDiscarding(true);
    setDiscardError(null);
    const r = await discardRecordingDraft(draft.contentItemId, draft.recordingSessionId);
    setDiscarding(false);
    if ("error" in r) setDiscardError(r.error);
    else setDraft(null);
  }

  if (screen === "record") {
    // Portal to <body>: the page shell is its own stacking context (z-10), which would keep the
    // full-screen camera under the fixed tab bar.
    return createPortal(
      <RecordMode
        text={text}
        fingerprint={textFingerprint(text)}
        draft={draft}
        onDraftChange={setDraft}
        settings={settings}
        setSettings={setSettings}
        target={target}
        mode={mode}
        onExit={() => setScreen("setup")}
        onUseIphoneCamera={() => setScreen("float")}
      />,
      document.body,
    );
  }

  if (screen === "float") {
    return (
      <div className="flex flex-col gap-4">
        <button type="button" onClick={() => setScreen("setup")} className="-ml-2 inline-flex min-h-[44px] items-center gap-1 self-start rounded-full px-2 text-[15px] text-[var(--color-gold-400)]">
          <svg width="9" height="16" viewBox="0 0 9 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M8 1 1 8l7 7" />
          </svg>
          Script
        </button>
        <h2 className="text-[22px] font-semibold leading-tight">Float the script over Camera</h2>
        <FloatMode text={text} settings={settings} setSettings={setSettings} target={target} mode={mode} uploadManyHref={uploadManyHref} onRecordHere={() => setScreen("record")} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {draft && (
        <section className="panel flex flex-col gap-3 !border-[var(--color-gold-500)]/50 p-4" data-testid="draft-panel">
          <div className="min-w-0">
            <p className="eyebrow">Draft</p>
            <p className="mt-0.5 text-[17px] font-semibold leading-snug">
              {draftParts} {draftParts === 1 ? "part" : "parts"} · {formatDuration(totalSeconds(draft.segments))} filmed
            </p>
            <p className="mt-0.5 text-[13.5px] text-[var(--color-text-muted)]">Pick up where you stopped — the script opens at the same spot.</p>
          </div>
          <button type="button" className="btn btn-primary w-full !min-h-[52px] !text-[16px]" onClick={() => setScreen("record")} disabled={!ready} data-testid="continue-filming">
            Continue filming
          </button>
          <button type="button" className="btn btn-ghost w-full" onClick={() => void discard()} disabled={discarding} data-testid="discard-draft">
            {discarding ? "Discarding…" : "Discard draft"}
          </button>
          {discardError && <p className="text-[13px] text-[var(--color-rose-400)]">{discardError}</p>}
        </section>
      )}
      {!video && (
        <label className="block">
          <span className="field-label">What&apos;s this video about? (optional)</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Why your 401(k) match is free money" className="field-input" />
        </label>
      )}

      <section className="panel flex flex-col gap-2 p-4">
        <div className="flex items-baseline justify-between gap-3">
          <p className="eyebrow">{edited ? "Edited for this session" : source.label}</p>
          {edited && (
            <button type="button" className="link-quiet min-h-[44px] shrink-0 text-[13.5px]" onClick={() => onText(source.text)}>
              Undo my changes
            </button>
          )}
        </div>
        <textarea
          value={text}
          onChange={(e) => onText(e.target.value)}
          rows={9}
          placeholder="Type or paste what you want to say. Blank lines start a new paragraph."
          className="field-input !min-h-[200px] !text-[16px] leading-relaxed"
          data-testid="prompter-text"
        />
        <p className="text-[12.5px] text-[var(--color-text-faint)]">
          {ready ? `${words} words · about ${formatDuration(estimateSeconds(words, speedToWpm(settings.speed)))} at speed ${settings.speed}.` : "Add your script to start."}
          {" "}Changes here are just for filming — your saved script stays the same.
        </p>
      </section>

      <div className="grid gap-3">
        <ModeCard
          title={draft ? "Continue in Record here" : "Record here"}
          body="Camera and script on one screen, right under the front lens. Record in parts — pause anytime, finish now or later."
          onClick={() => setScreen("record")}
          disabled={!ready}
          primary
          testId="mode-record"
          icon={
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <rect x="3" y="6" width="13" height="12" rx="2.5" />
              <path d="m16 10 5-3v10l-5-3" />
            </svg>
          }
        />
        <ModeCard
          title="Use iPhone Camera"
          body="Keep Cinematic mode, stabilization and HDR. The script floats on top of the Camera app."
          onClick={() => setScreen("float")}
          disabled={!ready}
          testId="mode-float"
          icon={
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <rect x="3" y="4" width="18" height="16" rx="3" />
              <rect x="11" y="11" width="8" height="7" rx="1.5" />
            </svg>
          }
        />
      </div>
    </div>
  );
}

function ModeCard({ title, body, onClick, disabled, primary, icon, testId }: { title: string; body: string; onClick: () => void; disabled?: boolean; primary?: boolean; icon: React.ReactNode; testId: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
      className={`flex min-h-[88px] items-center gap-4 rounded-3xl border p-4 text-left transition-colors disabled:opacity-40 ${
        primary ? "border-[var(--color-gold-500)]/60 bg-[var(--color-gold-500)]/[0.1] active:bg-[var(--color-gold-500)]/20" : "border-[var(--color-border-strong)] bg-white/[0.03] active:bg-white/[0.08]"
      }`}
    >
      <span className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl ${primary ? "bg-[var(--color-gold-500)]/20 text-[var(--color-gold-400)]" : "bg-white/[0.07] text-[var(--color-text)]"}`}>{icon}</span>
      <span className="min-w-0">
        <span className="block text-[17px] font-semibold">{title}</span>
        <span className="mt-0.5 block text-[13.5px] leading-snug text-[var(--color-text-muted)]">{body}</span>
      </span>
    </button>
  );
}
