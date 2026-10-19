import { DirectorAnswerSchema, DirectorOpSchema, DIRECTOR_OP_NAMES, DIRECTOR_REGIONS, type DirectorAnswer } from "./schema";
import { SFX_SOUNDS } from "../motion-contract";

/**
 * Reads what Chris pastes back from ChatGPT (or what Claude returns) into a DirectorAnswer —
 * PURE, deterministic, tolerant of the usual chat noise:
 * code fences (several — the one with "operations" wins), prose before/after, smart quotes,
 * // and /* comments, trailing commas, a top-level array, key aliases ("ops", "message"),
 * op-name spellings ("add_graphic", "AddGraphic"), times as "3.1s" / "0:03.1" / "3.1",
 * placements as "left side" / "top-left", sounds as "cha-ching" / "pop", sizes as "small".
 * Every repair is listed (shown to Chris as "fixed: …"). A misfit answer returns precise errors
 * and the one fix-up message to send back — nothing is applied.
 */

export type DirectorParse =
  | { ok: true; answer: DirectorAnswer; repaired: string[] }
  | { ok: false; errors: string[]; repairMessage: string };

function stripComments(s: string): string {
  // Remove // line comments and /* */ blocks that are OUTSIDE strings.
  let out = "";
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      continue;
    }
    if (c === "/" && s[i + 1] === "/") {
      while (i < s.length && s[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (c === "/" && s[i + 1] === "*") {
      i += 2;
      while (i < s.length && !(s[i] === "*" && s[i + 1] === "/")) i++;
      i++;
      continue;
    }
    out += c;
  }
  return out;
}

/** Balanced {...} or [...] starting at `start` (string-aware). */
function balancedEnd(s: string, start: number): number {
  const open = s[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Pulls the answer's JSON out of a chat reply. Returns null when there is none. */
export function extractDirectorJson(text: string): { value: unknown; repaired: string[] } | null {
  const repaired: string[] = [];
  let s = text.replace(/^\uFEFF/, "").replace(/[\u200B-\u200D\u2060]/g, "").replace(/\u00A0/g, " ");
  const fences = [...s.matchAll(/```[a-zA-Z]*\s*([\s\S]*?)```/g)].map((m) => m[1]!);
  if (fences.length) {
    const pick = fences.find((f) => /"?operations"?\s*:/.test(f)) ?? fences.sort((a, b) => b.length - a.length)[0]!;
    s = pick;
    repaired.push("took the JSON from the code block");
  }
  s = s.replace(/[“”„]/g, '"').replace(/[‘’]/g, "'");
  const objStart = s.indexOf("{");
  const arrStart = s.indexOf("[");
  const start = objStart < 0 ? arrStart : arrStart < 0 ? objStart : Math.min(objStart, arrStart);
  if (start < 0) return null;
  // Prefer the object that holds "operations" when chatter contains other braces.
  let from = start;
  const opsAt = s.search(/"operations"\s*:/);
  if (opsAt > 0) {
    const before = s.lastIndexOf("{", opsAt);
    if (before >= 0) from = before;
  }
  const end = balancedEnd(s, from);
  const body = end > from ? s.slice(from, end + 1) : s.slice(from, Math.max(s.lastIndexOf("}"), s.lastIndexOf("]")) + 1);
  if (from > 0 && s.slice(0, from).trim()) repaired.push("ignored the text around the JSON");
  const attempts: Array<[string, (x: string) => string]> = [
    ["", (x) => x],
    ["removed comments", (x) => stripComments(x)],
    ["removed trailing commas", (x) => stripComments(x).replace(/,\s*([}\]])/g, "$1")],
    ["fixed single-quoted strings", (x) => stripComments(x).replace(/,\s*([}\]])/g, "$1").replace(/'([^'"\n]*)'(?=\s*[:,}\]])/g, '"$1"')],
  ];
  for (const [label, fix] of attempts) {
    try {
      const value = JSON.parse(fix(body)) as unknown;
      if (label) repaired.push(label);
      return { value, repaired };
    } catch {
      /* next */
    }
  }
  return null;
}

const OP_FIELDS = new Map<string, Set<string>>(
  DirectorOpSchema.options.map((schema) => {
    const shape = schema.shape as Record<string, unknown>;
    const lit = (shape.op as { value?: unknown; def?: { values?: unknown[] } }).value ?? (shape.op as { def?: { values?: unknown[] } }).def?.values?.[0];
    return [String(lit), new Set(Object.keys(shape))];
  }),
);

const OP_KEYS = new Map<string, string>(DIRECTOR_OP_NAMES.map((n) => [n.toLowerCase(), n]));
const OP_ALIASES: Record<string, string> = {
  graphic: "addGraphic",
  addvisual: "addGraphic",
  visual: "addGraphic",
  text: "addText",
  title: "addText",
  zoom: "addZoom",
  punchin: "addZoom",
  sfx: "addSfx",
  sound: "addSfx",
  addsound: "addSfx",
  delete: "remove",
  cutrange: "cut",
  removerange: "cut",
  captions: "setCaptions",
  modify: "update",
  edit: "update",
  change: "update",
  retime: "move",
  comment: "note",
};

const REGION_WORDS: Array<[RegExp, (typeof DIRECTOR_REGIONS)[number]]> = [
  [/^(top|upper)[\s_-]*left/, "TOP_LEFT"],
  [/^(top|upper)[\s_-]*right/, "TOP_RIGHT"],
  [/^(bottom|lower)[\s_-]*left/, "BOTTOM_LEFT"],
  [/^(bottom|lower)[\s_-]*right/, "BOTTOM_RIGHT"],
  [/^left/, "LEFT"],
  [/^right/, "RIGHT"],
  [/^(top|upper|above)/, "TOP"],
  [/^(bottom|lower|below)/, "BOTTOM"],
  [/^(center|centre|middle)/, "CENTER"],
  [/^(auto|anywhere|best)/, "AUTO"],
];

const SFX_WORDS: Record<string, (typeof SFX_SOUNDS)[number]> = {
  chaching: "CASH",
  kaching: "CASH",
  cashregister: "CASH",
  cash: "CASH",
  coin: "CASH",
  money: "CASH",
  pop: "SOFT_POP",
  softpop: "SOFT_POP",
  whoosh: "WHOOSH",
  swoosh: "SWOOSH_UP",
  swooshup: "SWOOSH_UP",
  click: "CLICK",
  tick: "TICK",
  riser: "RISER",
  impact: "IMPACT",
  hit: "IMPACT",
  boom: "IMPACT",
  thud: "IMPACT",
  shimmer: "SHIMMER",
  sparkle: "SHIMMER",
  ding: "SHIMMER",
};

/** "3.1s" / "3.1" / "0:03.1" / "00:00:03" → seconds; null when it isn't a time. */
export function parseTimeString(s: string): number | null {
  const t = s.trim().toLowerCase();
  let m = /^(-?\d+(?:\.\d+)?)\s*(s|sec|secs|second|seconds)?$/.exec(t);
  if (m) return Number(m[1]);
  m = /^(\d+):(\d{1,2}(?:\.\d+)?)$/.exec(t);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  m = /^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(t);
  if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  return null;
}

const TIME_KEYS = new Set(["start", "end", "at"]);

function normalizeTime(v: unknown, note: (s: string) => void): unknown {
  if (typeof v === "string") {
    const low = v.trim().toLowerCase();
    if (low === "end" || low === "the end") return "end";
    if (low === "start" || low === "beginning") {
      note("read \"start\" as 0 s");
      return 0;
    }
    const n = parseTimeString(v);
    if (n !== null) {
      note(`read the time "${v}" as ${n} s`);
      return n;
    }
    const ev = /^e\d+$/i.exec(low);
    if (ev) {
      note(`read "${v}" as event ${low}`);
      return { event: low };
    }
    return v;
  }
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = { ...(v as Record<string, unknown>) };
    if (typeof o.expression === "string") o.expression = o.expression.toLowerCase().replace(/happiness/, "happy").replace(/sadness/, "sad").replace(/anger/, "angry");
    if (typeof o.event === "string") o.event = o.event.toLowerCase();
    for (const k of ["near", "offset", "nth"]) {
      if (typeof o[k] === "string") {
        const n = parseTimeString(o[k] as string);
        if (n !== null) o[k] = n;
      }
    }
    return o;
  }
  return v;
}

