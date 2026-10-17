import { fmtSeconds, videoSummary, type ReferenceVideoMetrics } from "@chris/domain/style-metrics";
import { deleteReferenceVideoFile, moveReferenceVideoAction, setReferenceVideoLink } from "../actions";
import { Button, platformLabel } from "../../components/ui";

export interface VideoRow {
  id: string;
  mediaFilename: string | null;
  mediaStorageKey: string | null;
  mediaDeletedAt: Date | null;
  sourceUrl: string | null;
  platform: string | null;
  analysisStatus: string | null;
  analysisError: string | null;
  parsedMetrics: ReferenceVideoMetrics | null;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <dt className="shrink-0 text-[13px] text-[var(--color-text-faint)]">{label}</dt>
      <dd className="min-w-0 text-right text-[13.5px]">{value}</dd>
    </div>
  );
}

function Details({ m }: { m: ReferenceVideoMetrics }) {
  const rows: Array<[string, string]> = [];
  rows.push(["Length", `${fmtSeconds(m.video.durationS)}${m.video.aspect ? ` · ${m.video.aspect}` : ""}${m.video.fps ? ` · ${Math.round(m.video.fps)} fps` : ""}`]);
  if (m.video.endCardS) rows.push(["App end card", `${fmtSeconds(m.video.endCardS)} (logo + @name) — left out of the numbers`]);
  if (m.cuts) {
    rows.push(["Cuts", m.cuts.count === 0 ? "None found" : `${m.cuts.count} · one every ${fmtSeconds(m.cuts.shotMedianS ?? 0)} (most ${fmtSeconds(m.cuts.shotP25S ?? 0)}–${fmtSeconds(m.cuts.shotP75S ?? 0)})`]);
    if (m.cuts.firstCutS != null) rows.push(["First cut", fmtSeconds(m.cuts.firstCutS)]);
    const p = m.cuts.pacing;
    rows.push(["Cuts per 10 s", `start ${p.first3sPer10s} · middle ${p.middlePer10s ?? "–"} · end ${p.last3sPer10s}`]);
  }
  if (m.speech) {
    const s = m.speech;
    if (s.wpm != null) rows.push(["Talking speed", `${s.wpm} words a minute`]);
    if (s.gapP90S != null) rows.push(["Pauses", `typical ${fmtSeconds(s.gapMedianS ?? 0)} · 90% under ${fmtSeconds(s.gapP90S)} · longest ${fmtSeconds(s.longestGapS ?? 0)}`]);
    rows.push(["Starts talking", fmtSeconds(s.speechStartS)]);
    if (s.hookDurationS != null) rows.push(["Hook", `“${s.hookText}” (${fmtSeconds(s.hookDurationS)})`]);
    rows.push(["Ending", `“${s.lastSentence}” · ${fmtSeconds(s.tailAfterLastWordS)} after the last word${s.closingShotAfterSpeech ? " · cuts to a closing shot" : ""}`]);
  }
  if (!m.speech && m.voice && !m.voice.present) rows.push(["Talking", `None — ${m.voice.reason.charAt(0).toLowerCase()}${m.voice.reason.slice(1)}`]);
  if (m.audio) {
    const a = m.audio;
    if (a.integratedLufs != null) rows.push(["Loudness", `${a.integratedLufs.toFixed(1)} LUFS${a.truePeakDbtp != null ? ` · peak ${a.truePeakDbtp.toFixed(1)} dBTP` : ""}`]);
    if (a.mix === "music-led") rows.push(["Sound", "Music-led — no voice"]);
    else if (a.mix === "quiet") rows.push(["Sound", "Quiet — no voice"]);
    // "Under the voice" only means something when there's a voice (older measurements may have dropped it).
    else if (m.speech) rows.push(["Background", a.background === "present" && a.backgroundUnderVoiceDb != null ? `${Math.round(a.backgroundUnderVoiceDb)} dB under the voice` : a.background === "none" ? "None (just the voice)" : "Couldn't tell"]);
    if (a.clipping) rows.push(["Distortion", "Peaks clip"]);
  }
  return (
    <dl className="mt-2 divide-y divide-[var(--color-border)]">
      {rows.map(([l, v]) => (
        <Row key={l} label={l} value={v} />
      ))}
      {m.notes.length > 0 && <p className="pt-2 text-[12.5px] text-[var(--color-text-faint)]">{m.notes.join(" ")}</p>}
    </dl>
  );
}

const STATUS: Record<string, { text: string; cls: string }> = {
  PENDING: { text: "Waiting to be measured", cls: "text-[var(--color-gold-400)]" },
  DONE: { text: "Measured", cls: "text-[var(--color-emerald-400)]" },
  FAILED: { text: "Couldn't measure", cls: "text-[var(--color-rose-400)]" },
};

