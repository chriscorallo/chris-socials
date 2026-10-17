# Cloud worker: heavy jobs in Vercel Sandbox (pending merge into DECISIONS.md)

---

## 2026-10-17 — Heavy jobs run in a Vercel Sandbox microVM on the live site

**Problem.** Chris uses the app on his iPhone against the Vercel deployment. Everything heavy
was impossible there: the motion layer needs headless Chrome (Remotion) — renders silently
degraded to "no graphics"; Whisper, the face tracker and the MODNet person matte need
onnxruntime and minutes of CPU — all were off on Vercel. No transcripts, no mattes, no
animated exports from the phone.

**Decision.** Every heavy job goes through one dispatcher, `apps/web/lib/heavy-jobs.ts`
`runHeavyJob(kind, args, { actorId })`:

- **inline** (local `next dev`, default when `VERCEL` is unset): runs in-process exactly as
  before and returns the outcome (same domain functions, same audit trail);
- **sandbox** (default on Vercel; `RENDER_MODE=inline|sandbox` overrides): claims the item's
  lease, boots a **Vercel Sandbox** from the cloud-worker snapshot (`RENDER_SANDBOX_SNAPSHOT_ID`,
  8 vCPU / 16 GB, 45 min hard timeout), writes the job's env + args as files, starts
  `run-job.sh <kind>` **detached** and returns the JobRun id at once (~2 s). The phone polls
  `GET /api/jobs/[id]`.

