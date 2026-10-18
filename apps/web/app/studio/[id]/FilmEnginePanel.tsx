"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The engine's part of a studio film page (the crew's StudioFilmClient stays as it is):
 *  - "My voice" films: record the narration on the phone (or upload a voice memo); the engine
 *    syncs the picture to the real words and reports what it didn't hear;
 *  - a render waiting for the Mac's render worker: say so, and offer the cloud — with its cost —
 *    as an explicit choice ($0 by default).
 */

interface Info {
  voiceEngine: string;
  status: string;
  narration: null | { recorded: boolean; aligned: boolean; updatedAt: string; job: null | { status: string; message: string | null; error: string | null }; report: null | { ok: boolean; matchedRatio: number; problems: string[] } };
  cloud: null | { jobRunId: string; waitingForMac: boolean; macOnline: boolean; estimate: null | { summary: string; usd: number; available: boolean; why?: string } };
}

export function FilmEnginePanel({ filmId }: { filmId: string }) {
  const [info, setInfo] = useState<Info | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const rec = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);

  const load = useCallback(async () => {
    const r = await fetch(`/api/films/studio?filmId=${encodeURIComponent(filmId)}`, { cache: "no-store" }).catch(() => null);
    if (r?.ok) setInfo((await r.json()) as Info);
  }, [filmId]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [load]);

  const upload = async (blob: Blob) => {
    setBusy("upload");
    setMsg(null);
    const r = await fetch(`/api/films/studio?filmId=${encodeURIComponent(filmId)}&action=narration`, { method: "POST", headers: { "Content-Type": blob.type || "audio/mp4" }, body: blob }).catch(() => null);
    const j = r ? ((await r.json().catch(() => ({}))) as { ok?: boolean; message?: string }) : {};
    setMsg(r?.ok ? "Got it — syncing the picture to your voice…" : (j.message ?? "Couldn't upload the recording."));
    setBusy(null);
    void load();
  };

  const start = async () => {
    setMsg(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: true } });
      const type = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"].find((t) => MediaRecorder.isTypeSupported(t)) ?? "";
      const mr = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
      chunks.current = [];
      mr.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
      mr.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        void upload(new Blob(chunks.current, { type: mr.mimeType || "audio/mp4" }));
      };
      mr.start();
      rec.current = mr;
      setRecording(true);
    } catch {
      setMsg("The microphone isn't available — upload a voice memo instead.");
    }
  };
  const stop = () => {
    rec.current?.stop();
    setRecording(false);
  };

  const cloud = async () => {
    setBusy("cloud");
    const r = await fetch(`/api/films/studio?filmId=${encodeURIComponent(filmId)}&action=cloud`, { method: "POST" }).catch(() => null);
    const j = r ? ((await r.json().catch(() => ({}))) as { ok?: boolean; message?: string }) : {};
    setMsg(j.ok ? "Rendering in the cloud." : (j.message ?? "Couldn't start the cloud render."));
    setBusy(null);
    void load();
  };

  if (!info) return null;
  const n = info.narration;
  const c = info.cloud;
  return (
    <div className="mt-4 space-y-3" data-testid="film-engine-panel">
      {info.voiceEngine === "CHRIS" && (
        <section className="card p-4">
          <h3 className="font-semibold">Your narration</h3>
          <p className="text-sm text-muted mt-1">Read the whole script in one take — pauses and small slips are fine. The picture is timed to your real words.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {!recording ? (
              <button className="btn btn-primary" disabled={!!busy} onClick={start} data-testid="record-narration">
                {n?.recorded ? "Record again" : "Record narration"}
              </button>
            ) : (
              <button className="btn btn-primary" onClick={stop}>
                Stop and use this take
              </button>
            )}
            <label className="btn">
              Upload a voice memo
              <input type="file" accept="audio/*,video/*" className="hidden" onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} />
            </label>
          </div>
          {n && (
            <p className="text-sm mt-3" data-testid="narration-status">
              {n.aligned && n.report ? `Synced — ${Math.round(n.report.matchedRatio * 100)}% of the script heard.` : n.job?.status === "FAILED" ? (n.job.error ?? "Your take didn't line up with the script.") : n.recorded ? (n.job?.message ?? "Recorded — it syncs when the film renders.") : null}
            </p>
          )}
          {n?.report?.problems?.length ? (
            <ul className="text-xs text-muted mt-2 list-disc pl-4">
              {n.report.problems.map((p, i) => (
                <li key={i}>{p}</li>
              ))}
            </ul>
          ) : null}
        </section>
      )}
      {c?.waitingForMac && (
        <section className="card p-4" data-testid="cloud-offer">
          <h3 className="font-semibold">Waiting for your Mac</h3>
          <p className="text-sm text-muted mt-1">Rendering on your Mac is free. Start its render worker (Terminal: <code>pnpm --filter @chris/worker film-worker</code>) and the film starts within seconds.</p>
          {c.estimate?.available ? (
            <button className="btn mt-3" disabled={!!busy} onClick={cloud} data-testid="render-in-cloud">
              Render in the cloud instead ({c.estimate.summary})
            </button>
          ) : (
            <p className="text-xs text-muted mt-2">{c.estimate?.why ?? "Cloud rendering isn't set up."}</p>
          )}
        </section>
      )}
      {msg && <p className="text-sm">{msg}</p>}
    </div>
  );
}
