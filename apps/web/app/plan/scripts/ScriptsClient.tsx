"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import { formatYmdShort } from "@chris/domain/plan-import";
import {
  BATCH_SIZES,
  DEFAULT_BATCH_SIZE,
  batchVideos,
  buildScriptPrompt,
  estimateSecondsAt,
  matchScriptBlocks,
  parseChatGptScripts,
  type ParsedScriptBlock,
  type ScriptBlockMatch,
  type ScriptMatchConfidence,
  type ScriptStyle,
} from "@chris/domain/script-import";
import { saveChatGptScripts } from "./actions";

export interface ClientTarget {
  id: string;
  code: string;
  title: string;
  ymd: string;
  time: string;
  hook: string | null;
  notes: string | null;
  scriptCount: number;
  latestScript: { excerpt: string; authorType: string } | null;
  needsScript: boolean;
}

/** What Chris decided for one pasted script. */
type Choice =
  | { kind: "video"; id: string; replace: boolean }
  | { kind: "new"; title: string; ymd: string }
  | { kind: "skip" };

type SaveOutcome = { index: number; contentItemId: string | null; title: string; status: string; message: string };

const CONF_LABEL: Record<ScriptMatchConfidence, string> = { exact: "Exact", likely: "Likely", pick: "Pick one" };
const CONF_CLASS: Record<ScriptMatchConfidence, string> = {
  exact: "bg-[var(--color-emerald-500)]/15 text-[var(--color-emerald-400)]",
  likely: "bg-[var(--color-gold-500)]/15 text-[var(--color-gold-400)]",
  pick: "bg-[var(--color-rose-500)]/15 text-[var(--color-rose-400)]",
};

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Older Safari / non-secure context: select a hidden textarea and use the legacy copy.
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.top = "0";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok: boolean;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}

function fmtSeconds(s: number): string {
  return s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : `${s}s`;
}

