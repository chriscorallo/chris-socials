"use client";

import { useRef, useState } from "react";
import type { NarratorVoice } from "@chris/agents/studio";
import { SubmitButton } from "../components/SubmitButton";
import { createFilmAction } from "./actions";

const LENGTHS = [30, 45, 60] as const;
const LOOKS = [
  { id: "GOLD_STUDIO", label: "Gold studio", hint: "Warm gold on black — premium product film" },
  { id: "NOIR_NUMBERS", label: "Noir numbers", hint: "Cool noir, glowing digits" },
] as const;

export function NewFilmForm({ ideas, voices, localAi }: { ideas: Array<{ id: string; title: string; description: string | null }>; voices: NarratorVoice[]; localAi: boolean }) {
  const [voice, setVoice] = useState(voices.find((v) => v.id === "am_michael")?.id ?? voices[0]?.id ?? "am_michael");
  const [seconds, setSeconds] = useState<number>(45);
  const [look, setLook] = useState<string>("GOLD_STUDIO");
  const [source, setSource] = useState("");
  const [playing, setPlaying] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);

  function play(v: NarratorVoice) {
    if (!v.sampleUrl) return;
    audio.current?.pause();
    if (playing === v.id) {
      setPlaying(null);
      return;
    }
    const a = new Audio(v.sampleUrl);
    audio.current = a;
    a.onended = () => setPlaying(null);
    a.onerror = () => setPlaying(null);
    void a.play().catch(() => setPlaying(null));
    setPlaying(v.id);
  }

  return (
    <form action={createFilmAction} className="flex flex-col gap-5" data-testid="new-film">
      <div>
        <label htmlFor="idea" className="text-[15px] font-semibold">
          What's the film about?
        </label>
        <textarea
          id="idea"
          name="idea"
          rows={3}
          placeholder="e.g. Why your raise disappears — lifestyle creep, and the one move that keeps it"
          className="mt-2 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 py-3 text-[16px] leading-snug outline-none focus:border-[var(--color-gold-500)]"
        />
        {ideas.length > 0 && (
          <div className="mt-2">
            <label htmlFor="source" className="text-[13px] text-[var(--color-text-muted)]">
              …or start from a planned video
            </label>
            <select id="source" name="sourceContentItemId" value={source} onChange={(e) => setSource(e.target.value)} className="mt-1 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 py-3 text-[15px]">
              <option value="">— none —</option>
              {ideas.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.title}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      <fieldset>
        <legend className="text-[15px] font-semibold">Length</legend>
        <div className="mt-2 grid grid-cols-3 gap-2">
          {LENGTHS.map((s) => (
            <button type="button" key={s} onClick={() => setSeconds(s)} aria-pressed={seconds === s} className={`min-h-[48px] rounded-xl border text-[15px] font-medium ${seconds === s ? "border-[var(--color-gold-500)] bg-[color-mix(in_srgb,var(--color-gold-500)_14%,transparent)] text-[var(--color-gold-400)]" : "border-[var(--color-border)] bg-[var(--color-surface-raised)]"}`}>
              {s} s
            </button>
          ))}
        </div>
        <input type="hidden" name="seconds" value={seconds} />
      </fieldset>

      <fieldset>
        <legend className="text-[15px] font-semibold">Look</legend>
        <div className="mt-2 grid grid-cols-2 gap-2">
          {LOOKS.map((l) => (
            <button type="button" key={l.id} onClick={() => setLook(l.id)} aria-pressed={look === l.id} className={`flex min-h-[64px] flex-col items-start justify-center rounded-xl border px-3 text-left ${look === l.id ? "border-[var(--color-gold-500)] bg-[color-mix(in_srgb,var(--color-gold-500)_14%,transparent)]" : "border-[var(--color-border)] bg-[var(--color-surface-raised)]"}`}>
              <span className="text-[15px] font-medium">{l.label}</span>
              <span className="text-[12px] leading-tight text-[var(--color-text-faint)]">{l.hint}</span>
            </button>
          ))}
        </div>
        <input type="hidden" name="look" value={look} />
      </fieldset>

      <fieldset>
        <legend className="text-[15px] font-semibold">Narrator</legend>
        <ul className="mt-2 flex flex-col gap-1.5" data-testid="voices">
          {voices.map((v) => (
            <li key={v.id} className={`flex min-h-[52px] items-center gap-2 rounded-xl border px-2 ${voice === v.id ? "border-[var(--color-gold-500)] bg-[color-mix(in_srgb,var(--color-gold-500)_10%,transparent)]" : "border-[var(--color-border)] bg-[var(--color-surface-raised)]"}`}>
              <button type="button" onClick={() => play(v)} disabled={!v.sampleUrl} aria-label={`Play ${v.label}`} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white/[0.06] text-[var(--color-gold-400)] disabled:opacity-30">
                {v.engine === "CHRIS" ? "🎙" : playing === v.id ? "❚❚" : "▶"}
              </button>
              <button type="button" onClick={() => setVoice(v.id)} aria-pressed={voice === v.id} className="min-h-[48px] flex-1 text-left">
                <span className="block text-[15px]">{v.label}</span>
                {v.note && <span className="block text-[12px] leading-tight text-[var(--color-text-faint)]">{v.note}</span>}
              </button>
            </li>
          ))}
        </ul>
        <input type="hidden" name="voice" value={voice} />
      </fieldset>

      {localAi && (
        <label className="flex items-start gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-3">
          <input type="checkbox" name="aiMode" value="LOCAL" className="mt-1 h-5 w-5" />
          <span className="text-[14px] leading-snug">
            Let my Mac's local AI answer the crew's questions (free, slower, no copy-paste). ChatGPT is still there if it can't.
          </span>
        </label>
      )}

      <div className="rounded-xl bg-[var(--color-surface-raised)] p-3 text-[14px] leading-snug" data-testid="cost">
        <p className="font-semibold">Cost: $0</p>
        <p className="mt-1 text-[var(--color-text-muted)]">
          The checks (math, continuity, picture-matches-words, safe zones) run automatically. The creative calls are two copy-paste rounds with your ChatGPT — write the film, then review the storyboard. Rendering runs on your own machine or the cloud worker you already have.
        </p>
      </div>

      <SubmitButton className="btn btn-primary w-full !min-h-[56px] !text-[17px]" pendingLabel="Assembling your crew…">
        Start the film
      </SubmitButton>
    </form>
  );
}
