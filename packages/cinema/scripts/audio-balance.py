"""Voice-over-music balance of a rendered film: RMS of the voice bus vs the (ducked) score inside
speech windows and between lines, with the gains the mix applied (report-final.json).
  python3 -I scripts/audio-balance.py <film output dir>
"""
import json, math, sys, wave, array, os

d = sys.argv[1]
rep = json.load(open(os.path.join(d, "report-final.json")))
tim = json.load(open(os.path.join(d, "timing.json")))


def load(p):
    w = wave.open(p)
    sr, ch = w.getframerate(), w.getnchannels()
    a = array.array("h", w.readframes(w.getnframes()))
    mono = [(a[i] + a[i + 1]) / 2 if ch == 2 else a[i] for i in range(0, len(a), ch)]
    return sr, mono


def rms_db(sr, x, wins, gain_db):
    s, n = 0.0, 0
    for a, b in wins:
        for v in x[int(a * sr):int(b * sr)]:
            s += v * v
            n += 1
    return 20 * math.log10(math.sqrt(s / max(1, n)) / 32768 + 1e-12) + gain_db


speech = [(sh["words"][0]["s"], sh["words"][-1]["e"]) for sh in tim["shots"] if sh["words"]]
gaps = [(speech[i][1] + 0.5, speech[i + 1][0] - 0.2) for i in range(len(speech) - 1) if speech[i + 1][0] - speech[i][1] > 0.9]
vsr, voice = load(os.path.join(d, "audio-work", "voice-bus.wav"))
msr, music = load(os.path.join(d, "audio-work", "score.wav"))
m = rep["mix"]
v_s = rms_db(vsr, voice, speech, m["voiceGainDb"])
m_s = rms_db(msr, music, speech, m["musicGainDb"])
m_g = rms_db(msr, music, gaps, m["musicGainDb"]) if gaps else float("nan")
print(json.dumps({"voice_rms_db_in_speech": round(v_s, 1), "music_rms_db_under_speech": round(m_s, 1), "voice_over_music_db": round(v_s - m_s, 1), "music_rms_db_between_lines": round(m_g, 1), "gap_windows": len(gaps), "final_lufs": m["final"]["integratedLufs"], "true_peak": m["final"]["truePeakDb"]}, indent=1))