Job kinds (`apps/worker/src/heavy-job-kinds.ts`): `render` (motion layer + matte compositing;
`thenQualityGate` runs the four hard gates in the same VM for the editor's Finish),
`quality-gate`, `auto-repair`, `transcribe`, `subject-track`, `person-matte`, `ingest`
(upload analysis: every take's captions first, then face tracking, then mattes — re-reading the
item so takes uploaded meanwhile are included), `motion-design` (Design visuals with AI, with
face tracking first). Platform variants (publish) were not moved: they are light ffmpeg work
that already runs in a function.

**One implementation.** `apps/worker/src/heavy-jobs.ts` `executeHeavyJob` /
`runHeavyJobRecorded` is the only executor — the local in-process path and the sandbox CLI
(`apps/worker/src/job-runner.ts`) call the same function, which calls the existing worker jobs
(`renderContentItem`, `runQualityGateForContentItem`, …). The cloud path is the local path.

**Runner (`job-runner.ts`).** `node job-runner.mjs <kind> <json|@file> --job-run-id <id>
--env-file <0600 json> --stop-self`. Secrets (DATABASE_URL, BLOB_READ_WRITE_TOKEN, and
ANTHROPIC_API_KEY *only* for kinds that call the model) travel in a file the runner deletes on
read — never on a command line. Real database (Prisma 7 + `@prisma/adapter-pg` + the WASM
query compiler: no native engine, bundles cleanly), real private Blob store (the Blob adapter
moved to `apps/worker/src/blob-storage.ts`; `apps/web/lib/blob-storage.ts` re-exports it). The
model provider is the same cost-tracked, spend-capped Anthropic provider the web app uses.
Progress goes on the JobRun (throttled to one write / 2 s); the result and a plain-English
message when done; a crash, a kill (SIGTERM) or a timeout records FAILED with the reason.
`--offline <job.json>` runs render / transcribe / subject-track / person-matte on local files
(no DB, no storage) — used to verify a snapshot. `warmup` downloads every model.

**JobRun as job record + lease, no schema change.** `kind = heavy:<contentItemId>` (exact-match
on the existing `(kind, startedAt)` index, like the publish lease); `summary` JSON holds
`{ jobKind, args, mode, actorId, progress { pct, message, stage }, sandboxName, result }`.
`acquireHeavyJobLease` (packages/domain job-run.ts) serializes claims with one advisory lock:
**one heavy job per video** (a second tap gets BUSY and follows the running job), **at most
`HEAVY_JOB_MAX_SANDBOXES` (default 4) sandboxes at once**, and a RUNNING row older than the
sandbox timeout + 5 min is taken over as dead. Beyond the cap a job is **QUEUED** (status
`QUEUED`, FIFO, "Waiting for a free cloud worker…", reads as running to clients with
`queued: true`) instead of refused — a batch upload of many clips must not lose captions:
a worker that finishes keeps its VM and **drains the queue** (`claimQueuedHeavyJob`; without the
model key only non-AI kinds; only while ≥ 15 min of its sandbox time is left), and every poll of
a queued/finished job (`/api/jobs/[id]`, the upload screen's caption wait) starts queued jobs in
new sandboxes while there's capacity (`kickQueuedHeavyJobs`). A queued job nobody starts within
2 h is FAILED.
Progress/finish writes are single-statement `jsonb ||` merges; `finishHeavyJob` is
first-writer-wins (a late worker can't overwrite the web app's "worker vanished" verdict).

**Always stopped.** Measured: powering the VM off from inside (`/proc/sysrq-trigger`) ends the
VM but Vercel keeps reporting the sandbox "running" until its timeout (watched for 2+ min), so
it isn't a stop. The worker therefore **stops its own sandbox through the API** when the job is
recorded, with the project's short-lived OIDC token the dispatcher passes in the env file
(verified: "stopped" 4 s after launch for a job that failed fast — `scripts/sandbox/verify-dispatch.ts`).
Backstops: each poll of `/api/jobs/[id]` stops a finished job's sandbox once, and marks a job
FAILED when its sandbox is gone or stopped while the job says RUNNING (checked only after 60 s
without progress); the 45-min sandbox timeout is the last resort. Launch failure → the JobRun
is FAILED with the reason, the sandbox (if created) is stopped, nothing else was written.

**UI (progress only — page layouts untouched).** `useJobProgress` / `waitForJob`
(`apps/web/lib/use-job-progress.ts`) poll every 2 s and ride out flaky mobile connections.
A floating card on a video's pages (`app/content/[id]/layout.tsx` + `HeavyJobBanner.tsx`) shows
"Rendering your graphics… 40%", refreshes the page when the job ends, and says how it went;
the content page's Render / Quality check / Transcribe / Auto-repair / Autopilot buttons open the
page with `?job=<id>`. Finish & schedule: on Vercel one job renders and then quality-checks;
the modal shows the render's stages and percentage, then the check, then schedules (locally:
unchanged, four sequential actions). Design visuals with AI follows its job, then loads the
saved version. Autopilot stops at a cloud step and says so (press again when it's done).
Upload flow: the upload's one `ingest` job transcribes first; the upload screen's "Getting your
captions ready…" wait (flow-actions `captionStatus`) now shows the job's progress line and stops
waiting if no job is running (failed / never started). Batch upload (`/plan/upload`): every
clip's registration starts (or queues) its item's `ingest` job; the starter edit is a plain
EditPlan converted at editor LOAD time, so captions are on as soon as the transcript has landed
(an editor opened before that shows captions after a reload — the editor doesn't live-poll).

**Flags.** `isAutoTranscriptionEnabled` / `isAutoSubjectTrackingEnabled` / `isAutoPersonMatteEnabled`
default to ON on Vercel when the cloud worker is configured (still `TRANSCRIPTION|SUBJECT_TRACKING|PERSON_MATTE=on|off`
overrides). Without `RENDER_SANDBOX_SNAPSHOT_ID`, sandbox mode refuses heavy jobs with a clear
message ("The cloud renderer isn't set up yet…") instead of silently rendering without graphics.

**Alternatives considered.** A long-running worker host (another service to run and pay for
24/7, for a single operator); Remotion Lambda (AWS account + fetching alpha clips back; Whisper/
ONNX still homeless); a Vercel Function with `@sparticuz/chromium` (250 MB / 300 s limits — no
room for Whisper + MODNet + Chrome, and long renders don't fit); a custom VCR image instead of a
snapshot (cleaner, but needs a Docker build pipeline — the snapshot is built by a script).

**Reversibility.** High: `RENDER_MODE=inline` restores the previous behaviour everywhere; unset
`RENDER_SANDBOX_SNAPSHOT_ID` and heavy actions refuse clearly. No schema change.

---

## 2026-10-17 — The cloud-worker artifact and snapshot

**Image.** Managed image `vercel/sandbox/node:24` (Ubuntu 26.04, Node 24, apt, passwordless
sudo — the `runtime: "node24"` Amazon Linux option is deprecated in SDK 3.x). Chrome headless
shell's libraries via apt (t64 package names, with fallbacks).

**Artifact (`scripts/sandbox/build-runner.ts`, deterministic, content-hashed `VERSION`).**
`.sandbox-build/runner/`: `apps/worker/dist/job-runner.mjs` (esbuild, node24 ESM, minified with
names kept; Prisma client, pg, Blob, Anthropic SDK, the domain/agents/media/motion code all
bundled); externals installed with npm in the sandbox at the repo's pinned versions —
`ffmpeg-static`, `ffprobe-static`, `onnxruntime-node`, `@huggingface/transformers`,
`@remotion/renderer` (+ its Linux compositor); `prompts/`, `brand/`, `packages/media/assets`,
the SFX kit — laid out like the repo so `REPO_ROOT`-relative reads keep working; and the
**Remotion project pre-bundled** with `@remotion/bundler` at build time (`motion-bundle/`, used
via the new `MOTION_BUNDLE_DIR`; no webpack/rspack in the VM). `bin/run-job.sh` sets the
runtime paths (`RENDER_FONTS_DIR`, `SUBJECT_TRACK_MODEL_PATH`, `MOTION_SFX_DIR`,
`MOTION_BUNDLE_DIR`, `MATTE_CACHE_DIR`, `TRANSCRIPTION_CACHE_DIR`, `REMOTION_GL=swangle`,
`REMOTION_CONCURRENCY=2`; each overridable per job). `MANIFEST.sha256` lists every file.

**Snapshot (`scripts/sandbox/create-snapshot.ts`).** Boot → apt → upload the runner →
restore → `npm install` → `run-job.sh warmup` (Chrome headless shell, Whisper base.en
timestamped ~280 MB and MODNet ~26 MB downloaded *inside* the VM into `/vercel/sandbox/cache`)
→ smoke tests (ffmpeg/ffprobe, an offline render with a 2D and a 3D graphic that must produce 2
overlays, the face tracker, the person matte) → `sandbox.snapshot({ expiration: 0 })` → prints
the id and writes `.sandbox-build/snapshot.json`. Snapshot ≈ 1.4 GB.

*Upload constraint found:* the operator's connection uploaded at ~50 KB/s (writeFiles and a
plain HTTPS POST alike), and one 15 MB `writeFiles` stalled. So the upload is "lite" (7.2 MB):
source maps dropped (empty stub maps are written — Remotion opens them when it symbolicates an
error, and a missing map hid the real error), the Remotion `public/` copy re-created from the
assets, the UltraFace model downloaded from its source URL, the SFX regenerated by their
deterministic generator — then the whole tree is checked with `sha256sum -c MANIFEST.sha256`
(it passes: the regenerated WAVs are byte-identical). Uploads go in 768 KB chunks with
per-chunk retry. `--resume <sandbox> --from <step>` + `--keep-on-failure` continue a failed
build; `--base <snapshotId>` rebuilds on top of a previous snapshot and uploads only changed
files (MANIFEST diff) — ~1.5 min instead of ~6.

*GPU-less WebGL:* `gl: "angle"` fails in the VM ("Error creating WebGL context") — the 3D
templates need `REMOTION_GL=swangle` (ANGLE on SwiftShader). SwiftShader is multi-threaded per
tab, so fewer tabs is faster: same 159 frames on 8 vCPU took 89 s at concurrency 1, **60 s at
2**, 117 s at 4, 152 s at 8 (single runs, ±30 % run-to-run). 4 vCPU was much slower (render
213 s vs 86–131 s) — 8 vCPU (Pro max) is the default.

**Verified for real (2026-10-17, snapshot `snap_w3kag80j7aDxYTFz8kXk7FzO3e2b`, runner
`d4ec0ab1e37ecd97`; the same render path verified on its predecessors).**
`scripts/sandbox/verify-offline.ts`: a 6 s 1080×1920 talking-head stand-in (the public-domain
portrait fixture with headroom, drift and a tone) with `$24,500` NUMBER_COUNTER **BEHIND_SUBJECT**
over the head and a 3D ICON_3D (shadow, light wrap, scene match), rendered by
`run-job.sh render --offline` in the sandbox: face track → MODNet matte → Remotion layer →
depth compositing, `behindSubject: 1, mattedClips: 1`, no warnings. Frames:
`docs/evidence/2026-10-17-cloud-renderer/` — the digits pass behind the hair, the 3D piggy bank
renders (WebGL in the VM). Report: `sandbox-verify-report.json`.

| Measurement (8 vCPU) | Value |
|---|---|
| Boot from snapshot | 1.4–2.9 s |
| Dispatch (create + write files + start detached), as the web app does it | 2.2 s |
| Render, 6 s clip, 2 graphics, matte computed in-job | 83–131 s (matte 15–23 s · motion 57–93 s · compose 9–13 s) |
| Whisper base.en, 6 s clip / face track | 4.4–5.5 s / 1.6–2 s |
| Verification session (render + transcribe + track + download to laptop) | 168 s, 812 s active CPU |

---

## 2026-10-17 — Cost (Vercel Sandbox pricing fetched 2026-10-17, iad1, Pro)

Active CPU **$0.128 / hour**, provisioned memory **$0.0212 / GB-hour** (2 GB per vCPU → 16 GB at
8 vCPU = $0.34 / hour of wall time), creations $0.60 / million, snapshot storage $0.08 / GB-month,
inbound data free. Pro's $20/month credit applies first.

- Verification session above: 812 s CPU → $0.029 + 16 GB × 168 s → $0.016 ≈ **$0.045**.
- Typical Finish (45 s video, ~12 s of graphics ≈ 360 motion frames, quality check included):
  ~5 min wall (motion 2.5–3.5 min, compose ~1.3 min, I/O + check ~1 min) → memory ≈ $0.03,
  CPU ≤ 8 vCPU × 5 min ≈ $0.085 → **≈ $0.06–0.11 per render**.
- Upload analysis of a 60 s take (captions ~30 s, tracking ~10 s, matte ~3 min) ≈ 4 min →
  **≈ $0.05–0.09**.
- 20 videos/month × (1 upload analysis + 2 renders) ≈ **$3–6/month**, inside the Pro credit.
- Snapshots: ≈ 1.4 GB each → ~$0.11/month each. Five were created while building this
  (`snap_bqmr6jQmSOpDb6olu9MiFvJ8vRFo` → `snap_XviN8nZ3XOl96YHWJWnVv1IZeo1t` →
  `snap_sGD2s7x7nqNLVHlpKvNkCmpVPmxi` → `snap_bAJfwcdh2pE3LoBCvqYGdASVFwIB` →
  `snap_w3kag80j7aDxYTFz8kXk7FzO3e2b` (active), each built on the previous); keep the active
  one, delete older ones (Vercel dashboard → Sandboxes → Snapshots) once a new one is verified.
- Model calls (quality check, Motion Designer) are billed by Anthropic as before and stay under
  the daily spend cap (the worker uses the same cost-tracked provider).

---

## Operator steps

1. **Set on Vercel** (Production; Preview too only if previews should render):
   - `RENDER_SANDBOX_SNAPSHOT_ID=snap_w3kag80j7aDxYTFz8kXk7FzO3e2b`
   - optional: `RENDER_SANDBOX_VCPUS` (default 8; Hobby max 4), `RENDER_SANDBOX_TIMEOUT_MS`
     (default 2 700 000 = 45 min; Hobby's session max is 45 min), `HEAVY_JOB_MAX_SANDBOXES`
     (default 4; more jobs wait in the queue).
   - Nothing else: the sandbox SDK authenticates with the project's OIDC token automatically;
     the worker receives `DATABASE_URL`, `BLOB_READ_WRITE_TOKEN` and (for AI steps)
     `ANTHROPIC_API_KEY` from the function's env per job. Redeploy.
2. **Check** on the phone: batch-upload 4 clips via /plan/upload, wait ~1–2 min, open each
   editor → captions on. Upload a take → "Getting your captions ready…" shows the job's
   progress and the editor opens with captions; Finish & schedule shows "Rendering your
   graphics… N%" then the check; the export has the graphics (and behind-subject depth).
   Vercel dashboard → Sandboxes: each job's sandbox is `heavy-<jobRunId>` and stops when done.
3. **Rebuild the snapshot** after changing anything the worker runs (apps/worker, packages/*,
   prompts, brand, Remotion templates, dependency versions):
   `SANDBOX_ENV_FILE=<dotenv with VERCEL_TOKEN> pnpm exec tsx scripts/sandbox/create-snapshot.ts`
   (full, ~6 min + upload) or `… --base <current snapshot id>` (incremental). Then
   `pnpm exec tsx scripts/sandbox/verify-offline.ts --snapshot <new id>` (look at
   `.sandbox-build/verify/frames/`) and `scripts/sandbox/verify-dispatch.ts`, set the new id on
   Vercel, redeploy, delete the old snapshot. **The web app and the snapshot must match**: a
   deploy that changes job args/results without a new snapshot can break cloud jobs.
4. `scripts/sandbox/stop.ts --all-running` stops every running sandbox of the project (after an
   interrupted script).

## Limits / known gaps

- **Not exercised end to end against production data.** The sandbox cannot reach a laptop's
  throwaway database, and no throwaway Neon branch was available, so the online DB + Blob path
  was verified in parts: the runner CLI end to end against the throwaway PGlite + local storage
  as a child process with the real face tracker (test), the dispatcher against a fake launcher
  (tests), the real launcher + self-stop against Vercel (verify-dispatch), and every heavy
  computation in the real VM offline (verify-offline). First live run: watch the first Finish.
- Neon's pooled `DATABASE_URL` is used from the VM (Neon allows public connections).
- Snapshot ↔ code version coupling (above). The runner validates args and fails clearly on an
  unknown kind.
- The OIDC token used for self-stop is short-lived; a job that outlives it can't stop itself —
  the poll-time stop and the timeout cover it.
- Captions for an editor that was already open when the transcript landed need a reload.
- One heavy job per video: while an upload's analysis (matte ≈ 3 min for a 60 s take) runs,
  Render/Finish for that video answers "Analyzing your footage for this video right now…".
- `HEAVY_JOB_MAX_SANDBOXES` counts RUNNING JobRuns, not live VMs; a VM orphaned by a crashed
  dispatcher is bounded by its timeout.
- Motion-layer rendering on CPU WebGL is the slow part (≈ 0.4–0.6 s per graphic frame).
