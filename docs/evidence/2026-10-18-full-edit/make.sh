#!/bin/zsh
# Builds a Full-edit test take: macOS `say` monologue + faint room tone over the portrait with handheld drift.
set -e
SC=/private/tmp/claude-501/-Users-christophercorallo-Desktop-Claude-Projects-Chris-Socials/2fa27366-298a-4c40-a49e-d2c8b0f369a9/scratchpad
D=$SC/fulledit
FF="/Users/christophercorallo/Desktop/Claude Projects/Chris Socials/.claude/worktrees/agent-aad446c9bef68772d/node_modules/.pnpm/ffmpeg-static@5.3.0/node_modules/ffmpeg-static/ffmpeg"
NAME=${1}
VOICE=${2}
RATE=${3}
say -v "$VOICE" -r $RATE -o $D/$NAME.aiff -f $D/$NAME.txt
"$FF" -hide_banner -loglevel error -y -i $D/$NAME.aiff -f lavfi -i "anoisesrc=color=pink:amplitude=0.004:sample_rate=48000" \
  -filter_complex "[0:a]aresample=48000[v];[v][1:a]amix=inputs=2:duration=first:normalize=0[a]" -map "[a]" -ac 1 $D/$NAME.wav
SECS=$("$FF" -hide_banner -i $D/$NAME.wav 2>&1 | sed -n 's/.*Duration: 00:\([0-9]*\):\([0-9.]*\).*/\1 \2/p' | awk '{print $1*60+$2}')
echo "$NAME voice: ${SECS}s"
node $D/make-portrait.mjs $SC/face/reagan.jpg $D/$NAME.mp4 ${SECS} $D/$NAME.wav
rm -f $D/$NAME.aiff
ls -la $D/$NAME.mp4
