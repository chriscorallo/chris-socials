// Golden-set harness: freeze real takes as fixtures (docs/PREMIUM_EDITOR_HANDOFF.md §3.1).
//
//   pnpm golden:pull <base-url> "<contentItemId or title words>=<slug>[@<handEditPlanId>]" …
//
// Signs in with the app's own login (SEED_USER_EMAIL / SEED_USER_PASSWORD from the environment
// or .env — never printed), calls POST /api/golden per item, writes fixtures/golden/<slug>.json.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = join(ROOT, "fixtures/golden");
const [base, ...specs] = process.argv.slice(2);
const listOnly = specs.includes("--list");
if (!base || (specs.length === 0 && !listOnly)) {
  console.error("usage: pnpm golden:pull <base-url> --list | \"<contentItemId or title words>=<slug>[@<handEditPlanId>]\" …");
  process.exit(2);
}
const email = process.env.SEED_USER_EMAIL;
const password = process.env.SEED_USER_PASSWORD;
if (!email || !password) {
  console.error("SEED_USER_EMAIL / SEED_USER_PASSWORD are not set (environment or .env).");
  process.exit(2);
}

const jar = new Map();
const keep = (res) => {
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [pair] = c.split(";");
    const i = pair.indexOf("=");
    jar.set(pair.slice(0, i).trim(), pair.slice(i + 1));
  }
};
const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");

async function retry(fn, label) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= 4) throw err;
      console.warn(`${label}: ${err.message} — retrying (${i})`);
      await new Promise((r) => setTimeout(r, 2000 * i));
    }
  }
}

const csrfRes = await retry(() => fetch(`${base}/api/auth/csrf`), "csrf");
keep(csrfRes);
const { csrfToken } = await csrfRes.json();
const login = await retry(
  () =>
    fetch(`${base}/api/auth/callback/credentials`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookie() },
      body: new URLSearchParams({ csrfToken, email, password, callbackUrl: `${base}/` }),
    }),
  "login",
);
keep(login);
if (![...jar.keys()].some((k) => k.endsWith("authjs.session-token"))) {
  console.error(`Sign-in failed (HTTP ${login.status}). Check the credentials in .env for ${base}.`);
  process.exit(1);
}

if (listOnly) {
  const res = await retry(() => fetch(`${base}/api/golden`, { headers: { cookie: cookie() } }), "list");
  const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) {
    console.error(body.error ?? `HTTP ${res.status}`);
    process.exit(1);
  }
  for (const i of body.items) {
    console.log(
      `${i.id}  ${String(i.title).slice(0, 48).padEnd(48)}  ${i.takes} take${i.takes === 1 ? " " : "s"}  ${i.durationS ? `${Math.round(i.durationS)}s`.padStart(5) : "   —"}  ${String(i.words).padStart(4)} words  ${i.editorPlan ? "editor" : "      "}  ${i.handEdit ? "hand-edit" : ""}`,
    );
  }
  process.exit(0);
}

mkdirSync(OUT, { recursive: true });
let failed = 0;
for (const spec of specs.filter((x) => !x.startsWith("--"))) {
  const m = spec.match(/^(.+)=([a-z0-9-]+)(?:@(.+))?$/);
  if (!m) {
    console.error(`skip "${spec}": expected <contentItemId>=<slug>[@<handEditPlanId>]`);
    failed++;
    continue;
  }
  const [, contentItemId, slug, handEditPlanId] = m;
  const res = await retry(
    () =>
      fetch(`${base}/api/golden`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: cookie() },
        body: JSON.stringify({ contentItemId, slug, handEditPlanId: handEditPlanId ?? null }),
      }),
    slug,
  );
  const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) {
    console.error(`${slug}: ${body.error ?? `HTTP ${res.status}`}`);
    failed++;
    continue;
  }
  writeFileSync(join(OUT, `${slug}.json`), JSON.stringify(body, null, 1) + "\n");
  console.log(
    `${slug} ← "${body.title}" (${body.contentItemId}): ${body.take.words.length} words, ${body.take.durationSeconds.toFixed(1)} s, editor plan ${body.editorPlan ? "yes" : "no"}, hand edit ${body.handEdit ? "yes" : "no"}`,
  );
}
process.exit(failed ? 1 : 0);
