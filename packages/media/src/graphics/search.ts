import { GRAPHIC_CATEGORIES, GRAPHIC_COMPONENT_SPECS, type GraphicCategory, type GraphicComponent } from "./contract";
import { GRAPHIC_PRESETS, presetBase, type GraphicPreset } from "./presets";

/**
 * Library search — deterministic, fuzzy, synonym-aware ranking over preset names, tags,
 * descriptions, categories and base components. "paycheck" finds income graphics, "vs"
 * finds comparisons, "compund" (typo) finds the compound growth curve.
 */

/** Synonym groups (every word maps to its whole group). */
const SYNONYM_GROUPS: string[][] = [
  ["income", "salary", "paycheck", "pay", "earnings", "earn", "wage", "wages", "revenue", "paid"],
  ["debt", "loan", "loans", "owe", "payoff", "balance", "credit"],
  ["vs", "versus", "compare", "comparison", "against", "difference", "or"],
  ["chart", "graph", "plot", "data"],
  ["growth", "grow", "compound", "compounding", "increase", "up", "exponential"],
  ["save", "savings", "saving", "saved", "emergency"],
  ["invest", "investing", "investment", "stocks", "portfolio", "index", "market"],
  ["house", "home", "rent", "mortgage", "housing"],
  ["budget", "spending", "expenses", "spend", "costs", "bills"],
  ["month", "monthly", "months", "calendar", "year", "yearly", "annual"],
  ["list", "checklist", "tips", "rules", "bullets", "points"],
  ["steps", "how", "plan", "process", "roadmap", "timeline", "milestones"],
  ["percent", "percentage", "rate", "%", "share", "ratio"],
  ["text", "title", "words", "kinetic", "typography", "quote", "statement"],
  ["follow", "subscribe", "cta", "save", "share", "comment"],
  ["arrow", "pointer", "annotate", "annotation", "circle", "highlight", "underline"],
  ["money", "cash", "dollars", "$", "bucks"],
  ["business", "owner", "entrepreneur", "founder", "self-employed", "freelance", "freelancer"],
  ["job", "employee", "career", "work", "9-5"],
  ["number", "stat", "stats", "big", "counter", "figure"],
  ["3d", "object", "objects", "three"],
  ["transition", "wipe", "cut", "flash", "slam"],
  ["people", "person", "entities", "columns"],
  ["negative", "loss", "minus", "red", "down"],
  ["table", "rows", "grid", "spreadsheet"],
  ["map", "city", "cities", "location", "places", "state"],
  ["taxes", "tax", "irs"],
  // ---- Library 2 (platform words find the generic "-style" graphics; none shows a brand) ----
  ["search", "google", "googled", "googling", "searched", "query", "autocomplete", "lookup", "bing"],
  ["post", "tweet", "tweets", "tweeted", "x", "thread", "posted", "status", "threads"],
  ["text", "texted", "texting", "message", "messages", "imessage", "sms", "dm", "dms", "chat", "conversation", "whatsapp"],
  ["notification", "notifications", "push", "alert", "ping", "banner", "buzz"],
  ["news", "breaking", "headline", "headlines", "newspaper", "press", "article", "ticker", "journalist"],
  ["map", "route", "directions", "location", "pin", "navigate", "gps", "eta", "maps"],
  ["subscribe", "subscribed", "subscribers", "follow", "followers", "follower", "sub", "subs"],
  ["viral", "trending", "trend", "trends", "popular", "hashtag", "hashtags", "fyp", "blowing"],
  ["youtube", "yt", "video", "views", "thumbnail", "channel", "youtuber"],
  ["tiktok", "reel", "reels", "shorts", "fyp", "creator"],
  ["instagram", "ig", "insta", "story", "stories", "sticker"],
  ["reddit", "forum", "upvote", "upvotes", "subreddit", "redditor"],
  ["linkedin", "professional", "network", "networking", "recruiter"],
  ["call", "calling", "facetime", "ringing", "caller", "phone"],
  ["email", "mail", "inbox", "gmail", "emails", "outlook"],
  ["apple", "keynote", "iphone", "ios", "stage", "launch"],
  ["meme", "funny", "joke", "lol", "pov", "relatable", "caption"],
  ["quiz", "question", "trivia", "poll", "vote", "guess", "polls"],
  ["countdown", "timer", "clock", "seconds", "stopwatch", "alarm"],
  ["stamp", "myth", "fact", "true", "false", "verdict", "wrong", "right", "busted"],
  ["glitch", "effect", "effects", "fx", "vhs", "retro", "film", "burn", "leak", "overlay"],
  ["weather", "temperature", "forecast", "sunny", "rain", "degrees"],
  ["pay", "payment", "payments", "venmo", "paid", "sent", "received", "transfer", "zelle", "cashapp"],
  ["uber", "ride", "lyft", "driver", "taxi", "rideshare"],
  ["delivery", "package", "shipping", "tracking", "order", "amazon", "doordash"],
  ["flight", "plane", "boarding", "airport", "travel", "trip", "ticket", "vacation"],
  ["gym", "workout", "sets", "reps", "lift", "lifting", "fitness", "exercise"],
  ["habit", "habits", "streak", "tracker", "daily", "consistency", "routine"],
  ["podcast", "episode", "audio", "waveform", "spotify", "music", "song", "playlist"],
  ["movie", "netflix", "show", "series", "tv", "trailer", "documentary"],
  ["heart", "hearts", "like", "likes", "love", "reaction", "reactions", "emoji", "emojis"],
  ["app", "apps", "mobile", "screen", "homescreen", "android"],
  ["wiki", "wikipedia", "definition", "define", "meaning", "encyclopedia"],
  ["browser", "website", "web", "site", "url", "link", "404", "cookie", "cookies", "chrome", "safari"],
  ["calendar", "date", "day", "days", "schedule", "invite", "meeting", "deadline"],
  // Signature (series & brand)
  ["series", "episode", "ep", "opener", "intro", "ident", "sting", "stinger", "bumper", "outro", "brand", "signature"],
  ["poison", "dilemma", "choice", "choose", "either", "rather", "pick"],
  ["math", "calculator", "tape", "calculate", "add", "adds", "total"],
  ["butterfly", "fork", "decision", "decades", "years later", "future"],
  ["broke", "character", "fictional", "afford", "sitcom", "superhero", "verdict"],
  ["mystery", "incentive", "sense", "why", "hidden", "casino", "popcorn"],
  ["alive", "receipt", "cost of", "dating", "single", "friendships", "life"],
  ["shockwave", "impact", "boom", "hit", "reveal", "punch"],
  ["money rain", "cash", "raining", "jackpot", "bills", "coins"],
  ["dust", "sparkle", "sparkles", "particles", "glitter", "shimmer"],
  ["car", "vehicle", "auto", "lease", "wallet", "diamond", "bank"],
];

