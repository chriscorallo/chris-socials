import { prisma, listEditorHealthReports } from "@chris/domain";
import { requireSession } from "../../../lib/session";
import { NavBar } from "../../components/NavBar";
import { PageShell, PageHeader, Panel } from "../../components/ui";

// Editor diagnostics (docs/decisions-pending/editor-rebuild.md): the editor's health reports from
// Chris's own phone — how fast it opened, how smooth playback was, stalls, errors — so preview
// problems are read off the real device instead of guessed. Newest first; the latest checkpoint
// per editor session plus every "Something glitched" report.

export const dynamic = "force-dynamic";

type Totals = Record<string, number | null>;
type Report = {
  totals?: Totals;
  marks?: Record<string, number>;
  edit?: Record<string, unknown>;
  device?: Record<string, unknown>;
  engineInfo?: Record<string, unknown>;
  fps?: number[];
  errors?: string[];
  note?: string;
};

function shortDevice(ua: string | null | undefined): string {
  if (!ua) return "unknown device";
  const ios = /iPhone OS (\d+)_(\d+)/.exec(ua);
  if (ios) return `iPhone · iOS ${ios[1]}.${ios[2]}${/CriOS/.test(ua) ? " · Chrome" : " · Safari"}`;
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android";
  if (/Mac OS X/.test(ua)) return /Chrome\//.test(ua) ? "Mac · Chrome" : "Mac · Safari";
  return ua.slice(0, 40);
}

const ms = (v: number | null | undefined) => (v === undefined || v === null ? "—" : v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`);

function verdict(t: Totals | undefined): { tone: string; label: string } {
  if (!t) return { tone: "warn", label: "No data" };
  const dropped = t.droppedPct ?? 0;
  const bigStalls = (t.stalls1000 ?? 0) + (t.videoErrors ?? 0);
  if ((t.playS ?? 0) < 2) return { tone: "warn", label: "Barely played" };
  if (bigStalls > 0 || dropped > 25) return { tone: "bad", label: "Rough" };
  if (dropped > 8 || (t.stalls250 ?? 0) > 2) return { tone: "warn", label: "Some hitches" };
  return { tone: "good", label: "Smooth" };
}

export default async function DiagnosticsPage() {
  await requireSession();
  const rows = await listEditorHealthReports(prisma, 60);
  return (
    <>
      <NavBar />
      <PageShell maxWidth={760}>
        <PageHeader
          eyebrow="Settings"
          title="Editor diagnostics"
          description="How the editor actually ran on your devices — opening speed, smoothness, stalls and errors. Tap “Something glitched” in the editor right after a problem and it shows up here with the last 20 seconds of detail."
        />
        {rows.length === 0 ? (
          <Panel>
            <p className="text-[15px] text-[var(--color-text-muted)]">No editor sessions recorded yet. Open a video in the editor and play it — a report lands here after about 30 seconds of use, and whenever you leave the editor.</p>
          </Panel>
        ) : (
          <div className="flex flex-col gap-3">
            {rows.map((r) => {
              const rep = (r.report ?? {}) as Report;
              const t = rep.totals;
              const v = verdict(t);
              const dot = v.tone === "good" ? "bg-[var(--color-emerald-400)]" : v.tone === "bad" ? "bg-[var(--color-rose-400)]" : "bg-[var(--color-gold-400)]";
              const fps = rep.fps?.length ? Math.round(rep.fps.reduce((a, b) => a + b, 0) / rep.fps.length) : null;
              return (
                <Panel key={r.id}>
                  <div className="flex items-start gap-3" data-testid="diag-row">
                    <span className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${dot}`} />
                    <div className="min-w-0 flex-1">
                      <p className="text-[15px] font-semibold">
                        {r.kind === "glitch" ? "“Something glitched” · " : ""}
                        {v.label} · {r.engine ?? "?"} engine
                      </p>
                      <p className="mt-0.5 text-[13px] text-[var(--color-text-muted)]">
                        {r.createdAt.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })} · {shortDevice(r.userAgent)}
                        {rep.edit ? ` · ${rep.edit.clips ?? "?"} clips, ${rep.edit.visuals ?? 0} graphics` : ""}
                      </p>
                      <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[13px] sm:grid-cols-4">
                        <div>
                          <dt className="text-[var(--color-text-faint)]">First picture</dt>
                          <dd>{ms(rep.marks?.firstFrame)}</dd>
                        </div>
                        <div>
                          <dt className="text-[var(--color-text-faint)]">Ready to tap</dt>
                          <dd>{ms(rep.marks?.interactive)}</dd>
                        </div>
                        <div>
                          <dt className="text-[var(--color-text-faint)]">Played</dt>
                          <dd>{t?.playS ?? 0} s{fps !== null ? ` · ${fps} fps` : ""}</dd>
                        </div>
                        <div>
                          <dt className="text-[var(--color-text-faint)]">Dropped frames</dt>
                          <dd>{t ? `${t.dropped ?? 0} (${t.droppedPct ?? 0}%)` : "—"}</dd>
                        </div>
                        <div>
                          <dt className="text-[var(--color-text-faint)]">Freezes ≥ ¼ s</dt>
                          <dd>{t?.stalls250 ?? 0} (longest {ms(t?.maxStallMs)})</dd>
                        </div>
                        <div>
                          <dt className="text-[var(--color-text-faint)]">Scrub delay p95</dt>
                          <dd>{ms(t?.scrubP95)}</dd>
                        </div>
                        <div>
                          <dt className="text-[var(--color-text-faint)]">Video waits / errors</dt>
                          <dd>
                            {t?.videoWaiting ?? 0} / {t?.videoErrors ?? 0}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-[var(--color-text-faint)]">Script errors</dt>
                          <dd>{t?.errors ?? 0}</dd>
                        </div>
                      </dl>
                      <details className="mt-2 text-[12px]">
                        <summary className="cursor-pointer text-[var(--color-text-muted)]">Details</summary>
                        <pre className="mt-2 max-h-[420px] overflow-auto whitespace-pre-wrap break-all rounded-lg bg-black/30 p-2 text-[11px] leading-snug">{JSON.stringify(r.report, null, 1)}</pre>
                      </details>
                    </div>
                  </div>
                </Panel>
              );
            })}
          </div>
        )}
      </PageShell>
    </>
  );
}
