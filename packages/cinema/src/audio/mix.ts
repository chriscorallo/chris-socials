import { join } from "node:path";
import { measureLoudness, runFfmpeg, type LoudnessReport } from "./ffmpeg";

/**
 * The film's sound mix (Node, ffmpeg):
 *   voice bus  = every narration line at its resolved time → high-pass, gentle compression,
 *                a little presence; leveled to −16 LUFS before the master.
 *   music      = the procedural score (already ducked in-sample under speech), leveled to
 *                `musicUnderVoiceDb` below the voice bus (between lines; under words it sits a
 *                further |duckDb| lower).
 *   sfx        = every hit at its time, house level −9 dB under the voice + the cue's gainDb.
 *   master     = two-pass loudnorm to −14 LUFS integrated, true peak ≤ −1.5 dBTP.
 * Graph builders are pure (unit-tested); `mixFilm` runs them.
 */

export const TARGET_LUFS = -14;
export const TARGET_TP = -1.5;
export const VOICE_BUS_LUFS = -16;
export const SFX_HOUSE_DB = -9;

export interface VoiceClip {
  path: string;
  start: number;
}
export interface SfxHit {
  path: string;
  time: number;
  gainDb: number;
}

const ms = (s: number) => Math.max(0, Math.round(s * 1000));

/** ffmpeg args that lay the narration clips on one stereo bus of `duration` seconds. */
export function voiceBusArgs(clips: VoiceClip[], duration: number, out: string): string[] {
  const args: string[] = [];
  clips.forEach((c) => args.push("-i", c.path));
  const chains = clips.map((c, i) => `[${i}:a]aresample=48000,aformat=channel_layouts=stereo,adelay=${ms(c.start)}|${ms(c.start)}[v${i}]`);
  const mix = `${clips.map((_, i) => `[v${i}]`).join("")}amix=inputs=${clips.length}:normalize=0:dropout_transition=0,apad,atrim=0:${duration.toFixed(3)}`;
  const voice = `highpass=f=75,acompressor=threshold=-22dB:ratio=2.4:attack=6:release=90:makeup=2,equalizer=f=3200:t=q:w=1.1:g=1.5,equalizer=f=220:t=q:w=1:g=-1.2`;
  args.push("-filter_complex", `${chains.join(";")};${mix},${voice}[out]`, "-map", "[out]", "-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le", out);
  return args;
}

/** ffmpeg args for the pre-master: voice + music + sfx with explicit gains. */
export function premixArgs(input: { voiceBus: string; voiceGainDb: number; music: string | null; musicGainDb: number; sfx: SfxHit[]; duration: number; out: string }): string[] {
  const args = ["-i", input.voiceBus];
  if (input.music) args.push("-i", input.music);
  const sfxBase = input.music ? 2 : 1;
  input.sfx.forEach((h) => args.push("-i", h.path));
  const parts: string[] = [`[0:a]volume=${input.voiceGainDb.toFixed(2)}dB[voice]`];
  const labels = ["[voice]"];
  if (input.music) {
    parts.push(`[1:a]aresample=48000,aformat=channel_layouts=stereo,volume=${input.musicGainDb.toFixed(2)}dB,apad,atrim=0:${input.duration.toFixed(3)}[music]`);
    labels.push("[music]");
  }
  input.sfx.forEach((h, i) => {
    parts.push(`[${sfxBase + i}:a]aresample=48000,aformat=channel_layouts=stereo,volume=${(input.voiceGainDb + SFX_HOUSE_DB + h.gainDb).toFixed(2)}dB,adelay=${ms(h.time)}|${ms(h.time)}[s${i}]`);
    labels.push(`[s${i}]`);
  });
  parts.push(`${labels.join("")}amix=inputs=${labels.length}:normalize=0:dropout_transition=0,atrim=0:${input.duration.toFixed(3)}[out]`);
  args.push("-filter_complex", parts.join(";"), "-map", "[out]", "-ar", "48000", "-ac", "2", "-c:a", "pcm_s24le", input.out);
  return args;
}

interface LoudnormMeasure {
  input_i: string;
  input_tp: string;
  input_lra: string;
  input_thresh: string;
  target_offset: string;
}

export function loudnormPass2Filter(m: LoudnormMeasure): string {
  return `loudnorm=I=${TARGET_LUFS}:TP=${TARGET_TP}:LRA=11:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true:print_format=summary`;
}

export interface MixReport {
  voice: LoudnessReport;
  music: LoudnessReport | null;
  final: LoudnessReport;
  voiceGainDb: number;
  musicGainDb: number;
  sfxHits: number;
}

export async function mixFilm(input: {
  workDir: string;
  voice: VoiceClip[];
  music: string | null;
  /** Music level between lines, relative to the voice bus (dB, negative). */
  musicUnderVoiceDb: number;
  sfx: SfxHit[];
  duration: number;
  out: string;
}): Promise<MixReport> {
  const voiceBus = join(input.workDir, "voice-bus.wav");
  await runFfmpeg(voiceBusArgs(input.voice, input.duration, voiceBus));
  const voice = await measureLoudness(voiceBus);
  const voiceGainDb = Number.isFinite(voice.integratedLufs) ? VOICE_BUS_LUFS - voice.integratedLufs : 0;
  let music: LoudnessReport | null = null;
  let musicGainDb = 0;
  if (input.music) {
    music = await measureLoudness(input.music);
    // The score is measured WITH its ducks, so its integrated level understates the between-line
    // level by a few dB; +3 dB compensates (checked by ear/meter in the proof film).
    musicGainDb = Number.isFinite(music.integratedLufs) ? VOICE_BUS_LUFS + input.musicUnderVoiceDb + 3 - music.integratedLufs : -20;
  }
  const premix = join(input.workDir, "premix.wav");
  await runFfmpeg(premixArgs({ voiceBus, voiceGainDb, music: input.music, musicGainDb, sfx: input.sfx, duration: input.duration, out: premix }));
  const { stderr } = await runFfmpeg(["-nostats", "-i", premix, "-af", `loudnorm=I=${TARGET_LUFS}:TP=${TARGET_TP}:LRA=11:print_format=json`, "-f", "null", "-"]);
  const json = stderr.slice(stderr.lastIndexOf("{"), stderr.lastIndexOf("}") + 1);
  const m = JSON.parse(json) as LoudnormMeasure;
  await runFfmpeg(["-i", premix, "-af", `${loudnormPass2Filter(m)},aresample=48000,aformat=sample_fmts=s16:channel_layouts=stereo`, "-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le", input.out]);
  const final = await measureLoudness(input.out);
  return { voice, music, final, voiceGainDb, musicGainDb, sfxHits: input.sfx.length };
}