const SYN = new Map<string, Set<string>>();
for (const g of SYNONYM_GROUPS) for (const w of g) {
  const set = SYN.get(w) ?? new Set<string>();
  for (const x of g) if (x !== w) set.add(x);
  SYN.set(w, set);
}

export function synonymsOf(word: string): string[] {
  return [...(SYN.get(word.toLowerCase()) ?? [])];
}

export function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[“”"'’()]/g, " ")
    .split(/[^a-z0-9%$+]+/)
    .filter((t) => t.length > 0);
}

/** Damerau–Levenshtein distance capped at `max` (early exit). */
export function editDistance(a: string, b: string, max = 2): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    let rowMin = Infinity;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, d[i - 2]![j - 2]! + 1);
      d[i]![j] = v;
      rowMin = Math.min(rowMin, v);
    }
    if (rowMin > max) return max + 1;
  }
  return d[a.length]![b.length]!;
}

function fuzzyEq(q: string, w: string): boolean {
  if (q.length < 4 || w.length < 4) return false;
  return editDistance(q, w, q.length >= 7 ? 2 : 1) <= (q.length >= 7 ? 2 : 1);
}

interface Indexed {
  preset: GraphicPreset;
  name: string[];
  nameText: string;
  tags: string[];
  tagWords: string[];
  desc: string[];
  meta: string[];
}