export function VideoCard({ v, back, creators, creatorId }: { v: VideoRow; back: string; creators: Array<{ id: string; name: string }>; creatorId: string }) {
  const m = v.parsedMetrics;
  const status =
    v.analysisStatus === "PENDING" && m
      ? { text: "Waiting to be re-measured (current numbers shown)", cls: "text-[var(--color-gold-400)]" }
      : (STATUS[v.analysisStatus ?? ""] ?? { text: "Notes only", cls: "text-[var(--color-text-faint)]" });
  return (
    <li className="panel flex flex-col gap-1.5 p-4" data-testid="ref-video">
      {v.mediaStorageKey && (
        <video
          src={`/api/media/${v.mediaStorageKey.split("/").map(encodeURIComponent).join("/")}#t=0.5`}
          preload="metadata"
          muted
          playsInline
          controls
          className="mb-2 aspect-[9/16] max-h-[300px] w-auto self-start rounded-xl bg-black"
          data-testid="ref-video-preview"
        />
      )}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-[15px] font-medium">{v.mediaFilename ?? "Video"}</p>
          <p className={`text-[12.5px] ${status.cls}`}>
            {status.text}
            {v.platform ? ` · ${platformLabel(v.platform)}` : ""}
            {!v.mediaStorageKey && v.mediaDeletedAt ? " · file deleted, numbers kept" : ""}
          </p>
        </div>
        {v.sourceUrl && (
          <a href={v.sourceUrl} target="_blank" rel="noreferrer noopener" className="link-quiet shrink-0 text-[13px]">
            Open post ↗
          </a>
        )}
      </div>
      {m && <p className="text-[14.5px] font-semibold leading-snug" data-testid="ref-video-summary">{videoSummary(m) || "Measured"}</p>}
      {m?.speech?.hookText && <p className="text-[13.5px] leading-snug text-[var(--color-text-muted)]">Hook: “{m.speech.hookText}”</p>}
      {v.analysisStatus === "FAILED" && v.analysisError && <p className="text-[12.5px] text-[var(--color-rose-400)]">{v.analysisError}</p>}
      <details className="mt-1">
        <summary className="cursor-pointer py-1.5 text-[13.5px] text-[var(--color-gold-400)]">Details</summary>
        {m && <Details m={m} />}
        <form action={setReferenceVideoLink} className="mt-3 flex gap-2">
          <input type="hidden" name="referenceContentId" value={v.id} />
          <input type="hidden" name="back" value={back} />
          <input name="sourceUrl" type="url" inputMode="url" defaultValue={v.sourceUrl ?? ""} placeholder="Link to the post" className="field-input !min-h-[40px] !py-2 !text-[14px]" aria-label="Link to the post" />
          <Button className="shrink-0 !min-h-[40px]" pendingLabel="Saving…">
            Save
          </Button>
        </form>
        <form action={moveReferenceVideoAction} className="mt-3 flex flex-col gap-2" data-testid="ref-move">
          <input type="hidden" name="referenceContentId" value={v.id} />
          <input type="hidden" name="back" value={back} />
          <label className="text-[13px] text-[var(--color-text-faint)]">Wrong creator? Move it to</label>
          <div className="flex gap-2">
            <select name="to" defaultValue="" required className="field-input !min-h-[40px] !py-2 !text-[14px]" aria-label="Move to creator">
              <option value="" disabled>Pick a creator…</option>
              {creators.filter((c) => c.id !== creatorId).map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
              <option value="__new__">＋ Someone new (type below)</option>
            </select>
            <Button className="shrink-0 !min-h-[40px]" pendingLabel="Moving…">
              Move
            </Button>
          </div>
          <input name="newName" placeholder="New creator's name (only for ＋ Someone new)" className="field-input !min-h-[40px] !py-2 !text-[14px]" autoComplete="off" aria-label="New creator's name" />
        </form>
        {v.mediaStorageKey && (
          <details className="mt-3">
            <summary className="cursor-pointer py-1.5 text-[13px] text-[var(--color-text-faint)]">Delete the video file…</summary>
            <p className="mt-1 text-[12.5px] text-[var(--color-text-faint)]">Removes the file from storage. The measured numbers stay and still count toward the style.</p>
            <form action={deleteReferenceVideoFile} className="mt-2">
              <input type="hidden" name="referenceContentId" value={v.id} />
              <input type="hidden" name="back" value={back} />
              <Button tone="danger" pendingLabel="Deleting…">
                Delete file, keep numbers
              </Button>
            </form>
          </details>
        )}
      </details>
    </li>
  );
}
