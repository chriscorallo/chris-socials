"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { StudioFilmView } from "../../../lib/studio/view";
import {
  approveAction,
  confirmFactsAction,
  demoAnswerAction,
  editLineAction,
  finalCheckAction,
  redoShotAction,
  resumeAction,
  sendToVideosAction,
  skipFinalCheckAction,
  submitAnswerAction,
} from "../actions";

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* fall through */
  }
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

const MODE_LABEL = { AUTO: "Automatic", CHATGPT: "ChatGPT", ENGINE: "Engine", CHRIS: "You" } as const;
const STATE_DOT: Record<string, string> = {
  idle: "bg-white/15",
  working: "bg-[var(--color-violet-400)] animate-pulse",
  waiting: "bg-[var(--color-gold-400)] animate-pulse",
  done: "bg-[var(--color-emerald-400)]",
  flagged: "bg-[var(--color-rose-400)]",
};
const VERDICT_TONE: Record<string, string> = { MATCH: "badge-emerald", WEAK: "badge-gold", MISMATCH: "badge-rose" };

function Pill({ tone, children }: { tone: string; children: React.ReactNode }) {
  return <span className={`badge ${tone} !text-[12px] !normal-case !tracking-normal`}>{children}</span>;
}

export function StudioFilmClient({ initial, demo }: { initial: StudioFilmView; demo: boolean }) {
  const [view, setView] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async (advance: boolean) => {
    try {
      const res = await fetch(`/api/studio/films/${initial.id}`, { method: advance ? "POST" : "GET", cache: "no-store" });
      if (res.ok) setView((await res.json()) as StudioFilmView);
    } catch {
      /* flaky mobile connection — the next tick retries */
    }
  }, [initial.id]);

  // While the automatic crew or the engine is working, keep advancing (resumable, one worker per film).
  useEffect(() => {
    if (view.phase !== "crew" && view.phase !== "rendering") return;
    timer.current = setTimeout(() => void load(true), view.phase === "crew" ? 900 : 2500);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [view, load]);

  async function act(label: string, fn: () => Promise<{ ok: boolean; message?: string }>) {
    setBusy(label);
    setMessage(null);
    try {
      const r = await fn();
      if (!r.ok) setMessage(r.message ?? "That didn't work.");
      await load(true);
    } finally {
      setBusy(null);
    }
  }

  const v = view;
  return (
    <div className="flex flex-col gap-4" data-testid="studio-film" data-phase={v.phase}>
      <header>
        <p className="eyebrow mb-1">Mini-movie</p>
        <h1 className="text-[26px] font-semibold leading-tight tracking-tight">{v.title}</h1>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-[13px] text-[var(--color-text-muted)]">
          <Pill tone={v.phase === "ready" ? "badge-emerald" : v.phase === "blocked" || v.phase === "failed" ? "badge-rose" : v.phase === "chatgpt" || v.phase === "storyboard" ? "badge-gold" : "badge-violet"}>{v.statusLabel}</Pill>
          <span>
            Round {v.iteration} of {v.maxIterations}
          </span>
          <span aria-hidden>·</span>
          <span>
            {v.roundTrips} ChatGPT round{v.roundTrips === 1 ? "" : "s"}
          </span>
          <span aria-hidden>·</span>
          <span data-testid="cost-so-far">Spent $0</span>
        </div>
        {v.statusMessage && <p className="mt-3 text-[15px] leading-snug">{v.statusMessage}</p>}
      </header>

      {message && <p className="rounded-xl bg-[color-mix(in_srgb,var(--color-rose-500)_14%,transparent)] px-3 py-2 text-[14px] leading-snug text-[var(--color-rose-400)]" role="alert">{message}</p>}

      {(v.phase === "blocked" || v.phase === "stopped" || v.phase === "failed") && (
        <section className="panel p-4" data-testid="blocked">
          <p className="text-[16px] font-semibold">{v.phase === "blocked" ? "Blocked — this can't render yet" : v.phase === "stopped" ? "Stopped" : "Something broke on our side"}</p>
          <ul className="mt-2 list-disc pl-5 text-[14px] leading-snug text-[var(--color-text-muted)]">
            {[...v.blockedReasons, ...(v.lastError ? [v.lastError] : [])].map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
          {v.can.resume && (
            <button className="btn btn-primary mt-3 w-full" disabled={!!busy} onClick={() => act("resume", () => resumeAction(v.id))}>
              {busy === "resume" ? "Resuming…" : "Resume"}
            </button>
          )}
        </section>
      )}

      {v.pending && <AskChatGpt view={v} demo={demo} busy={busy} onSubmitted={() => load(true)} onSkip={() => act("skip", () => skipFinalCheckAction(v.id))} />}

      {v.phase === "rendering" && (
        <section className="panel p-4">
          <p className="text-[16px] font-semibold">Rendering your film…</p>
          <p className="mt-1 text-[14px] text-[var(--color-text-muted)]">Narration, picture, score and the −14 LUFS mix. You can leave this page — it keeps going.</p>
        </section>
      )}

      {(v.phase === "ready" || v.render) && v.render && (
        <section className="panel p-4" data-testid="film-ready">
          <p className="eyebrow mb-2">Your film</p>
          {v.render.videoUrl ? (
            <video src={v.render.videoUrl} poster={v.render.posterUrl ?? undefined} controls playsInline className="mx-auto aspect-[9/16] w-full max-w-[340px] rounded-xl bg-black" />
          ) : (
            <div className="mx-auto flex aspect-[9/16] w-full max-w-[260px] flex-col items-center justify-center gap-2 overflow-hidden rounded-xl bg-black text-center">
              {v.render.posterUrl && <img src={v.render.posterUrl} alt="First frame" className="w-full" />}
            </div>
          )}
          <p className="mt-2 text-center text-[13px] text-[var(--color-text-faint)]">
            {v.render.durationSeconds.toFixed(1)} s{v.render.loudnessLufs != null ? ` · ${v.render.loudnessLufs.toFixed(1)} LUFS` : ""}
            {!v.render.videoUrl ? " · the video file appears here once the render worker is connected" : ""}
          </p>
          {v.finalReports.length > 0 && (
            <ul className="mt-3 flex flex-col gap-2">
              {v.finalReports.map((r, i) => (
                <li key={i} className="rounded-xl bg-[var(--color-surface-raised)] p-3 text-[14px] leading-snug">
                  <span className="font-semibold">{r.who}:</span> {r.summary}
                </li>
              ))}
            </ul>
          )}
          <div className="mt-3 grid gap-2">
            {v.contentItemId ? (
              <Link href={`/content/${v.contentItemId}`} className="btn btn-ghost w-full">
                Open it in Videos
              </Link>
            ) : (
              v.can.sendToVideos && (
                <button className="btn btn-primary w-full !min-h-[52px]" disabled={!!busy} onClick={() => act("send", async () => sendToVideosAction(v.id))} data-testid="send-to-videos">
                  {busy === "send" ? "Sending…" : "Send to Videos"}
                </button>
              )
            )}
            {v.can.finalCheck && (
              <button className="btn btn-ghost w-full" disabled={!!busy} onClick={() => act("final", () => finalCheckAction(v.id))}>
                Optional: ask ChatGPT to check the finished film
              </button>
            )}
          </div>
        </section>
      )}

      {v.storyboard.length > 0 && (v.phase === "storyboard" || v.phase === "ready" || v.phase === "chatgpt" || v.phase === "blocked") && <Storyboard view={v} busy={busy} act={act} />}

      <CrewRoom view={v} />

      <details className="panel">
        <summary className="flex min-h-[56px] cursor-pointer items-center px-4 text-[15px] font-semibold">What the crew did ({v.crew.timeline.length})</summary>
        <ol className="flex flex-col gap-2 px-4 pb-4" data-testid="timeline">
          {v.crew.timeline.map((t, i) => (
            <li key={i} className="text-[13.5px] leading-snug">
              <span className={`mr-1 font-semibold ${t.gate === "BLOCK" ? "text-[var(--color-rose-400)]" : ""}`}>{t.who}</span>
              <span className="text-[var(--color-text-faint)]">({t.via.toLowerCase().replace("_", " ")})</span> {t.summary}
            </li>
          ))}
        </ol>
      </details>

      {v.versions.length > 0 && (
        <details className="panel">
          <summary className="flex min-h-[56px] cursor-pointer items-center px-4 text-[15px] font-semibold">Versions ({v.versions.length})</summary>
          <ul className="flex flex-col gap-2 px-4 pb-4">
            {v.versions.map((x) => (
              <li key={x.version} className="text-[13.5px] leading-snug">
                <span className="font-semibold">v{x.version}</span> <span className="text-[var(--color-text-faint)]">{x.origin.toLowerCase().replace(/_/g, " ")}</span>
                {x.current && <span className="ml-1 text-[var(--color-gold-400)]">· current</span>} — {x.note}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function AskChatGpt({ view, demo, busy, onSubmitted, onSkip }: { view: StudioFilmView; demo: boolean; busy: string | null; onSubmitted: () => Promise<void>; onSkip: () => void }) {
  const p = view.pending!;
  const [text, setText] = useState("");
  const [copied, setCopied] = useState<"" | "ok" | "manual" | "fix">("");
  const [errors, setErrors] = useState<string[]>(p.lastErrors);
  const [repair, setRepair] = useState<string | null>(p.repairMessage);
  const [sending, setSending] = useState(false);
  const isSketch = view.storyboardIsSketch && !!p.imageUrl;
  const stepLabel = p.kind === "WRITE" ? "Step 1 of 2" : p.kind === "REVIEW" ? "Step 2 of 2" : p.kind === "FINAL" ? "Optional" : "Quick fix";

  async function share() {
    try {
      const files: File[] = [];
      if (p.imageUrl && !isSketch) {
        const blob = await (await fetch(p.imageUrl)).blob();
        files.push(new File([blob], "storyboard.jpg", { type: blob.type || "image/jpeg" }));
      }
      const data: ShareData = { text: p.prompt, ...(files.length ? { files } : {}) };
      if (navigator.canShare?.(data)) {
        await navigator.share(data);
        return;
      }
    } catch {
      /* fall back to copy */
    }
    setCopied((await copyText(p.prompt)) ? "ok" : "manual");
  }

  async function submit() {
    setSending(true);
    try {
      const r = await submitAnswerAction(view.id, text);
      if (!r.ok) {
        setErrors(r.errors);
        setRepair(r.repairMessage);
      } else {
        setErrors([]);
        setRepair(null);
        setText("");
        await onSubmitted();
      }
    } finally {
      setSending(false);
    }
  }

  return (
    <section className="panel border-[color-mix(in_srgb,var(--color-gold-500)_45%,transparent)] p-4" data-testid="ask-chatgpt" data-kind={p.kind}>
      <p className="eyebrow mb-1">
        {stepLabel} · Ask ChatGPT (free)
      </p>
      <h2 className="text-[19px] font-semibold">{p.title}</h2>
      <p className="mt-1 text-[14px] leading-snug text-[var(--color-text-muted)]">
        {p.kind === "WRITE"
          ? "The Director, Hook, Screenwriter and Cinematographer bots are briefed. Send their message to ChatGPT, then paste its answer back."
          : p.kind === "REVIEW"
            ? "The automatic crew has checked the storyboard. Send the review message (with the storyboard image) to ChatGPT — Meaning-Match, Cohesion, Retention, Quality, fact check and the Director answer in one go."
            : p.kind === "FINAL"
              ? "Quality and a first-time viewer read on the finished frames."
              : (p.reason === "VALIDATION" ? "The engine couldn't read part of the film — " : "") + "one quick fix round."}
      </p>

      <ol className="mt-4 flex flex-col gap-3">
        <li>
          <div className="grid grid-cols-2 gap-2">
            <button className="btn btn-primary !min-h-[52px]" onClick={share} data-testid="share-pack">
              Send to ChatGPT
            </button>
            <button
              className="btn btn-ghost !min-h-[52px]"
              onClick={async () => setCopied((await copyText(p.prompt)) ? "ok" : "manual")}
              data-testid="copy-pack"
            >
              {copied === "ok" ? "Copied ✓" : "Copy message"}
            </button>
          </div>
          {p.imageUrl && (
            <a href={p.imageUrl} target="_blank" rel="noopener noreferrer" download="storyboard" className="btn btn-ghost mt-2 w-full" data-testid="storyboard-image">
              {isSketch ? "Open the storyboard sketch" : "Save the storyboard image (attach it in ChatGPT)"}
            </a>
          )}
          <a href="https://chatgpt.com/" target="_blank" rel="noopener noreferrer" className="mt-2 block text-center text-[14px] text-[var(--color-gold-400)]">
            Open ChatGPT ↗
          </a>
          <p className="mt-1 text-center text-[12px] text-[var(--color-text-faint)]">{Math.round(p.chars / 1000)}k characters — paste it as one message{p.imageUrl ? " with the image attached" : ""}.</p>
          {copied === "manual" && <textarea readOnly value={p.prompt} rows={5} className="mt-2 w-full rounded-xl border border-[var(--color-border)] bg-black/40 p-2 text-[12px]" onFocus={(e) => e.currentTarget.select()} />}
        </li>
        <li>
          <label htmlFor="answer" className="text-[15px] font-semibold">
            Paste ChatGPT's answer
          </label>
          <textarea id="answer" value={text} onChange={(e) => setText(e.target.value)} rows={5} placeholder="Paste the whole answer — the code block is enough." className="mt-2 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 py-3 text-[15px] outline-none focus:border-[var(--color-gold-500)]" data-testid="answer" />
          <button className="btn btn-primary mt-2 w-full !min-h-[52px]" disabled={!text.trim() || sending || !!busy} onClick={submit} data-testid="submit-answer">
            {sending ? "Reading the answer…" : "Continue"}
          </button>
          {demo && (
            <button
              className="btn btn-ghost mt-2 w-full !text-[13px]"
              onClick={async () => setText((await demoAnswerAction(view.id)) ?? "")}
              data-testid="demo-answer"
            >
              Fill with the demo answer (dev only)
            </button>
          )}
          {p.optional && (
            <button className="btn btn-ghost mt-2 w-full" onClick={onSkip}>
              Skip
            </button>
          )}
        </li>
      </ol>

      {errors.length > 0 && (
        <div className="mt-3 rounded-xl bg-[color-mix(in_srgb,var(--color-rose-500)_12%,transparent)] p-3" data-testid="answer-errors">
          <p className="text-[14px] font-semibold text-[var(--color-rose-400)]">ChatGPT's answer didn't fit — nothing was changed.</p>
          <ul className="mt-1 list-disc pl-5 text-[13px] leading-snug text-[var(--color-text-muted)]">
            {errors.slice(0, 5).map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
          {repair && (
            <button className="btn btn-ghost mt-2 w-full" onClick={async () => setCopied((await copyText(repair)) ? "fix" : "manual")}>
              {copied === "fix" ? "Copied — paste it to ChatGPT ✓" : "Copy the fix-up message for ChatGPT"}
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function Storyboard({ view, busy, act }: { view: StudioFilmView; busy: string | null; act: (label: string, fn: () => Promise<{ ok: boolean; message?: string }>) => Promise<void> }) {
  const [redo, setRedo] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [edit, setEdit] = useState<string | null>(null);
  const [line, setLine] = useState("");
  const [facts, setFacts] = useState<Set<string>>(new Set(view.facts.filter((f) => f.confirmed).map((f) => f.key)));
  const unconfirmed = view.facts.filter((f) => !f.confirmed);
  return (
    <section data-testid="storyboard">
      <div className="mb-2 flex items-end justify-between gap-2">
        <h2 className="text-[17px] font-semibold">Storyboard</h2>
        {view.storyboardIsSketch && <span className="text-[12px] text-[var(--color-text-faint)]">sketch — the real stills come from the engine</span>}
      </div>
      {view.verification && (
        <p className={`mb-3 rounded-xl px-3 py-2 text-[13.5px] leading-snug ${view.verification.ok ? "bg-[color-mix(in_srgb,var(--color-emerald-500)_12%,transparent)]" : "bg-[color-mix(in_srgb,var(--color-rose-500)_14%,transparent)]"}`}>
          <span className="font-semibold">Verification:</span> {view.verification.summary}
        </p>
      )}
      <ul className="grid grid-cols-2 gap-2.5">
        {view.storyboard.map((s, i) => (
          <li key={s.shotId} className="panel overflow-hidden" data-testid="shot" data-verdict={s.verdict ?? ""}>
            <div className="relative aspect-[9/16] w-full bg-black">
              {s.stillUrl ? <img src={s.stillUrl} alt={`Shot ${i + 1}`} className="h-full w-full object-cover" /> : <div className="flex h-full items-center justify-center text-[12px] text-[var(--color-text-faint)]">No still yet</div>}
              <span className="absolute left-1.5 top-1.5 rounded-md bg-black/70 px-1.5 py-0.5 text-[11px] text-white/80">{i + 1}</span>
              {s.verdict && (
                <span className="absolute right-1.5 top-1.5">
                  <Pill tone={VERDICT_TONE[s.verdict]!}>{s.verdict === "MATCH" ? "✓ shows it" : s.verdict === "WEAK" ? "weak" : "doesn't show it"}</Pill>
                </span>
              )}
            </div>
            <div className="p-2.5">
              <p className="text-[13.5px] leading-snug">{s.line ?? <span className="text-[var(--color-text-faint)]">(no narration)</span>}</p>
              {s.verdict && s.verdict !== "MATCH" && s.verdictNote && (
                <p className="mt-1.5 text-[12px] leading-snug text-[var(--color-rose-400)]">
                  {s.verdictNote}
                  {s.fix && <span className="block text-[var(--color-text-muted)]">Fix: {s.fix}</span>}
                </p>
              )}
              {s.notes.slice(0, 2).map((n, k) => (
                <p key={k} className="mt-1 text-[11.5px] leading-snug text-[var(--color-gold-400)]">
                  {n}
                </p>
              ))}
              {(view.can.redo || view.can.edit) && (
                <div className="mt-2 flex gap-1.5">
                  {view.can.redo && (
                    <button className="btn btn-ghost !min-h-[36px] flex-1 !px-2 !text-[12.5px]" onClick={() => { setRedo(s.shotId); setNote(""); setEdit(null); }} data-testid="redo">
                      Redo
                    </button>
                  )}
                  {view.can.edit && s.line && (
                    <button className="btn btn-ghost !min-h-[36px] flex-1 !px-2 !text-[12.5px]" onClick={() => { setEdit(s.shotId); setLine(s.line ?? ""); setRedo(null); }}>
                      Edit line
                    </button>
                  )}
                </div>
              )}
              {redo === s.shotId && (
                <div className="mt-2">
                  <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="What should change? (optional)" className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-2 text-[13px]" />
                  <button className="btn btn-primary mt-1 w-full !min-h-[40px] !text-[13px]" disabled={!!busy} onClick={() => act("redo", () => redoShotAction(view.id, s.shotId, note)).then(() => setRedo(null))}>
                    Redo this shot
                  </button>
                </div>
              )}
              {edit === s.shotId && (
                <div className="mt-2">
                  <textarea value={line} onChange={(e) => setLine(e.target.value)} rows={2} className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-2 text-[13px]" />
                  <button className="btn btn-primary mt-1 w-full !min-h-[40px] !text-[13px]" disabled={!!busy || !line.trim()} onClick={() => act("edit", () => editLineAction(view.id, s.shotId, line)).then(() => setEdit(null))}>
                    Save line
                  </button>
                </div>
              )}
            </div>
          </li>
        ))}
      </ul>

      {view.can.approve && (
        <div className="panel mt-3 p-4" data-testid="approve-panel">
          {view.facts.length > 0 && (
            <fieldset className="mb-3">
              <legend className="text-[15px] font-semibold">Facts you stand behind</legend>
              <p className="mt-0.5 text-[12.5px] text-[var(--color-text-faint)]">Every factual line needs your OK before it can render. Numbers and math were checked by code.</p>
              <ul className="mt-2 flex flex-col gap-1.5">
                {view.facts.map((f) => (
                  <li key={f.key}>
                    <label className="flex min-h-[44px] items-start gap-2.5 rounded-lg bg-[var(--color-surface-raised)] p-2.5">
                      <input type="checkbox" className="mt-0.5 h-5 w-5 shrink-0" checked={facts.has(f.key)} disabled={f.confirmed} onChange={(e) => setFacts((prev) => { const n = new Set(prev); if (e.target.checked) n.add(f.key); else n.delete(f.key); return n; })} data-testid="fact" />
                      <span className="text-[14px] leading-snug">
                        “{f.text}”{f.source && <span className="block text-[12px] text-[var(--color-text-faint)]">{f.source}</span>}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </fieldset>
          )}
          <button
            className="btn btn-primary w-full !min-h-[56px] !text-[17px]"
            disabled={!!busy || unconfirmed.some((f) => !facts.has(f.key))}
            onClick={() =>
              act("approve", async () => {
                const keys = unconfirmed.filter((f) => facts.has(f.key)).map((f) => f.key);
                if (keys.length) {
                  const c = await confirmFactsAction(view.id, keys);
                  if (!c.ok) return c;
                }
                return approveAction(view.id);
              })
            }
            data-testid="approve"
          >
            {busy === "approve" ? "Starting the render…" : "Approve & render"}
          </button>
        </div>
      )}
    </section>
  );
}

function CrewRoom({ view }: { view: StudioFilmView }) {
  return (
    <section className="panel p-4" data-testid="crew-room">
      <div className="mb-3 flex items-end justify-between">
        <h2 className="text-[17px] font-semibold">Crew room</h2>
        <span className="text-[12px] text-[var(--color-text-faint)]">$0 · automatic bots run by themselves</span>
      </div>
      <ul className="flex flex-col gap-2.5">
        {view.crew.entries.map((e) => (
          <li key={e.member.id} className="flex gap-3" data-testid="crew-member" data-state={e.state}>
            <span className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${STATE_DOT[e.state]}`} aria-hidden />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-[15px] font-semibold">{e.member.name}</span>
                <span className="text-[11.5px] uppercase tracking-wide text-[var(--color-text-faint)]">{MODE_LABEL[e.member.mode]}</span>
                {e.state === "working" && <span className="text-[12px] text-[var(--color-violet-400)]">working…</span>}
                {e.state === "waiting" && <span className="text-[12px] text-[var(--color-gold-400)]">waiting for ChatGPT</span>}
              </div>
              <p className="text-[13.5px] leading-snug text-[var(--color-text-muted)]">{e.summary ?? e.member.goal}</p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