let INDEX: Indexed[] | null = null;
function index(): Indexed[] {
  if (INDEX) return INDEX;
  INDEX = GRAPHIC_PRESETS.map((p) => {
    const base = presetBase(p);
    const spec = GRAPHIC_COMPONENT_SPECS[base as GraphicComponent];
    const cat = GRAPHIC_CATEGORIES.find((c) => c.id === p.category)?.label ?? "";
    return {
      preset: p,
      name: tokenize(p.name),
      nameText: p.name.toLowerCase(),
      tags: p.tags.map((t) => t.toLowerCase()),
      tagWords: p.tags.flatMap(tokenize),
      desc: tokenize(p.description),
      meta: tokenize(`${cat} ${spec ? spec.label : base.replace(/_/g, " ")} ${base.replace(/_/g, " ")}`),
    };
  });
  return INDEX;
}

export interface SearchOptions {
  category?: GraphicCategory | null;
  favorites?: ReadonlySet<string>;
  recents?: readonly string[];
  limit?: number;
}

export interface SearchHit {
  preset: GraphicPreset;
  score: number;
}

function tokenScore(q: string, it: Indexed): number {
  let s = 0;
  if (it.name.includes(q)) s = Math.max(s, 30);
  else if (it.name.some((w) => w.startsWith(q) && q.length >= 2)) s = Math.max(s, 22);
  if (it.tags.includes(q) || it.tagWords.includes(q)) s = Math.max(s, 25);
  else if (it.tagWords.some((w) => w.startsWith(q) && q.length >= 3)) s = Math.max(s, 16);
  if (it.meta.includes(q)) s = Math.max(s, 14);
  if (it.desc.includes(q)) s = Math.max(s, 9);
  if (s === 0) {
    const syn = SYN.get(q);
    if (syn) {
      for (const w of syn) {
        if (it.name.includes(w)) s = Math.max(s, 18);
        else if (it.tagWords.includes(w) || it.tags.includes(w)) s = Math.max(s, 15);
        else if (it.meta.includes(w)) s = Math.max(s, 10);
        else if (it.desc.includes(w)) s = Math.max(s, 6);
      }
    }
  }
  if (s === 0) {
    if (it.name.some((w) => fuzzyEq(q, w))) s = 12;
    else if (it.tagWords.some((w) => fuzzyEq(q, w))) s = 10;
    else if (it.desc.some((w) => fuzzyEq(q, w))) s = 5;
  }
  return s;
}

/**
 * Ranked presets for a query. Every query word must match something (exactly, by prefix, via a
 * synonym, or fuzzily) — the score rewards name > tag > component > description, an exact
 * phrase in the name, featured presets, favourites and recent use. Empty query = browse order
 * (favourites, then featured, then library order) within the category.
 */
export function searchPresets(query: string, opts: SearchOptions = {}): SearchHit[] {
  const q = tokenize(query).filter((t) => !["a", "an", "the", "of", "for", "and", "with", "to", "my"].includes(t));
  const fav = opts.favorites ?? new Set<string>();
  const recentRank = new Map((opts.recents ?? []).map((id, i) => [id, i]));
  const hits: SearchHit[] = [];
  index().forEach((it, i) => {
    if (opts.category && it.preset.category !== opts.category) return;
    let score = 0;
    if (q.length) {
      for (const t of q) {
        const s = tokenScore(t, it);
        if (s === 0) return;
        score += s;
      }
      if (it.nameText.includes(q.join(" "))) score += 20;
    } else {
      score = 1000 - i / 1000;
    }
    if (it.preset.featured) score += q.length ? 3 : 200;
    if (fav.has(it.preset.id)) score += q.length ? 6 : 400;
    const r = recentRank.get(it.preset.id);
    if (r !== undefined) score += q.length ? Math.max(0, 4 - r) : 0;
    hits.push({ preset: it.preset, score });
  });
  hits.sort((a, b) => b.score - a.score);
  return opts.limit ? hits.slice(0, opts.limit) : hits;
}

/** Category counts for the chip row. */
export function categoryCounts(): Record<GraphicCategory, number> {
  const out = Object.fromEntries(GRAPHIC_CATEGORIES.map((c) => [c.id, 0])) as Record<GraphicCategory, number>;
  for (const p of GRAPHIC_PRESETS) out[p.category]++;
  return out;
}
