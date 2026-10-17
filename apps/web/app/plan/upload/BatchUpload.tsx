"use client";

import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import { formatYmdShort, matchClipsToPlan, type MatchConfidence } from "@chris/domain/plan-import";
import { ymdInTz } from "@chris/domain/planning";
import { uploadRawTake } from "../../../lib/upload-client";
import { createVideoForClip, makeStarterEdit, preparePlannedUpload } from "../actions";

export interface UploadTarget {
  id: string;
  title: string;
  ymd: string;
}

type Choice = string | "new" | "skip";
type Status = "ready" | "waiting" | "uploading" | "processing" | "done" | "error" | "skipped" | "already";
interface Clip {
  file: File;
  sig: string;
  choice: Choice;
  confidence: MatchConfidence;
  reason: string;
  status: Status;
  pct: number;
  error?: string;
  /** Item the clip actually went into (planned id or the new video's id). */
  itemId?: string;
}

const DONE_KEY = "plan-batch-done-v1";
const sigOf = (f: File) => `${f.name}|${f.size}|${f.lastModified}`;

function loadDone(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(DONE_KEY) ?? "{}") as Record<string, string>;
  } catch {
    return {};
  }
}
function saveDone(sig: string, itemId: string) {
  try {
    const d = loadDone();
    d[sig] = itemId;
    localStorage.setItem(DONE_KEY, JSON.stringify(d));
  } catch {
    // storage blocked — "already uploaded" detection just won't survive a refresh
  }
}

const CONF_LABEL: Record<MatchConfidence, string> = { high: "Sure", medium: "Likely", low: "Guess", none: "No match" };
const CONF_CLASS: Record<MatchConfidence, string> = {
  high: "bg-[var(--color-emerald-500)]/15 text-[var(--color-emerald-400)]",
  medium: "bg-[var(--color-gold-500)]/15 text-[var(--color-gold-400)]",
  low: "bg-white/[0.08] text-[var(--color-text-muted)]",
  none: "bg-white/[0.08] text-[var(--color-text-faint)]",
};

/**
 * Batch upload with auto-matching: pick many clips (iOS Photos multi-select) → each is matched
 * to a planned video (filename ↔ title, capture date ↔ planned day, order within a day —
 * matchClipsToPlan) → Chris fixes any match with one picker (or "New video" / "Skip") → all
 * upload one after another, each into its video (walked to FILMED first). Resilient: a failed
 * clip doesn't stop the rest, "Retry failed" re-sends only those, and clips already uploaded
 * from this phone are recognized if he picks them again after a refresh.
 */