function normalizePlacement(v: unknown, note: (s: string) => void): unknown {
  if (typeof v !== "string") return v;
  const low = v.trim().toLowerCase().replace(/\s+(side|of the screen|of screen|half)$/, "");
  for (const [re, region] of REGION_WORDS) {
    if (re.test(low)) {
      if (region !== v) note(`read the placement "${v}" as ${region}`);
      return region;
    }
  }
  return v;
}

function normalizeOp(raw: unknown, index: number, note: (s: string) => void, autoRef: () => string): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const o: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  // op name
  const name = typeof o.op === "string" ? o.op : typeof o.type === "string" ? o.type : typeof o.action === "string" ? o.action : null;
  if (name !== null) {
    if (o.op === undefined) {
      delete o.type;
      delete o.action;
    }
    const key = name.replace(/[\s_-]/g, "").toLowerCase();
    const resolved = OP_KEYS.get(key) ?? OP_ALIASES[key] ?? null;
    if (resolved) {
      if (resolved !== name) note(`operation ${index + 1}: read "${name}" as ${resolved}`);
      o.op = resolved;
    } else o.op = name;
  }
  // field aliases
  const alias = (from: string, to: string) => {
    if (o[from] !== undefined && o[to] === undefined) {
      o[to] = o[from];
      delete o[from];
    }
  };
  alias("preset", "presetId");
  alias("preset_id", "presetId");
  alias("graphic", "presetId");
  alias("id", o.op === "remove" || o.op === "move" || o.op === "update" ? "target" : "ref");
  alias("name", "ref");
  alias("position", "placement");
  alias("side", "placement");
  alias("region", "placement");
  alias("sound", o.op === "addSfx" ? "sound" : "sfx");
  alias("zoom", "amount");
  alias("scale", o.op === "addZoom" ? "amount" : "scale");
  alias("time", o.op === "addSfx" ? "at" : "start");
  alias("reason", "why");
  alias("message", "text");
  for (const k of Object.keys(o)) {
    if (TIME_KEYS.has(k)) o[k] = normalizeTime(o[k], (s) => note(`operation ${index + 1}: ${s}`));
  }
  if (typeof o.duration === "string") {
    const n = parseTimeString(o.duration);
    if (n !== null) o.duration = n;
  }
  if (o.placement !== undefined) o.placement = normalizePlacement(o.placement, (s) => note(`operation ${index + 1}: ${s}`));
  for (const k of ["sfx", "sound"]) {
    if (typeof o[k] === "string") {
      const raw = o[k] as string;
      const up = raw.trim().toUpperCase().replace(/[\s-]+/g, "_");
      if ((SFX_SOUNDS as readonly string[]).includes(up)) o[k] = up;
      else if (/^(none|null|no|silent)$/i.test(raw.trim())) o[k] = null;
      else {
        const w = SFX_WORDS[raw.toLowerCase().replace(/[^a-z]/g, "")];
        if (w) {
          note(`operation ${index + 1}: read the sound "${raw}" as ${w}`);
          o[k] = w;
        }
      }
    }
  }
  if (typeof o.size === "string") {
    const s = o.size.trim().toLowerCase();
    const m = s.startsWith("s") ? "S" : s.startsWith("m") ? "M" : s.startsWith("l") || s.startsWith("b") ? "L" : o.size;
    o.size = m;
  }
  for (const k of ["enter", "exit"]) if (typeof o[k] === "string") o[k] = (o[k] as string).trim().toUpperCase();
  for (const k of ["amount", "volume", "speed"]) {
    if (typeof o[k] === "string" && Number.isFinite(Number((o[k] as string).replace(/x$/i, "")))) o[k] = Number((o[k] as string).replace(/x$/i, ""));
  }
  if ((o.op === "addGraphic" || o.op === "addText" || o.op === "addZoom" || o.op === "addSfx") && (typeof o.ref !== "string" || !o.ref)) {
    o.ref = autoRef();
    note(`operation ${index + 1}: named it "${o.ref}"`);
  }
  const allowed = OP_FIELDS.get(String(o.op));
  if (allowed) {
    for (const k of Object.keys(o)) {
      if (!allowed.has(k)) {
        note(`operation ${index + 1}: ignored the unknown field "${k}"`);
        delete o[k];
      }
    }
  }
  if (typeof o.ref === "string") o.ref = o.ref.trim().replace(/\s+/g, "-").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40) || autoRef();
  return o;
}

