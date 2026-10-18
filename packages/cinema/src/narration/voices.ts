/**
 * Narration voices. Kokoro-82M ships 28 English voices; the model card (hexgrad/Kokoro-82M
 * VOICES.md, checked 2026-10-18) grades each by target quality and training data. The curated
 * list below is the subset worth offering for calm, cinematic money narration — chosen from that
 * grading plus our own measured audition (scripts/voice-audition.ts: Whisper intelligibility,
 * pitch spread, pace, high-frequency hiss). Samples: packages/cinema/assets/voice-samples/.
 * Pure data (browser-safe).
 */

export interface KokoroVoiceInfo {
  id: string;
  gender: "female" | "male";
  accent: "US" | "UK";
  /** Model-card grades. */
  targetQuality: string;
  overallGrade: string;
  trainingData: string;
}

export const KOKORO_ENGLISH_VOICES: KokoroVoiceInfo[] = [
  { id: "af_heart", gender: "female", accent: "US", targetQuality: "A", overallGrade: "A", trainingData: "—" },
  { id: "af_alloy", gender: "female", accent: "US", targetQuality: "B", overallGrade: "C", trainingData: "MM minutes" },
  { id: "af_aoede", gender: "female", accent: "US", targetQuality: "B", overallGrade: "C+", trainingData: "H hours" },
  { id: "af_bella", gender: "female", accent: "US", targetQuality: "A", overallGrade: "A-", trainingData: "HH hours" },
  { id: "af_jessica", gender: "female", accent: "US", targetQuality: "C", overallGrade: "D", trainingData: "MM minutes" },
  { id: "af_kore", gender: "female", accent: "US", targetQuality: "B", overallGrade: "C+", trainingData: "H hours" },
  { id: "af_nicole", gender: "female", accent: "US", targetQuality: "B", overallGrade: "B-", trainingData: "HH hours" },
  { id: "af_nova", gender: "female", accent: "US", targetQuality: "B", overallGrade: "C", trainingData: "MM minutes" },
  { id: "af_river", gender: "female", accent: "US", targetQuality: "C", overallGrade: "D", trainingData: "MM minutes" },
  { id: "af_sarah", gender: "female", accent: "US", targetQuality: "B", overallGrade: "C+", trainingData: "H hours" },
  { id: "af_sky", gender: "female", accent: "US", targetQuality: "B", overallGrade: "C-", trainingData: "M minutes" },
  { id: "am_adam", gender: "male", accent: "US", targetQuality: "D", overallGrade: "F+", trainingData: "H hours" },
  { id: "am_echo", gender: "male", accent: "US", targetQuality: "C", overallGrade: "D", trainingData: "MM minutes" },
  { id: "am_eric", gender: "male", accent: "US", targetQuality: "C", overallGrade: "D", trainingData: "MM minutes" },
  { id: "am_fenrir", gender: "male", accent: "US", targetQuality: "B", overallGrade: "C+", trainingData: "H hours" },
  { id: "am_liam", gender: "male", accent: "US", targetQuality: "C", overallGrade: "D", trainingData: "MM minutes" },
  { id: "am_michael", gender: "male", accent: "US", targetQuality: "B", overallGrade: "C+", trainingData: "H hours" },
  { id: "am_onyx", gender: "male", accent: "US", targetQuality: "C", overallGrade: "D", trainingData: "MM minutes" },
  { id: "am_puck", gender: "male", accent: "US", targetQuality: "B", overallGrade: "C+", trainingData: "H hours" },
  { id: "am_santa", gender: "male", accent: "US", targetQuality: "C", overallGrade: "D-", trainingData: "M minutes" },
  { id: "bf_alice", gender: "female", accent: "UK", targetQuality: "C", overallGrade: "D", trainingData: "MM minutes" },
  { id: "bf_emma", gender: "female", accent: "UK", targetQuality: "B", overallGrade: "B-", trainingData: "HH hours" },
  { id: "bf_isabella", gender: "female", accent: "UK", targetQuality: "B", overallGrade: "C", trainingData: "MM minutes" },
  { id: "bf_lily", gender: "female", accent: "UK", targetQuality: "C", overallGrade: "D", trainingData: "MM minutes" },
  { id: "bm_daniel", gender: "male", accent: "UK", targetQuality: "C", overallGrade: "D", trainingData: "MM minutes" },
  { id: "bm_fable", gender: "male", accent: "UK", targetQuality: "B", overallGrade: "C", trainingData: "MM minutes" },
  { id: "bm_george", gender: "male", accent: "UK", targetQuality: "B", overallGrade: "C", trainingData: "MM minutes" },
  { id: "bm_lewis", gender: "male", accent: "UK", targetQuality: "C", overallGrade: "D+", trainingData: "H hours" },
];

