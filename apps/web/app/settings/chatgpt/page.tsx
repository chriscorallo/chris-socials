import { prisma, getConnectorStatus, countVideosNeedingScripts, ymdInTz, addDaysYmd } from "@chris/domain";
import { requireSession } from "../../../lib/session";
import { APP_TZ } from "../../../lib/calendar-data";
import { connectorConfig, connectorEnabled } from "../../../lib/chatgpt-mcp/config";
import { requestOrigin } from "../../../lib/chatgpt-mcp/origin";
import { NavBar } from "../../components/NavBar";
import { BackLink, Badge, Button, PageHeader, PageShell, Panel, QuietLink, SectionHeading } from "../../components/ui";
import { CopyField } from "./CopyField";
import { disconnectChatGpt } from "./actions";

export const dynamic = "force-dynamic";

const CHAT_SENTENCE =
  "Use my Chris Studio connector: get the next 15 videos that need scripts, write them in my voice using everything we planned in this chat, and save them.";

const TOOL_LABEL: Record<string, string> = {
  list_videos_needing_scripts: "Looked at videos needing scripts",
  get_video: "Looked at one video",
  save_scripts: "Saved scripts",
};

function when(d: Date): string {
  return d.toLocaleString("en-US", { timeZone: APP_TZ, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/**
 * More → Connect ChatGPT. Plain-language setup for adding Chris Studio as a custom connector in
 * ChatGPT (per OpenAI's docs, checked 2026-10-17), the status, recent activity and Disconnect.
 * See docs/decisions-pending/chatgpt-connector.md.
 */
export default async function ChatGptConnectPage({ searchParams }: { searchParams: Promise<{ disconnected?: string }> }) {
  const session = await requireSession();
  const { disconnected } = await searchParams;
  const cfg = connectorConfig(await requestOrigin());
  const status = await getConnectorStatus(prisma, session.user!.id!);
  const today = ymdInTz(new Date(), APP_TZ);
  const needing = await countVideosNeedingScripts(prisma, { tz: APP_TZ, fromYmd: addDaysYmd(today, -7) });
  const enabled = connectorEnabled();

  return (
    <>
      <NavBar />
      <PageShell maxWidth={680}>
        <BackLink href="/plan/scripts">Scripts</BackLink>
        <PageHeader
          eyebrow="Settings"
          title="Connect ChatGPT"
          description="Let ChatGPT save scripts straight into the app from the chat where you planned your videos. Free — it uses your ChatGPT, no AI cost here."
        />

        {disconnected && (
          <Panel className="mb-4">
            <p className="text-[15px]">ChatGPT is disconnected. It can't see or save anything until you connect it again.</p>
          </Panel>
        )}
        {!enabled && (
          <Panel className="mb-4 !border-[var(--color-rose-500)]/40">
            <p className="text-[15px] text-[var(--color-rose-400)]">The connector is turned off on the server (CHATGPT_CONNECTOR=off).</p>
          </Panel>
        )}

        <Panel className="mb-5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="eyebrow">Status</p>
              <h2 className="mt-1 text-[18px] font-semibold">{status.connected ? "Connected ✓" : "Not connected yet"}</h2>
            </div>
            {status.connected ? <Badge tone="emerald">Connected</Badge> : <Badge tone="neutral">Off</Badge>}
          </div>
          <p className="mt-2 text-[15px] text-[var(--color-text-muted)]">
            {status.connected
              ? `Last used ${status.lastUsedAt ? when(status.lastUsedAt) : "— not yet"}.`
              : "Follow the steps below once. After that you just ask ChatGPT."}{" "}
            {needing > 0 ? `${needing} planned video${needing === 1 ? "" : "s"} still need a script.` : ""}
          </p>
          {status.connected && (
            <form action={disconnectChatGpt} className="mt-4">
              <Button tone="danger" className="w-full sm:w-auto" pendingLabel="Disconnecting…">
                Disconnect ChatGPT
              </Button>
            </form>
          )}
        </Panel>

        <SectionHeading eyebrow="Before you start" title="Which ChatGPT plan" />
        <Panel className="mb-5">
          <p className="text-[15px] leading-snug">
            Saving from ChatGPT needs <strong>ChatGPT Business</strong> (or Enterprise / Edu), and you need to be the workspace <strong>owner or admin</strong>.
          </p>
          <p className="mt-2 text-[15px] leading-snug text-[var(--color-text-muted)]">
            On Plus or Pro, ChatGPT currently only lets custom connectors <em>read</em>, so it couldn't save scripts. If that's your plan, keep using{" "}
            <QuietLink href="/plan/scripts">Scripts from ChatGPT</QuietLink> (copy, paste, save). It does the same thing, just with one paste.
          </p>
        </Panel>

        <SectionHeading eyebrow="One time · on a computer" title="Add Chris Studio to ChatGPT" />
        <Panel className="mb-5">
          <p className="mb-3 text-[15px] text-[var(--color-text-muted)]">ChatGPT only lets you add connectors on the website (chatgpt.com), not in the iPhone app. After that, it works everywhere.</p>
          <ol className="flex list-decimal flex-col gap-3 pl-5 text-[15px] leading-snug">
            <li>
              Open <strong>chatgpt.com/plugins</strong>. Tap <strong>+</strong>, then <strong>Add custom MCP server</strong>.
              <span className="mt-1 block text-[13px] text-[var(--color-text-muted)]">
                Older menus: Settings → Apps → Advanced settings → turn on Developer mode → Create.
              </span>
            </li>
            <li>
              Name: <strong>Chris Studio</strong>. Description: <em>My video plan and scripts</em>.
            </li>
            <li>
              Paste this as the server URL:
              <div className="mt-2">
                <CopyField value={cfg.resource} label="Connector URL" button="Copy the URL" />
              </div>
            </li>
            <li>
              Authentication: <strong>OAuth</strong>. Leave the client ID and secret empty. Tick &quot;I understand and want to continue&quot;, then <strong>Create</strong>.
            </li>
            <li>
              A Chris Studio window opens. Sign in with your normal email and password and tap <strong>Allow</strong>.
            </li>
            <li>If ChatGPT asks, tap <strong>Install</strong> or <strong>Connect</strong>. This page will say <strong>Connected ✓</strong>.</li>
          </ol>
        </Panel>

        <SectionHeading eyebrow="Every time" title="What to type in your planning chat" />
        <Panel className="mb-5">
          <p className="mb-3 text-[15px] text-[var(--color-text-muted)]">
            Open the chat where you planned your videos. Type <strong>@</strong> and pick <strong>Chris Studio</strong> (or turn it on under the <strong>+</strong> menu), then send:
          </p>
          <CopyField value={CHAT_SENTENCE} label="Sentence to send" button="Copy the sentence" multiline />
          <ul className="mt-4 flex list-disc flex-col gap-2 pl-5 text-[14px] leading-snug text-[var(--color-text-muted)]">
            <li>ChatGPT asks before it saves. Tap <strong>Confirm</strong> (you can let it remember for that chat).</li>
            <li>Scripts show up in Plan and in the teleprompter right away. Nothing is ever overwritten: a video that already has a script is skipped unless you tell ChatGPT to replace it, and the old version is kept.</li>
            <li>Numbers ChatGPT marks [CHECK] still get fact-checked before anything is posted.</li>
            <li>To keep going, say &quot;do the next 15&quot;.</li>
          </ul>
        </Panel>

        <SectionHeading eyebrow="Activity" title="Recent ChatGPT activity" />
        <Panel className="mb-8">
          {status.recent.length === 0 ? (
            <p className="text-[15px] text-[var(--color-text-muted)]">Nothing yet.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-[var(--color-border)]">
              {status.recent.map((r, i) => (
                <li key={i} className="flex items-start justify-between gap-3 py-2 text-[15px]">
                  <span className="min-w-0">
                    {TOOL_LABEL[r.tool] ?? r.tool}
                    {r.tool === "save_scripts" && r.saved != null ? ` · ${r.saved} saved` : ""}
                    {r.tool === "list_videos_needing_scripts" && r.videos != null ? ` · ${r.videos} videos` : ""}
                    {!r.ok && <span className="text-[var(--color-rose-400)]"> · {r.message ?? "failed"}</span>}
                  </span>
                  <span className="shrink-0 text-[13px] text-[var(--color-text-muted)]">{when(r.at)}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </PageShell>
    </>
  );
}