export function parseDirectorAnswer(text: string): DirectorParse {
  const extracted = extractDirectorJson(text);
  if (!extracted) {
    const errors = ["I couldn't find the JSON answer in what was pasted — copy ChatGPT's whole reply (the code block is enough)."];
    return { ok: false, errors, repairMessage: directorRepairMessage(errors) };
  }
  const repaired = [...extracted.repaired];
  const note = (s: string) => repaired.push(s);
  let value = extracted.value as unknown;
  if (Array.isArray(value)) {
    value = { reply: "Done.", operations: value };
    note("wrapped a bare list of operations");
  }
  if (!value || typeof value !== "object") {
    const errors = ["The answer must be one JSON object with \"reply\" and \"operations\"."];
    return { ok: false, errors, repairMessage: directorRepairMessage(errors) };
  }
  const o: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  for (const k of ["ops", "edits", "instructions", "actions", "changes"]) {
    if (o.operations === undefined && Array.isArray(o[k])) {
      o.operations = o[k];
      delete o[k];
      note(`read "${k}" as "operations"`);
    }
  }
  for (const k of ["message", "summary", "response", "explanation"]) {
    if (o.reply === undefined && typeof o[k] === "string") {
      o.reply = o[k];
      delete o[k];
    }
  }
  if (o.reply === undefined && Array.isArray(o.operations)) {
    o.reply = "Here's your edit.";
  }
  // Drop unknown top-level keys (chatty extras like "notes"), but keep notes as note ops.
  if (Array.isArray(o.notes)) {
    const notes = (o.notes as unknown[]).filter((n): n is string => typeof n === "string").map((t) => ({ op: "note", text: t.slice(0, 400) }));
    o.operations = [...((o.operations as unknown[]) ?? []), ...notes];
  }
  for (const k of Object.keys(o)) if (k !== "reply" && k !== "operations") delete o[k];
  let auto = 0;
  const autoRef = () => `item${++auto}`;
  if (Array.isArray(o.operations)) o.operations = (o.operations as unknown[]).map((op, i) => normalizeOp(op, i, note, autoRef));
  const parsed = DirectorAnswerSchema.safeParse(o);
  if (!parsed.success) {
    const ops = Array.isArray(o.operations) ? (o.operations as Array<Record<string, unknown>>) : [];
    const errors = parsed.error.issues.slice(0, 12).map((i) => {
      const [first, idx, ...rest] = i.path;
      if (first === "operations" && typeof idx === "number") {
        const op = ops[idx];
        const label = op ? `${String(op.op ?? "?")}${op.ref ? ` "${String(op.ref)}"` : op.target ? ` "${String(op.target)}"` : ""}` : "?";
        const field = rest.length ? rest.join(".") : "(the operation)";
        const msg = /Invalid input/i.test(i.message) && rest.length === 0 ? `"op" must be one of ${DIRECTOR_OP_NAMES.join(", ")}` : i.message;
        return `operations[${idx}] (${label}) ${field}: ${msg}`;
      }
      return `${i.path.join(".") || "(answer)"}: ${i.message}`;
    });
    return { ok: false, errors, repairMessage: directorRepairMessage(errors) };
  }
  return { ok: true, answer: parsed.data, repaired: [...new Set(repaired)] };
}

/** The one short message Chris sends back to ChatGPT when its answer didn't fit. */
export function directorRepairMessage(errors: string[]): string {
  return `Your edit instructions didn't fit the format. Fix exactly these problems and resend the COMPLETE JSON answer ({"reply": …, "operations": [...]}) in one code block, nothing else:\n${errors.map((e) => `- ${e}`).join("\n")}`;
}
