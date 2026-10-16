import { prisma, listPlatformConnectionSummaries, listRecentJobRuns, isEnabled } from "@chris/domain";
import { missingOAuthEnv, OAUTH_SCOPES, type Platform } from "@chris/platforms";
import { requireSession } from "../../../lib/session";
import { NavBar } from "../../components/NavBar";
import { PageShell, PageHeader, Panel, SectionHeading, Badge, Button, EmptyState } from "../../components/ui";
import { disconnectPlatform, setScheduledAutoPublish } from "./actions";

const LABELS: Record<Platform, string> = { INSTAGRAM: "Instagram Reels", TIKTOK: "TikTok", YOUTUBE: "YouTube Shorts" };

const NOTES: Record<Platform, string> = {
  INSTAGRAM:
    "Instagram API with Instagram Login (professional account). Long-lived token (~60 days), refreshed automatically while valid.",
  YOUTUBE:
    "Google OAuth with offline access — the ~1h access token is refreshed automatically. Uploads from an unaudited API project may be locked private.",
  TIKTOK:
    "Login Kit + Content Posting API. Until TikTok audits this app, videos go to your TikTok inbox to finish in the app (TIKTOK_POST_MODE=INBOX).",
};

function formatDate(date: Date | null): string {
  if (!date) return "—";
  return date.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}

function expiryText(expiresAt: Date | null, hasRefresh: boolean, now: Date): string {
  if (!expiresAt) return "No expiry recorded";
  const ms = expiresAt.getTime() - now.getTime();
  if (ms <= 0) return hasRefresh ? "Access token expired — refreshes on next use" : "Expired";
  const hours = ms / 3_600_000;
  const rel = hours < 48 ? `${Math.round(hours)}h` : `${Math.round(hours / 24)}d`;
  return `Expires in ${rel}${hasRefresh ? " (auto-refresh)" : ""}`;
}