export function ScriptsClient({
  today,
  targets,
  style,
  pace,
  voiceSamples,
}: {
  today: string;
  targets: ClientTarget[];
  style: ScriptStyle;
  pace: { wpm: number; label: string };
  voiceSamples: string;
}) {
  const router = useRouter();
  const needing = useMemo(
    () => targets.filter((t) => t.needsScript).sort((a, b) => (a.ymd + a.time).localeCompare(b.ymd + b.time)),
    [targets],
  );
  const byId = useMemo(() => new Map(targets.map((t) => [t.id, t])), [targets]);

  // ---------- Step 1: prompt ----------
  const [batchSize, setBatchSize] = useState<number>(DEFAULT_BATCH_SIZE);
  const [batchIdx, setBatchIdx] = useState(0);
  const batches = useMemo(() => batchVideos(needing, batchSize), [needing, batchSize]);
  const batch = batches[Math.min(batchIdx, Math.max(0, batches.length - 1))] ?? [];
  const prompt = useMemo(
    () =>
      batch.length
        ? buildScriptPrompt({
            videos: batch.map((t) => ({ id: t.id, code: t.code, title: t.title, ymd: t.ymd, hook: t.hook, notes: t.notes })),
            batchNumber: Math.min(batchIdx, batches.length - 1) + 1,
            batchCount: batches.length,
            style,
            voiceSamples,
          })
        : "",
    [batch, batchIdx, batches.length, style, voiceSamples],
  );
  const [copied, setCopied] = useState<null | "ok" | "manual">(null);
  const [showPrompt, setShowPrompt] = useState(false);
  const promptBoxRef = useRef<HTMLTextAreaElement>(null);

  async function copyPrompt() {
    const ok = await copyText(prompt);
    setCopied(ok ? "ok" : "manual");
    if (!ok) {
      setShowPrompt(true);
      setTimeout(() => {
        promptBoxRef.current?.focus();
        promptBoxRef.current?.select();
      }, 50);
    }
  }

  // ---------- Step 2: paste ----------
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // ---------- Step 3: preview ----------
  const [blocks, setBlocks] = useState<ParsedScriptBlock[] | null>(null);
  const [matches, setMatches] = useState<ScriptBlockMatch[]>([]);
  const [choices, setChoices] = useState<Choice[]>([]);
  const [ignored, setIgnored] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ outcomes: SaveOutcome[]; saved: number } | null>(null);

  function readScripts(text = answer) {
    setError(null);
    const t = text.trim();
    if (!t) return setError("Paste ChatGPT's answer first.");
    const res = parseChatGptScripts(t, { today });
    if (res.blocks.length === 0) {
      return setError(
        "Couldn't find any scripts in that. Each script should start with a line like \"### VIDEO 1 | 2026-10-21 | Title | K3F9\". Ask ChatGPT to \"use the exact answer format from my message\" and paste again.",
      );
    }
    const m = matchScriptBlocks(
      res.blocks,
      targets.map((x) => ({ id: x.id, title: x.title, ymd: x.ymd, time: x.time, code: x.code, hook: x.hook })),
    );
    setBlocks(res.blocks);
    setMatches(m);
    setIgnored(res.ignored);
    setChoices(m.map((mm): Choice => (mm.targetId ? { kind: "video", id: mm.targetId, replace: false } : { kind: "skip" })));
    setTimeout(() => document.getElementById("step-3")?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  }

  async function readFile(file: File | undefined) {
    if (!file) return;
    try {
      const name = file.name.toLowerCase();
      if (name.endsWith(".docx") || name.endsWith(".pdf")) {
        throw new Error("That's a Word/PDF file — ask ChatGPT for a .txt or .md file, or just copy its answer and paste it here.");
      }
      const text = await file.text();
      setAnswer(text);
      readScripts(text);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't read that file.");
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  function setChoice(i: number, c: Choice) {
    setChoices((prev) => prev.map((x, j) => (j === i ? c : x)));
  }

  // Two scripts pointed at the same video: only the first counts (the second shows a warning).
  const conflicts = useMemo(() => {
    const seen = new Map<string, number>();
    const out = new Set<number>();
    choices.forEach((c, i) => {
      if (c.kind !== "video") return;
      if (seen.has(c.id)) out.add(i);
      else seen.set(c.id, i);
    });
    return out;
  }, [choices]);

  const toSave = useMemo(
    () =>
      choices
        .map((c, i) => ({ c, i }))
        .filter(({ c, i }) => {
          if (conflicts.has(i)) return false;
          if (c.kind === "skip") return false;
          if (c.kind === "new") return !!c.title.trim() && /^\d{4}-\d{2}-\d{2}$/.test(c.ymd);
          const t = byId.get(c.id);
          return !!t && (t.scriptCount === 0 || c.replace);
        }),
    [choices, conflicts, byId],
  );

  async function save() {
    if (!blocks || toSave.length === 0) return;
    setBusy(true);
    setError(null);
    const res = await saveChatGptScripts({
      rawPaste: answer.slice(0, 400_000),
      items: toSave.map(({ c, i }) => ({
        rawBlock: blocks[i]!.raw,
        contentItemId: c.kind === "video" ? c.id : null,
        newVideo: c.kind === "new" ? { title: c.title.trim(), ymd: c.ymd } : null,
        replace: c.kind === "video" ? c.replace : false,
      })),
    });
    setBusy(false);
    if ("error" in res) return setError(res.error);
    setDone({ outcomes: res.outcomes, saved: res.saved });
    window.scrollTo({ top: 0 });
    router.refresh();
  }

  function startOver() {
    setBlocks(null);
    setMatches([]);
    setChoices([]);
    setIgnored([]);
    setAnswer("");
    setDone(null);
    setError(null);
    setCopied(null);
    setBatchIdx(0);
    window.scrollTo({ top: 0 });
  }

  // Day-grouped options for the "which video?" picker.
  const dayGroups = useMemo(() => {
    const m = new Map<string, ClientTarget[]>();
    for (const t of [...targets].sort((a, b) => (a.ymd + a.time).localeCompare(b.ymd + b.time))) m.set(t.ymd, [...(m.get(t.ymd) ?? []), t]);
    return [...m.entries()];
  }, [targets]);

  // ---------- Done ----------
  if (done) {
    const savedOnes = done.outcomes.filter((o) => o.status === "saved" || o.status === "already-saved");
    const firstId = savedOnes.find((o) => o.contentItemId)?.contentItemId ?? null;
    const others = done.outcomes.filter((o) => o.status !== "saved");
    return (
      <div className="panel flex flex-col items-center gap-3 px-5 py-8 text-center" data-testid="scripts-done">
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-[var(--color-emerald-500)]/15 text-[var(--color-emerald-400)]">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="m5 12 5 5L20 7" />
          </svg>
        </div>
        <h2 className="text-[22px] font-semibold">{done.saved ? `${done.saved} script${done.saved === 1 ? "" : "s"} saved` : "Nothing new to save"}</h2>
        <p className="max-w-sm text-[15px] text-[var(--color-text-muted)]">
          They show up in the teleprompter for each video. Anything marked [CHECK] still gets fact-checked before posting.
        </p>
        {others.length > 0 && (
          <ul className="w-full max-w-sm text-left text-[13.5px] text-[var(--color-text-muted)]">
            {others.map((o) => (
              <li key={o.index} className="border-t border-[var(--color-border)] py-1.5">
                <span className="text-[var(--color-text)]">{o.title}</span> — {o.message}
              </li>
            ))}
          </ul>
        )}
        <div className="mt-2 flex w-full max-w-sm flex-col gap-2.5">
          {needing.length > 0 && (
            <button type="button" className="btn btn-primary w-full" onClick={startOver} data-testid="next-batch">
              Get the next {Math.min(batchSize, needing.length)} ({needing.length} still need scripts)
            </button>
          )}
          {firstId && (
            <Link href={`/film/teleprompter?id=${encodeURIComponent(firstId)}`} className={`btn ${needing.length ? "btn-ghost" : "btn-primary"} w-full`} data-testid="open-prompter">
              Open the teleprompter
            </Link>
          )}
          <Link href="/plan" className="btn btn-ghost w-full">
            Back to your plan
          </Link>
        </div>
      </div>
    );
  }

  const nBatches = batches.length;
  const bi = Math.min(batchIdx, Math.max(0, nBatches - 1));
  const range = batch.length ? `${formatYmdShort(batch[0]!.ymd, false)}${batch.length > 1 && batch[batch.length - 1]!.ymd !== batch[0]!.ymd ? ` – ${formatYmdShort(batch[batch.length - 1]!.ymd, false)}` : ""}` : "";

  return (
    <div className={`flex flex-col gap-4 ${blocks ? "pb-28" : ""}`}>
      {/* ---------- Step 1 ---------- */}
      <section className="panel p-4 sm:p-5" data-testid="step-1">
        <p className="eyebrow mb-1">Step 1</p>
        <h2 className="text-[19px] font-semibold">Copy the prompt</h2>
        {needing.length === 0 ? (
          <p className="mt-1.5 text-[15px] text-[var(--color-text-muted)]">
            Every planned video already has a script. You can still paste scripts below — for example new versions — and replace old ones.
          </p>
        ) : (
          <>
            <p className="mt-1 text-[15px] leading-snug text-[var(--color-text-muted)]" data-testid="needing-count">
              {needing.length} planned video{needing.length === 1 ? "" : "s"} need{needing.length === 1 ? "s" : ""} a script. ChatGPT writes about 15 well at a time.
            </p>
            <div className="mt-3 flex items-center justify-between gap-3">
              <span className="text-[14px] text-[var(--color-text-muted)]">Videos per prompt</span>
              <div className="grid grid-cols-4 gap-1 rounded-2xl bg-white/[0.05] p-1">
                {BATCH_SIZES.map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => {
                      setBatchSize(n);
                      setBatchIdx(0);
                      setCopied(null);
                    }}
                    aria-pressed={batchSize === n}
                    className={`min-h-[36px] min-w-[44px] rounded-xl px-2 text-[14px] font-medium ${batchSize === n ? "bg-white/[0.12] text-[var(--color-text)]" : "text-[var(--color-text-muted)]"}`}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>
            <div className="mt-3 flex items-center justify-between gap-2 rounded-2xl bg-white/[0.04] px-3 py-2.5">
              <button
                type="button"
                className="btn btn-ghost !min-h-[36px] !px-3 !text-[13px]"
                disabled={bi === 0}
                onClick={() => {
                  setBatchIdx(bi - 1);
                  setCopied(null);
                }}
                aria-label="Previous batch"
              >
                ‹
              </button>
              <div className="min-w-0 text-center">
                <p className="text-[15px] font-semibold" data-testid="batch-label">
                  Batch {bi + 1} of {nBatches}
                </p>
                <p className="truncate text-[12.5px] text-[var(--color-text-faint)]">
                  {batch.length} video{batch.length === 1 ? "" : "s"} · {range}
                </p>
              </div>
              <button
                type="button"
                className="btn btn-ghost !min-h-[36px] !px-3 !text-[13px]"
                disabled={bi >= nBatches - 1}
                onClick={() => {
                  setBatchIdx(bi + 1);
                  setCopied(null);
                }}
                aria-label="Next batch"
              >
                ›
              </button>
            </div>
            <button type="button" className="btn btn-primary mt-3 w-full !min-h-[52px] !text-[16px]" onClick={() => void copyPrompt()} data-testid="copy-prompt">
              {copied === "ok" ? "Copied ✓ — now paste it in ChatGPT" : `Copy prompt for ${batch.length} video${batch.length === 1 ? "" : "s"}`}
            </button>
            {copied === "manual" && (
              <p className="mt-2 text-[13.5px] text-[var(--color-gold-400)]">Couldn&apos;t copy automatically. The prompt is selected below — tap Copy (or press and hold → Select All → Copy).</p>
            )}
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              <a href="https://chatgpt.com/" target="_blank" rel="noreferrer" className="btn btn-ghost !min-h-[40px] !text-[14px]">
                Open ChatGPT
              </a>
              <button type="button" className="link-quiet text-[14px]" onClick={() => setShowPrompt((v) => !v)}>
                {showPrompt ? "Hide the prompt" : "See the prompt"}
              </button>
            </div>
            <p className="mt-2 text-[13px] leading-snug text-[var(--color-text-faint)]">
              Paste it in the chat where you planned these videos (best), or in a new chat — it works either way.
            </p>
            {showPrompt && (
              <textarea
                ref={promptBoxRef}
                readOnly
                value={prompt}
                rows={12}
                className="field-input mt-2 !text-[13px] !leading-snug"
                data-testid="prompt-text"
                onFocus={(e) => e.currentTarget.select()}
              />
            )}
          </>
        )}
      </section>

      {/* ---------- Step 2 ---------- */}
      <section className="panel p-4 sm:p-5" data-testid="step-2">
        <p className="eyebrow mb-1">Step 2</p>
        <h2 className="text-[19px] font-semibold">Paste ChatGPT&apos;s answer</h2>
        <p className="mt-1 text-[14px] leading-snug text-[var(--color-text-muted)]">
          In ChatGPT, tap <span className="text-[var(--color-text)]">Copy</span> on the box with the scripts, then paste here. If ChatGPT gave you a file (.txt or .md), choose it instead.
        </p>
        <textarea
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          rows={blocks ? 4 : 8}
          placeholder={"### VIDEO 1 | 2026-10-21 | …\nHOOK: …\nSCRIPT:\n…"}
          className="field-input mt-3 !text-[14px]"
          data-testid="answer"
        />
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <button type="button" className="btn btn-primary w-full sm:w-auto" onClick={() => readScripts()} data-testid="read-scripts">
            {blocks ? "Read again" : "Read scripts"}
          </button>
          <button type="button" className="btn btn-ghost w-full sm:w-auto" onClick={() => fileRef.current?.click()}>
            Choose a file
          </button>
          <input ref={fileRef} type="file" accept=".txt,.md,.markdown,text/plain,text/markdown" className="hidden" onChange={(e) => void readFile(e.target.files?.[0])} />
        </div>
        {error && (
          <p className="mt-2.5 text-[14px] text-[var(--color-rose-400)]" role="alert">
            {error}
          </p>
        )}
      </section>

      {/* ---------- Step 3 ---------- */}
      {blocks && (
        <section id="step-3" className="flex scroll-mt-4 flex-col gap-3" data-testid="step-3">
          <div className="panel p-4">
            <p className="eyebrow mb-1">Step 3</p>
            <h2 className="text-[19px] font-semibold" data-testid="found-summary">
              Found {blocks.length} script{blocks.length === 1 ? "" : "s"}
            </h2>
            <p className="mt-1 text-[14px] text-[var(--color-text-muted)]">
              {[
                `${matches.filter((m) => m.confidence === "exact").length} exact`,
                `${matches.filter((m) => m.confidence === "likely").length} likely`,
                matches.some((m) => m.confidence === "pick") ? `${matches.filter((m) => m.confidence === "pick").length} need you to pick` : null,
              ]
                .filter(Boolean)
                .join(" · ")}
              . Check each one, then save.
            </p>
            {ignored.length > 0 && (
              <details className="mt-2 text-[13px] text-[var(--color-text-faint)]">
                <summary className="cursor-pointer">Ignored ChatGPT&apos;s extra text</summary>
                <p className="mt-1 whitespace-pre-wrap">{ignored.join("\n\n").slice(0, 600)}</p>
              </details>
            )}
          </div>

          {blocks.map((b, i) => (
            <ScriptCard
              key={i}
              block={b}
              match={matches[i]!}
              choice={choices[i] ?? { kind: "skip" }}
              conflict={conflicts.has(i)}
              onChoice={(c) => setChoice(i, c)}
              byId={byId}
              dayGroups={dayGroups}
              pace={pace}
              style={style}
              today={today}
            />
          ))}

          <div className="sticky z-30 mt-1 rounded-2xl border border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-ink)_93%,transparent)] p-3 backdrop-blur-xl" style={{ bottom: "calc(var(--tabbar-h) + 10px)" }}>
            <button type="button" className="btn btn-primary w-full !min-h-[50px] !text-[16px]" disabled={busy || toSave.length === 0} onClick={() => void save()} data-testid="save-scripts">
              {busy ? "Saving…" : toSave.length ? `Save ${toSave.length} script${toSave.length === 1 ? "" : "s"}` : "Nothing to save yet"}
            </button>
            <button type="button" className="mt-1.5 w-full text-center text-[13px] text-[var(--color-text-faint)]" onClick={startOver}>
              Start over
            </button>
          </div>
        </section>
      )}
    </div>
  );
}

function ScriptCard({
  block,
  match,
  choice,
  conflict,
  onChoice,
  byId,
  dayGroups,
  pace,
  style,
  today,
}: {
  block: ParsedScriptBlock;
  match: ScriptBlockMatch;
  choice: Choice;
  conflict: boolean;
  onChoice: (c: Choice) => void;
  byId: Map<string, ClientTarget>;
  dayGroups: [string, ClientTarget[]][];
  pace: { wpm: number; label: string };
  style: ScriptStyle;
  today: string;
}) {
  const target = choice.kind === "video" ? byId.get(choice.id) : null;
  const secs = estimateSecondsAt(block.wordCount, pace.wpm);
  const lengthNote = secs > style.maxSeconds + 10 ? "long" : secs < style.minSeconds - 10 ? "short" : null;
  // The picker's confidence is the matcher's only while Chris keeps its pick.
  const conf: ScriptMatchConfidence | null = choice.kind === "video" && choice.id === match.targetId ? match.confidence : choice.kind === "video" ? null : match.targetId ? null : "pick";
  const suggestions = match.suggestions.map((id) => byId.get(id)).filter((t): t is ClientTarget => !!t).slice(0, 4);
  const selectValue = choice.kind === "video" ? choice.id : choice.kind === "new" ? "__new" : "__skip";
  const highlighted = useMemo(() => highlightChecks(block.spokenScript, block.checks), [block]);

  return (
    <article className={`panel p-4 ${choice.kind === "skip" ? "opacity-80" : ""}`} data-testid="script-card">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[12px] font-semibold uppercase tracking-wider text-[var(--color-text-faint)]">
            Script {block.number ?? block.index + 1}
            {block.ymd ? ` · ${formatYmdShort(block.ymd)}` : ""}
          </p>
          <p className="mt-0.5 line-clamp-2 text-[15.5px] font-medium leading-snug">{block.title || block.hook || "Untitled"}</p>
        </div>
        {conf && (
          <span className={`shrink-0 rounded-full px-2.5 py-1 text-[12px] font-semibold ${CONF_CLASS[conf]}`} data-testid="confidence">
            {CONF_LABEL[conf]}
          </span>
        )}
      </div>

      <label className="mt-3 block">
        <span className="field-label">For video</span>
        <select
          className="field-input !text-[15px]"
          value={selectValue}
          data-testid="target-select"
          onChange={(e) => {
            const v = e.target.value;
            if (v === "__skip") onChoice({ kind: "skip" });
            else if (v === "__new") onChoice({ kind: "new", title: block.title || block.hook?.slice(0, 80) || "New video", ymd: block.ymd ?? today });
            else onChoice({ kind: "video", id: v, replace: false });
          }}
        >
          <option value="__skip">Skip this script</option>
          <option value="__new">+ Create as a new planned video</option>
          {suggestions.length > 0 && (
            <optgroup label="Best guesses">
              {suggestions.map((t) => (
                <option key={`s-${t.id}`} value={t.id}>
                  {formatYmdShort(t.ymd)} · {t.title}
                </option>
              ))}
            </optgroup>
          )}
          {dayGroups.map(([ymd, ts]) => (
            <optgroup key={ymd} label={formatYmdShort(ymd)}>
              {ts
                .filter((t) => !suggestions.includes(t))
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.title}
                    {t.scriptCount ? " (has a script)" : ""}
                  </option>
                ))}
            </optgroup>
          ))}
        </select>
      </label>
      {target && (
        <p className="mt-1.5 text-[13px] text-[var(--color-text-muted)]">
          {formatYmdShort(target.ymd)} · {target.title}
          {conf ? ` — ${match.reason}` : ""}
        </p>
      )}
      {choice.kind === "skip" && match.confidence === "pick" && <p className="mt-1.5 text-[13px] text-[var(--color-gold-400)]">{match.reason} — pick the video, make it a new one, or skip it.</p>}
      {conflict && <p className="mt-1.5 text-[13px] text-[var(--color-rose-400)]">Another script above is already going to this video — pick a different one or skip this.</p>}

      {target && target.scriptCount > 0 && (
        <div className="mt-2.5 rounded-2xl bg-white/[0.04] p-3">
          <p className="text-[13.5px]">
            This video already has a script{target.latestScript ? `: “${target.latestScript.excerpt}”` : "."}
          </p>
          <div className="mt-2 grid grid-cols-2 gap-1 rounded-2xl bg-white/[0.05] p-1">
            <button
              type="button"
              aria-pressed={choice.kind === "video" && choice.replace}
              className={`min-h-[40px] rounded-xl px-2 text-[13.5px] font-medium ${choice.kind === "video" && choice.replace ? "bg-white/[0.12]" : "text-[var(--color-text-muted)]"}`}
              onClick={() => onChoice({ kind: "video", id: target.id, replace: true })}
              data-testid="replace"
            >
              Replace (keeps the old version)
            </button>
            <button
              type="button"
              aria-pressed={choice.kind === "video" && !choice.replace}
              className={`min-h-[40px] rounded-xl px-2 text-[13.5px] font-medium ${choice.kind === "video" && !choice.replace ? "bg-white/[0.12]" : "text-[var(--color-text-muted)]"}`}
              onClick={() => onChoice({ kind: "video", id: target.id, replace: false })}
            >
              Skip
            </button>
          </div>
        </div>
      )}

      {choice.kind === "new" && (
        <div className="mt-2.5 flex flex-col gap-2 rounded-2xl bg-white/[0.04] p-3">
          <label className="block">
            <span className="field-label">New video title</span>
            <input className="field-input" value={choice.title} onChange={(e) => onChoice({ ...choice, title: e.target.value })} />
          </label>
          <label className="block">
            <span className="field-label">Post on</span>
            <input type="date" className="field-input" value={choice.ymd} onChange={(e) => onChoice({ ...choice, ymd: e.target.value })} />
          </label>
        </div>
      )}

      <p className="mt-2.5 text-[13px] text-[var(--color-text-muted)]" data-testid="length">
        {block.wordCount} words · ~{fmtSeconds(secs)} {pace.label}
        {lengthNote === "long" && <span className="text-[var(--color-gold-400)]"> · on the long side</span>}
        {lengthNote === "short" && <span className="text-[var(--color-gold-400)]"> · on the short side</span>}
      </p>
      {block.checks.length > 0 && (
        <div className="mt-2 rounded-2xl bg-[var(--color-gold-500)]/10 p-3" data-testid="checks">
          <p className="text-[13px] font-semibold text-[var(--color-gold-400)]">
            {block.checks.length} claim{block.checks.length === 1 ? "" : "s"} to check before posting
          </p>
          <ul className="mt-1 flex flex-col gap-1 text-[13px] leading-snug">
            {block.checks.map((c, k) => (
              <li key={k}>• {c}</li>
            ))}
          </ul>
        </div>
      )}
      <details className="mt-2">
        <summary className="flex min-h-[40px] cursor-pointer items-center text-[14px] text-[var(--color-text-muted)]">Read the script</summary>
        <p className="whitespace-pre-wrap text-[14.5px] leading-relaxed" data-testid="script-text">
          {highlighted}
        </p>
        {block.onScreen.length > 0 && <p className="mt-2 text-[13px] text-[var(--color-text-faint)]">On screen: {block.onScreen.join(" / ")}</p>}
      </details>
      {block.warnings.length > 0 && <p className="mt-1 text-[12px] text-[var(--color-text-faint)]">{block.warnings.join(" · ")}</p>}
    </article>
  );
}

/** Marks the sentences ChatGPT flagged [CHECK] inside the script text. */
function highlightChecks(text: string, checks: string[]) {
  if (!checks.length) return text;
  const parts: Array<string | { mark: string }> = [];
  let rest = text;
  for (const c of checks) {
    const claim = c.replace(/\s*\([^)]*\)$/, "");
    const at = rest.indexOf(claim);
    if (at < 0) continue;
    parts.push(rest.slice(0, at), { mark: claim });
    rest = rest.slice(at + claim.length);
  }
  parts.push(rest);
  return parts.map((p, i) =>
    typeof p === "string" ? (
      p
    ) : (
      <mark key={i} className="rounded bg-[var(--color-gold-500)]/25 px-0.5 text-[var(--color-text)]">
        {p.mark}
      </mark>
    ),
  );
}
