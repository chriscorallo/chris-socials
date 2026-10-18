import { redirect } from "next/navigation";
import { prisma, validateAuthorizeRequest, SCOPE_READ, SCOPE_WRITE, SCOPE_OFFLINE, type AuthorizeParams } from "@chris/domain";
import { auth } from "../../../auth";
import { connectorConfig, connectorEnabled } from "../../../lib/chatgpt-mcp/config";
import { requestOrigin } from "../../../lib/chatgpt-mcp/origin";
import { Button, Panel } from "../../components/ui";
import { allowChatGpt, denyChatGpt } from "./actions";

export const dynamic = "force-dynamic";

const FIELDS = ["response_type", "client_id", "redirect_uri", "code_challenge", "code_challenge_method", "state", "scope", "resource"] as const;

const SCOPE_TEXT: Record<string, string> = {
  [SCOPE_READ]: "See your planned videos (dates, titles, hooks, notes) and your script style",
  [SCOPE_WRITE]: "Save scripts onto your planned videos — always as a new version, never deleting or overwriting anything",
  [SCOPE_OFFLINE]: "Stay connected until you disconnect it in Settings",
};

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <>
      <div className="ambient-field" aria-hidden />
      <main
        className="relative z-10 flex min-h-dvh items-center justify-center px-4"
        style={{ paddingTop: "calc(var(--safe-top) + 1.5rem)", paddingBottom: "calc(var(--safe-bottom) + 1.5rem)" }}
      >
        <div className="w-full max-w-md">{children}</div>
      </main>
    </>
  );
}

/**
 * OAuth consent ("Allow ChatGPT to read your plan and save scripts?"). ChatGPT opens this in a
 * popup; Chris signs in with his normal email/password (the login page brings him back here)
 * and taps Allow. Nothing is granted by visiting the page — only the Allow server action
 * creates a code, after re-validating every parameter. See docs/decisions-pending/chatgpt-connector.md.
 */
export default async function AuthorizePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const params: AuthorizeParams = {};
  for (const f of FIELDS) {
    const v = sp[f];
    params[f] = typeof v === "string" ? v : null;
  }

  if (!connectorEnabled()) {
    return (
      <Shell>
        <Panel>
          <h1 className="text-xl font-semibold">ChatGPT connector is off</h1>
          <p className="mt-2 text-sm text-[var(--color-text-muted)]">It's turned off on the server (CHATGPT_CONNECTOR=off).</p>
        </Panel>
      </Shell>
    );
  }

  const cfg = connectorConfig(await requestOrigin());
  const v = await validateAuthorizeRequest(prisma, params, cfg);
  if (!v.ok && v.redirect) redirect(v.redirect);
  if (!v.ok) {
    return (
      <Shell>
        <Panel>
          <p className="eyebrow mb-1">Chris Studio</p>
          <h1 className="text-xl font-semibold">This connection link isn't valid</h1>
          <p className="mt-2 text-[15px] text-[var(--color-text-muted)]">{v.description}</p>
          <p className="mt-3 text-[15px] text-[var(--color-text-muted)]">Go back to ChatGPT and add the Chris Studio connector again.</p>
        </Panel>
      </Shell>
    );
  }

  const session = await auth();
  if (!session?.user) {
    const qs = new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => !!e[1])).toString();
    redirect(`/login?next=${encodeURIComponent(`/oauth/authorize?${qs}`)}`);
  }

  const r = v.request;
  const redirectHost = new URL(r.redirectUri).host;
  const isChatGpt = redirectHost === "chatgpt.com";

  return (
    <Shell>
      <Panel>
        <div
          aria-hidden
          className="mb-4 h-9 w-9 rounded-full"
          style={{ background: "linear-gradient(135deg, var(--color-gold-400), var(--color-violet-400))" }}
        />
        <p className="eyebrow mb-1">Chris Studio</p>
        <h1 className="text-[24px] font-semibold leading-tight tracking-tight">
          Allow {isChatGpt ? "ChatGPT" : r.client.name} to read your plan and save scripts?
        </h1>
        <p className="mt-2 text-[15px] text-[var(--color-text-muted)]">
          Signed in as {session.user.email}. {isChatGpt ? "ChatGPT" : "This app"} will be able to:
        </p>
        <ul className="mt-3 flex flex-col gap-2 text-[15px]">
          {r.scopes.map((s) => (
            <li key={s} className="flex gap-2">
              <span aria-hidden className="text-[var(--color-emerald-400)]">✓</span>
              <span>{SCOPE_TEXT[s] ?? s}</span>
            </li>
          ))}
          <li className="flex gap-2 text-[var(--color-text-muted)]">
            <span aria-hidden>✕</span>
            <span>It can't post, delete, film, change your brand or see anything else.</span>
          </li>
        </ul>
        {!isChatGpt && (
          <p className="mt-3 rounded-lg border border-[var(--color-rose-500)]/40 p-3 text-sm text-[var(--color-rose-400)]">
            This request isn't from ChatGPT (it returns to {redirectHost}). Only allow it if you started it yourself.
          </p>
        )}
        <p className="mt-3 text-[13px] text-[var(--color-text-muted)]">
          App: {r.client.name} · returns to {redirectHost}. You can disconnect any time in More → Connect ChatGPT.
        </p>

        <div className="mt-5 flex flex-col gap-3">
          <form action={allowChatGpt}>
            {FIELDS.map((f) => (params[f] ? <input key={f} type="hidden" name={f} value={params[f]!} /> : null))}
            <Button tone="primary" className="w-full !min-h-[50px] text-[16px]" pendingLabel="Connecting…">
              Allow
            </Button>
          </form>
          <form action={denyChatGpt}>
            {FIELDS.map((f) => (params[f] ? <input key={f} type="hidden" name={f} value={params[f]!} /> : null))}
            <Button className="w-full !min-h-[46px]">Cancel</Button>
          </form>
        </div>
      </Panel>
    </Shell>
  );
}
