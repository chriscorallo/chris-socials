import { prisma, listScriptImportTargets, getReferenceStyleProfile, getOwnSpeechProfile, ymdInTz, addDaysYmd } from "@chris/domain";
import { PRE_FILM_STATES } from "@chris/domain/plan-import";
import { ownPaceWpm, scriptStyleFrom } from "@chris/domain/script-import";
import { getVoiceSamplesText } from "@chris/agents";
import { requireSession } from "../../../lib/session";
import { APP_TZ } from "../../../lib/calendar-data";
import { NavBar } from "../../components/NavBar";
import { BackLink, PageHeader, PageShell, QuietLink } from "../../components/ui";
import { ScriptsClient, type ClientTarget } from "./ScriptsClient";

export const maxDuration = 120;

/**
 * Scripts from ChatGPT — free (Chris's ChatGPT subscription, no API, no model call here):
 * copy a prompt → paste ChatGPT's answer → check the matches → save. Every script becomes a new
 * script version on its planned video. See docs/decisions-pending/chatgpt-scripts.md.
 */
export default async function PlanScriptsPage() {
  await requireSession();
  const today = ymdInTz(new Date(), APP_TZ);
  const targets = await listScriptImportTargets(prisma, { tz: APP_TZ });
  const refs = await getReferenceStyleProfile(prisma, { group: "MAIN" });
  const own = await getOwnSpeechProfile(prisma);
  const style = scriptStyleFrom(refs);
  // "At your pace": Chris's own measured takes when there are enough, else the target pace.
  const ownWpm = ownPaceWpm(own);
  const pace = ownWpm ? { wpm: ownWpm, label: "at your pace" } : { wpm: style.wpm, label: `at ${style.wpm} words a minute` };
  const from = addDaysYmd(today, -7);

  const clientTargets: ClientTarget[] = targets.map((t) => ({
    id: t.id,
    code: t.code,
    title: t.title,
    ymd: t.ymd,
    time: t.time,
    hook: t.hook,
    notes: t.notes,
    scriptCount: t.scriptCount,
    latestScript: t.latestScript,
    needsScript: t.scriptCount === 0 && PRE_FILM_STATES.has(t.state) && t.ymd >= from,
  }));

  return (
    <>
      <NavBar />
      <PageShell maxWidth={680}>
        <BackLink href="/plan">Plan</BackLink>
        <PageHeader eyebrow="Plan" title="Scripts from ChatGPT" description="Free — it uses your ChatGPT. Copy the prompt, paste ChatGPT's answer back, check, save." />
        <p className="mb-4 text-[14px] text-[var(--color-text-muted)]">
          On ChatGPT Business? <QuietLink href="/settings/chatgpt">Connect ChatGPT</QuietLink> and it can save scripts itself, no pasting.
        </p>
        <ScriptsClient today={today} targets={clientTargets} style={style} pace={pace} voiceSamples={getVoiceSamplesText()} />
      </PageShell>
    </>
  );
}