export interface NarrationVoice {
  id: string;
  label: string;
  gender: "female" | "male";
  accent: "US" | "UK";
  /** How it sounds / what it suits (from the audition). */
  vibe: string;
  /** Suggested speaking rate for calm cinematic narration. */
  suggestedSpeed: number;
  /** Sample (repo-relative), the audition line at the suggested speed. */
  sample: string;
  engine: "KOKORO";
}

const v = (id: string, label: string, gender: "female" | "male", accent: "US" | "UK", vibe: string, suggestedSpeed: number): NarrationVoice => ({
  id,
  label,
  gender,
  accent,
  vibe,
  suggestedSpeed,
  sample: `packages/cinema/assets/voice-samples/${id}.m4a`,
  engine: "KOKORO",
});

/**
 * The curated 9 (of 28), in the order to offer them. Chosen on the model card's grades (target
 * quality A/B, enough training data) plus the 2026-10-18 audition (all 28 on the same two
 * sentences, q8): every one was 100 % intelligible to Whisper; excluded were the D-grade voices,
 * af_nicole (a whispery ASMR voice — only 22 % voiced frames, half the pace) and bm_fable (the
 * most high-frequency hiss, 3–10× the others). "Spread" = pitch range in semitones (p10–p90).
 */
export const NARRATION_VOICES: NarrationVoice[] = [
  v("af_heart", "Heart", "female", "US", "Warm, intimate, steady — the model's top-graded voice (A). The default narrator. Spread 7.7 st.", 0.92),
  v("am_michael", "Michael", "male", "US", "Deep and calm, naturally unhurried with clean breaks between sentences — the most 'documentary' male voice. Spread 9.1 st.", 0.95),
  v("af_bella", "Bella", "female", "US", "Bright and polished (A-), a little more energy — good for upbeat payoffs. Spread 6.3 st.", 0.95),
  v("bf_emma", "Emma", "female", "UK", "Polished British (B-), measured and editorial — a premium, BBC-explainer feel. Spread 5.8 st.", 0.95),
  v("bm_george", "George", "male", "UK", "Measured British male, warm and deliberate, very clean (low hiss). Spread 8.2 st.", 0.92),
  v("af_sarah", "Sarah", "female", "US", "Clear and expressive — the widest natural pitch movement of the well-graded female voices; storytelling. Spread 10.6 st.", 0.95),
  v("af_kore", "Kore", "female", "US", "Lower and calm with a very expressive contour — reflective, late-night tone. Spread 10.4 st.", 0.95),
  v("am_fenrir", "Fenrir", "male", "US", "Lively intonation, confident — an energetic explainer. Spread 12.3 st.", 0.95),
  v("am_puck", "Puck", "male", "US", "Brighter, younger and conversational — casual, friendly. Spread 11.3 st.", 0.95),
];

/** Chris's own voice (engine "CHRIS"): recorded, then aligned with narrationFromRecording. */
export const CHRIS_VOICE = { id: "chris", label: "Your voice", engine: "CHRIS" as const, vibe: "Record the script (one take is fine); the film is timed to your real words." };

/** The voice a film uses when none is chosen. */
export const DEFAULT_NARRATION_VOICE = "af_heart";