export default async function ConnectionsPage({
  searchParams,
}: {
  searchParams: Promise<{ connected?: string; disconnected?: string; oauthError?: string }>;
}) {
  await requireSession();
  const { connected, disconnected, oauthError } = await searchParams;
  const now = new Date();

  const connections = await listPlatformConnectionSummaries(prisma, now);
  const scheduledAuto = await isEnabled(prisma, "publishing.scheduled_auto");
  const publishRuns = await listRecentJobRuns(prisma, { kind: "scheduled-publish", limit: 5 });
  const snapshotRuns = await listRecentJobRuns(prisma, { kind: "snapshot-sweep", limit: 5 });
  const runs = [...publishRuns, ...snapshotRuns].sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime()).slice(0, 8);

  return (
    <>
      <NavBar />
      <PageShell>
        <PageHeader
          eyebrow="Settings"
          title="Connections"
          description="Connect each platform once; tokens are stored encrypted and refreshed automatically. Publishing, verification, metrics and comments all use these connections."
        />

        {oauthError && (
          <Panel className="mb-5 !border-[var(--color-rose-500)]/40">
            <p className="text-sm text-[var(--color-rose-400)]">{oauthError}</p>
          </Panel>
        )}
        {(connected || disconnected) && (
          <Panel className="mb-5">
            <p className="text-sm text-[var(--color-text-muted)]">
              {connected ? `${connected} connected.` : `${disconnected} disconnected.`}
            </p>
          </Panel>
        )}

        <div className="mb-5 flex flex-col gap-4">
          {connections.map((c) => {
            const missing = missingOAuthEnv(c.platform, process.env);
            const granted = new Set(c.scopes);
            const missingScopes = c.connected && c.scopes.length > 0 ? OAUTH_SCOPES[c.platform].filter((s) => !granted.has(s)) : [];
            return (
              <Panel key={c.platform}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="eyebrow">{c.platform}</p>
                    <h2 className="mt-1 text-[17px] font-semibold text-[var(--color-text)]">{LABELS[c.platform]}</h2>
                  </div>
                  {c.connected ? (
                    c.expired ? <Badge tone="rose">Reconnect needed</Badge> : <Badge tone="emerald">Connected</Badge>
                  ) : (
                    <Badge tone="neutral">Not connected</Badge>
                  )}
                </div>

                <p className="mt-2 text-sm text-[var(--color-text-muted)]">{NOTES[c.platform]}</p>

                {c.connected && (
                  <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
                    <div>
                      <dt className="field-label">Account</dt>
                      <dd>{c.accountName ? `${c.accountName} (${c.accountId})` : c.accountId}</dd>
                    </div>
                    <div>
                      <dt className="field-label">Token</dt>
                      <dd>{expiryText(c.expiresAt, c.hasRefreshToken, now)}</dd>
                    </div>
                    <div className="sm:col-span-2">
                      <dt className="field-label">Scopes</dt>
                      <dd className="break-words text-[var(--color-text-muted)]">{c.scopes.length > 0 ? c.scopes.join(", ") : "—"}</dd>
                    </div>
                    <div>
                      <dt className="field-label">Last updated</dt>
                      <dd>{formatDate(c.updatedAt)}</dd>
                    </div>
                  </dl>
                )}

                {missingScopes.length > 0 && (
                  <p className="mt-2 text-sm text-[var(--color-rose-400)]">
                    Missing permissions: {missingScopes.join(", ")} — reconnect and approve all requested access.
                  </p>
                )}
                {missing.length > 0 && (
                  <p className="mt-2 text-sm text-[var(--color-rose-400)]">Not configured on the server: set {missing.join(", ")}.</p>
                )}

                <div className="mt-4 flex flex-wrap gap-2">
                  {missing.length === 0 && (
                    // A plain link, not a client-side Link: this leaves the app for the
                    // provider's consent screen.
                    <a href={`/api/oauth/${c.platform.toLowerCase()}/start`} className={`btn ${c.connected ? "btn-ghost" : "btn-primary"}`}>
                      {c.connected ? "Reconnect" : "Connect"}
                    </a>
                  )}
                  {c.connected && (
                    <form action={disconnectPlatform}>
                      <input type="hidden" name="platform" value={c.platform} />
                      <Button tone="danger">Disconnect</Button>
                    </form>
                  )}
                </div>
              </Panel>
            );
          })}
        </div>

        <Panel className="mb-5">
          <SectionHeading eyebrow="Automation" title="Publish at the scheduled time" />
          <p className="text-sm text-[var(--color-text-muted)]">
            When on, items you&apos;ve scheduled on the Calendar publish automatically when their time arrives (checked by
            the scheduled cron). Items more than 24h overdue are reported as missed, never posted late. Off by default.
          </p>
          <form action={setScheduledAutoPublish} className="mt-3">
            <input type="hidden" name="enabled" value={scheduledAuto ? "false" : "true"} />
            <div className="flex items-center gap-3">
              {scheduledAuto ? <Badge tone="emerald">On</Badge> : <Badge tone="neutral">Off</Badge>}
              <Button tone={scheduledAuto ? "ghost" : "primary"}>{scheduledAuto ? "Turn off" : "Turn on"}</Button>
            </div>
          </form>
        </Panel>

        <Panel>
          <SectionHeading eyebrow="Background jobs" title="Recent runs" />
          {runs.length === 0 ? (
            <EmptyState>No scheduled-publish or snapshot runs recorded yet.</EmptyState>
          ) : (
            <ul className="flex flex-col gap-2 text-sm">
              {runs.map((run) => (
                <li key={run.id} className="flex flex-wrap items-center gap-2">
                  <Badge tone={run.status === "SUCCEEDED" ? "emerald" : run.status === "FAILED" ? "rose" : "gold"}>{run.status}</Badge>
                  <span>{run.kind}</span>
                  <span className="text-[var(--color-text-muted)]">{formatDate(run.startedAt)}</span>
                  {run.error && <span className="text-[var(--color-rose-400)]">{run.error}</span>}
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </PageShell>
    </>
  );
}