export function BatchUpload({ targets, tz, mode }: { targets: UploadTarget[]; tz: string; mode: "blob" | "local" }) {
  const [clips, setClips] = useState<Clip[]>([]);
  const [running, setRunning] = useState(false);
  const [finished, setFinished] = useState<{ id: string; title: string; takes: number }[] | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const titleOf = useMemo(() => new Map(targets.map((t) => [t.id, t.title])), [targets]);
  const byDay = useMemo(() => {
    const m = new Map<string, UploadTarget[]>();
    for (const t of [...targets].sort((a, b) => a.ymd.localeCompare(b.ymd))) m.set(t.ymd, [...(m.get(t.ymd) ?? []), t]);
    return [...m.entries()];
  }, [targets]);

  function pick(files: FileList | null) {
    if (!files?.length) return;
    const list = Array.from(files);
    const done = loadDone();
    const now = Date.now();
    const matches = matchClipsToPlan(
      list.map((f) => ({ name: f.name, lastModified: f.lastModified, size: f.size })),
      targets,
      { tz, now },
    );
    setFinished(null);
    setClips(
      list.map((file, i) => {
        const m = matches[i]!;
        const sig = sigOf(file);
        const already = done[sig];
        return {
          file,
          sig,
          choice: already ? "skip" : (m.contentItemId ?? "new"),
          confidence: m.confidence,
          reason: already ? "Already uploaded from this phone" : m.reason,
          status: already ? "already" : "ready",
          pct: 0,
          itemId: already,
        };
      }),
    );
    if (inputRef.current) inputRef.current.value = "";
  }

  function choose(i: number, choice: Choice) {
    setClips((prev) => prev.map((c, j) => (j === i ? { ...c, choice, status: c.status === "already" && choice !== "skip" ? "ready" : c.status } : c)));
  }

  async function run(onlyFailed = false) {
    setRunning(true);
    const prepared = new Set<string>();
    const newIds = new Map<number, string>();
    const patch = (i: number, next: Partial<Clip>) => setClips((prev) => prev.map((c, j) => (j === i ? { ...c, ...next } : c)));
    // Snapshot of the current clips (state updates below are async).
    const snapshot = clips;
    const queue = snapshot
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => (onlyFailed ? c.status === "error" : c.status === "ready" || c.status === "error"));
    for (const { c, i } of queue) if (c.choice === "skip") patch(i, { status: "skipped" });
    const todo = queue.filter(({ c }) => c.choice !== "skip");
    for (const { i } of todo) patch(i, { status: "waiting", error: undefined });
    const succeeded = new Map<string, number>(snapshot.filter((c) => c.status === "done" && c.itemId).map((c) => [c.itemId!, 0]));
    for (const c of snapshot) if (c.status === "done" && c.itemId) succeeded.set(c.itemId, (succeeded.get(c.itemId) ?? 0) + 1);

    for (const { c, i } of todo) {
      try {
        patch(i, { status: "uploading", pct: 0 });
        let itemId: string;
        if (c.choice === "new") {
          const existing = newIds.get(i) ?? c.itemId;
          if (existing) itemId = existing;
          else {
            const title = c.file.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim() || "New video";
            const created = await createVideoForClip(title);
            if ("error" in created) throw new Error(created.error);
            itemId = created.id;
            newIds.set(i, itemId);
          }
        } else {
          itemId = c.choice;
          if (!prepared.has(itemId)) {
            const prep = await preparePlannedUpload(itemId);
            if ("error" in prep) throw new Error(prep.error);
            prepared.add(itemId);
          }
        }
        patch(i, { itemId });
        await uploadRawTake(itemId, c.file, mode, (pct, phase) => patch(i, { pct, status: phase }));
        patch(i, { status: "done", pct: 100 });
        saveDone(c.sig, itemId);
        succeeded.set(itemId, (succeeded.get(itemId) ?? 0) + 1);
      } catch (err) {
        patch(i, { status: "error", error: err instanceof Error ? err.message : "Upload failed" });
      }
    }
    // Mirror the single upload: every video that got footage gets its no-AI starter edit, so
    // "Edit" opens the editor straight away.
    const summary: { id: string; title: string; takes: number }[] = [];
    for (const [id, takes] of succeeded) {
      await makeStarterEdit(id); // best effort
      summary.push({ id, title: titleOf.get(id) ?? "New video", takes });
    }
    setFinished(summary);
    setRunning(false);
  }

  const toUpload = clips.filter((c) => c.choice !== "skip" && (c.status === "ready" || c.status === "error")).length;
  const failed = clips.filter((c) => c.status === "error").length;
  const videos = new Set(clips.filter((c) => c.choice !== "skip").map((c) => c.choice)).size;
  const newCount = clips.filter((c) => c.choice === "new").length;

  return (
    <div className="flex flex-col gap-4 pb-28">
      <label className={`flex min-h-[130px] cursor-pointer flex-col items-center justify-center gap-2 rounded-3xl border-2 border-dashed px-4 py-6 text-center ${running ? "pointer-events-none opacity-50" : "border-[var(--color-gold-500)]/60 bg-[var(--color-gold-500)]/[0.08] active:bg-[var(--color-gold-500)]/15"}`}>
        <input ref={inputRef} type="file" accept="video/*" multiple className="sr-only" disabled={running} onChange={(e) => pick(e.target.files)} data-testid="batch-input" />
        <span className="text-[17px] font-semibold">{clips.length ? "Choose different clips" : "Choose clips"}</span>
        <span className="text-[13px] text-[var(--color-text-faint)]">Select all of them at once in Photos. Each clip is matched to its planned video — you can change any match.</span>
      </label>

      {clips.length > 0 && (
        <p className="px-1 text-[14px] text-[var(--color-text-muted)]" data-testid="batch-summary">
          {clips.length} clip{clips.length === 1 ? "" : "s"} → {videos} video{videos === 1 ? "" : "s"}
          {newCount ? ` (${newCount} new)` : ""}
          {clips.some((c) => c.choice === "skip") ? ` · ${clips.filter((c) => c.choice === "skip").length} skipped` : ""}
        </p>
      )}

      <ul className="flex flex-col gap-2.5" data-testid="batch-clips">
        {clips.map((c, i) => (
          <li key={c.sig + i} className="panel flex flex-col gap-2 p-3.5" data-testid="batch-clip">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate text-[14.5px] font-medium">{c.file.name}</p>
                <p className="text-[12px] text-[var(--color-text-faint)]">
                  {(c.file.size / 1024 / 1024).toFixed(1)} MB
                  {c.file.lastModified && Math.abs(Date.now() - c.file.lastModified) > 10 * 60_000 ? ` · ${formatYmdShort(ymdInTz(new Date(c.file.lastModified), tz))}` : ""}
                </p>
              </div>
              <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11.5px] font-semibold ${CONF_CLASS[c.confidence]}`} title={c.reason}>
                {c.status === "already" ? "Uploaded" : CONF_LABEL[c.confidence]}
              </span>
            </div>
            <select
              className="field-input"
              value={c.choice}
              disabled={running || c.status === "done"}
              onChange={(e) => choose(i, e.target.value)}
              aria-label={`Video for ${c.file.name}`}
              data-testid="batch-choice"
            >
              <option value="new">＋ New video (not in my plan)</option>
              <option value="skip">Skip this clip</option>
              {/* Grouped by day — at 4 videos a day the list is long; the wheel picker on iOS shows the day headers. */}
              {byDay.map(([ymd, ts]) => (
                <optgroup key={ymd} label={formatYmdShort(ymd)}>
                  {ts.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.title}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            <div className="flex items-center justify-between gap-3 text-[12.5px]">
              <span className="min-w-0 truncate text-[var(--color-text-faint)]">{c.status === "error" ? <span className="text-[var(--color-rose-400)]">{c.error}</span> : c.reason}</span>
              <span className="shrink-0 tabular-nums text-[var(--color-text-muted)]" data-testid="batch-status">
                {c.status === "waiting" && "Waiting…"}
                {c.status === "uploading" && `${c.pct}%`}
                {c.status === "processing" && "Analyzing…"}
                {c.status === "done" && "✓ Uploaded"}
                {c.status === "skipped" && "Skipped"}
                {c.status === "error" && "Failed"}
              </span>
            </div>
            {(c.status === "uploading" || c.status === "processing" || c.status === "done") && (
              <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
                <div className="h-full rounded-full bg-[var(--color-gold-400)] transition-[width]" style={{ width: `${c.pct}%` }} />
              </div>
            )}
          </li>
        ))}
      </ul>

      {finished && (
        <section className="panel p-4" data-testid="batch-finished">
          <p className="text-[17px] font-semibold">{finished.length ? `Footage in for ${finished.length} video${finished.length === 1 ? "" : "s"}` : "Nothing uploaded"}</p>
          {failed > 0 && <p className="mt-1 text-[13.5px] text-[var(--color-rose-400)]">{failed} clip{failed === 1 ? "" : "s"} failed — tap Retry failed.</p>}
          <ul className="mt-3 divide-y divide-[var(--color-border)]">
            {finished.map((v) => (
              <li key={v.id} className="flex items-center justify-between gap-3 py-2.5">
                <span className="min-w-0 truncate text-[14.5px]">
                  {v.title} <span className="text-[12px] text-[var(--color-text-faint)]">· {v.takes} take{v.takes === 1 ? "" : "s"}</span>
                </span>
                <Link href={`/content/${v.id}/edit`} className="btn btn-primary !min-h-[36px] !px-3.5 !text-[13.5px] shrink-0">
                  Edit
                </Link>
              </li>
            ))}
          </ul>
          <Link href="/plan" className="link-quiet mt-3 inline-block text-[14px]">
            Back to your plan
          </Link>
        </section>
      )}

      {clips.length > 0 && (
        <div
          className="fixed inset-x-0 z-40 border-t border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-ink)_93%,transparent)] backdrop-blur-xl"
          style={{ bottom: "var(--tabbar-h)", paddingLeft: "var(--safe-left)", paddingRight: "var(--safe-right)" }}
        >
          <div className="mx-auto flex max-w-xl items-center gap-3 px-4 py-3">
            <p className="min-w-0 flex-1 truncate text-[13.5px] text-[var(--color-text-muted)]">{running ? "Keep this screen open…" : failed ? `${failed} failed` : toUpload ? "Matches look right?" : "All done"}</p>
            {failed > 0 && !running ? (
              <button type="button" className="btn btn-primary shrink-0" onClick={() => void run(true)}>
                Retry failed
              </button>
            ) : (
              <button type="button" className="btn btn-primary shrink-0" disabled={running || toUpload === 0} onClick={() => void run(false)} data-testid="batch-upload">
                {running ? "Uploading…" : `Upload ${toUpload} clip${toUpload === 1 ? "" : "s"}`}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
