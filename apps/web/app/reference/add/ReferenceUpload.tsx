"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { uploadReferenceVideo } from "../../../lib/upload-client";
import { measureReferenceVideos, prepareReferenceUpload } from "../actions";
import { MeasureProgress } from "../MeasureProgress";

export interface CreatorOption {
  id: string;
  name: string;
}

type Status = "ready" | "waiting" | "uploading" | "processing" | "done" | "error";
interface Clip {
  file: File;
  sig: string;
  link: string;
  status: Status;
  pct: number;
  error?: string;
}

const NEW = "__new__";
/** Uploads at once — enough to keep a phone's connection busy without starving each file. */
const PARALLEL = 2;

function sizeLabel(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * Add reference videos, phone-first: pick a creator (or type a new name), pick many videos at
 * once (iOS Photos / Files multi-select), optionally paste each one's link, upload. Two at a
 * time with per-file progress; a failed file doesn't stop the rest and "Retry failed" re-sends
 * only those. When the batch is in, measuring starts automatically and its progress shows here.
 */
export function ReferenceUpload({ creators, mode, initialCreatorId }: { creators: CreatorOption[]; mode: "blob" | "local"; initialCreatorId?: string }) {
  const [creatorChoice, setCreatorChoice] = useState<string>(initialCreatorId ?? (creators[0]?.id ?? NEW));
  const [newName, setNewName] = useState("");
  const [clips, setClips] = useState<Clip[]>([]);
  const [running, setRunning] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [creatorDone, setCreatorDone] = useState<{ id: string; name: string } | null>(null);
  const [jobRunId, setJobRunId] = useState<string | null>(null);
  const [measureNote, setMeasureNote] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  function pick(files: FileList | null) {
    if (!files?.length) return;
    const known = new Set(clips.map((c) => c.sig));
    const added = Array.from(files)
      .map((file) => ({ file, sig: `${file.name}|${file.size}|${file.lastModified}`, link: "", status: "ready" as Status, pct: 0 }))
      .filter((c) => !known.has(c.sig));
    setClips((prev) => [...prev, ...added]);
    if (inputRef.current) inputRef.current.value = "";
  }

  const patch = (sig: string, next: Partial<Clip>) => setClips((prev) => prev.map((c) => (c.sig === sig ? { ...c, ...next } : c)));

  async function run(onlyFailed = false) {
    setProblem(null);
    const isNew = creatorChoice === NEW;
    if (isNew && !newName.trim()) {
      setProblem("Type the creator's name first.");
      return;
    }
    setRunning(true);
    let prep: { id: string; name: string };
    if (creatorDone) prep = creatorDone;
    else {
      const r = await prepareReferenceUpload(isNew ? { name: newName } : { referenceCreatorId: creatorChoice });
      if ("error" in r) {
        setProblem(r.error);
        setRunning(false);
        return;
      }
      prep = { id: r.referenceCreatorId, name: r.name };
    }
    setCreatorDone(prep);
    const todo = clips.filter((c) => (onlyFailed ? c.status === "error" : c.status === "ready" || c.status === "error"));
    for (const c of todo) patch(c.sig, { status: "waiting", error: undefined, pct: 0 });
    const queue = [...todo];
    const worker = async () => {
      for (let c = queue.shift(); c; c = queue.shift()) {
        const clip = c;
        try {
          patch(clip.sig, { status: "uploading" });
          await uploadReferenceVideo(prep.id, clip.file, clip.link, mode, (pct, phase) => patch(clip.sig, { pct, status: phase }));
          patch(clip.sig, { status: "done", pct: 100 });
        } catch (err) {
          patch(clip.sig, { status: "error", error: err instanceof Error ? err.message : "Upload failed" });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL, todo.length) }, worker));
    const started = await measureReferenceVideos();
    if ("error" in started) setMeasureNote(started.error);
    else {
      setJobRunId(started.jobRunId);
      setMeasureNote(started.jobRunId ? null : started.message);
    }
    setRunning(false);
  }

  const ready = clips.filter((c) => c.status === "ready" || c.status === "error").length;
  const failed = clips.filter((c) => c.status === "error").length;
  const done = clips.filter((c) => c.status === "done").length;
  const creatorLocked = !!creatorDone;

  return (
    <div className="flex flex-col gap-4 pb-28">
      <section className="panel flex flex-col gap-3 p-4">
        {creatorLocked ? (
          <p className="text-[15px]">
            <span className="text-[var(--color-text-faint)]">Videos for </span>
            <span className="font-semibold">{creatorDone.name}</span>
          </p>
        ) : (
        <label className="block">
          <span className="field-label">Whose videos are these?</span>
          <select className="field-input" value={creatorChoice} disabled={running || creatorLocked} onChange={(e) => setCreatorChoice(e.target.value)} data-testid="ref-creator">
            {creators.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
            <option value={NEW}>＋ Someone new…</option>
          </select>
        </label>
        )}
        {creatorChoice === NEW && !creatorLocked && (
          <label className="block">
            <span className="field-label">Their name</span>
            <input className="field-input" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="e.g. Alex Hormozi" autoComplete="off" disabled={running} data-testid="ref-new-name" />
          </label>
        )}
      </section>

      <label className={`flex min-h-[120px] cursor-pointer flex-col items-center justify-center gap-2 rounded-3xl border-2 border-dashed px-4 py-6 text-center ${running ? "pointer-events-none opacity-50" : "border-[var(--color-gold-500)]/60 bg-[var(--color-gold-500)]/[0.08] active:bg-[var(--color-gold-500)]/15"}`}>
        <input ref={inputRef} type="file" accept="video/*" multiple className="sr-only" disabled={running} onChange={(e) => pick(e.target.files)} data-testid="ref-input" />
        <span className="text-[17px] font-semibold">{clips.length ? "Add more videos" : "Choose videos"}</span>
        <span className="text-[13px] text-[var(--color-text-faint)]">Select as many as you like in Photos or Files. They stay private — only measured, never posted or used in your videos.</span>
      </label>

      {problem && <p className="px-1 text-[14px] text-[var(--color-rose-400)]">{problem}</p>}

      {clips.length > 0 && (
        <ul className="flex flex-col gap-2.5" data-testid="ref-clips">
          {clips.map((c) => (
            <li key={c.sig} className="panel flex flex-col gap-2 p-3.5" data-testid="ref-clip">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-[14.5px] font-medium">{c.file.name}</p>
                  <p className="text-[12px] text-[var(--color-text-faint)]">{sizeLabel(c.file.size)}</p>
                </div>
                <span className="shrink-0 tabular-nums text-[13px] text-[var(--color-text-muted)]" data-testid="ref-status">
                  {c.status === "ready" && (
                    <button type="button" className="link-quiet text-[13px]" onClick={() => setClips((p) => p.filter((x) => x.sig !== c.sig))} disabled={running}>
                      Remove
                    </button>
                  )}
                  {c.status === "waiting" && "Waiting…"}
                  {c.status === "uploading" && `${c.pct}%`}
                  {c.status === "processing" && "Saving…"}
                  {c.status === "done" && <span className="text-[var(--color-emerald-400)]">✓ Uploaded</span>}
                  {c.status === "error" && <span className="text-[var(--color-rose-400)]">Failed</span>}
                </span>
              </div>
              {(c.status === "ready" || c.status === "error") && (
                <input
                  className="field-input !min-h-[40px] !py-2 !text-[14px]"
                  type="url"
                  inputMode="url"
                  placeholder="Link to the post (optional)"
                  value={c.link}
                  onChange={(e) => patch(c.sig, { link: e.target.value })}
                  disabled={running}
                  aria-label={`Link for ${c.file.name}`}
                />
              )}
              {c.status === "error" && c.error && <p className="text-[12.5px] text-[var(--color-rose-400)]">{c.error}</p>}
              {(c.status === "uploading" || c.status === "processing" || c.status === "done") && (
                <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
                  <div className="h-full rounded-full bg-[var(--color-gold-400)] transition-[width]" style={{ width: `${c.pct}%` }} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {(jobRunId || measureNote) && creatorDone && (
        <section className="panel flex flex-col gap-2 p-4" data-testid="ref-finished">
          <p className="text-[17px] font-semibold">
            {done} video{done === 1 ? "" : "s"} added for {creatorDone.name}
          </p>
          {failed > 0 && <p className="text-[13.5px] text-[var(--color-rose-400)]">{failed} failed — tap Retry failed.</p>}
          {jobRunId ? <MeasureProgress jobRunId={jobRunId} /> : <p className="text-[14px] text-[var(--color-text-muted)]">{measureNote}</p>}
          <Link href={`/reference/${creatorDone.id}`} className="btn btn-ghost mt-1 self-start">
            See {creatorDone.name}&apos;s style
          </Link>
        </section>
      )}

      {clips.length > 0 && (
        <div
          className="fixed inset-x-0 z-40 border-t border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-ink)_93%,transparent)] backdrop-blur-xl"
          style={{ bottom: "var(--tabbar-h)", paddingLeft: "var(--safe-left)", paddingRight: "var(--safe-right)" }}
        >
          <div className="mx-auto flex max-w-xl items-center gap-3 px-4 py-3">
            <p className="min-w-0 flex-1 truncate text-[13.5px] text-[var(--color-text-muted)]">
              {running ? "Keep this screen open…" : failed ? `${failed} failed` : ready ? `${ready} ready to upload` : "All uploaded"}
            </p>
            {failed > 0 && !running ? (
              <button type="button" className="btn btn-primary shrink-0" onClick={() => void run(true)}>
                Retry failed
              </button>
            ) : !running && ready === 0 && creatorDone ? (
              <Link href={`/reference/${creatorDone.id}`} className="btn btn-primary shrink-0">
                See the style
              </Link>
            ) : (
              <button type="button" className="btn btn-primary shrink-0" disabled={running || ready === 0} onClick={() => void run(false)} data-testid="ref-upload">
                {running ? "Uploading…" : `Upload ${ready} video${ready === 1 ? "" : "s"}`}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
