"use client";

import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import { gzipSync, inflateSync } from "fflate";
import {
  extractJsonFromChatHtml,
  isChatHtmlEntry,
  isConversationsEntry,
  listZipEntries,
  parseConversationsJson,
  parseConversationsJsonText,
  parsePastedConversation,
  readZipEntry,
  summarizeConversation,
  type ParsedConversation,
  type PlanContextSource,
  type RandomAccess,
} from "@chris/domain/plan-context";
import { readShareLink } from "./actions";

type Tab = "export" | "share" | "paste";
type Saved = { planContextId: string; title: string; status: string; version: number };

/** The browser reads the export .zip with File.slice — only conversations.json is ever
 * decompressed, and only the chosen chats' text is sent to the server. */
function fileAccess(file: File): RandomAccess {
  return { size: file.size, read: async (s, e) => new Uint8Array(await file.slice(s, e).arrayBuffer()) };
}

async function readExportFile(file: File): Promise<{ conversations: ParsedConversation[]; source: PlanContextSource }> {
  const name = file.name.toLowerCase();
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  const isZip = head[0] === 0x50 && head[1] === 0x4b;
  const decoder = new TextDecoder();
  if (isZip) {
    const fa = fileAccess(file);
    const entries = await listZipEntries(fa);
    const convEntries = entries.filter((e) => isConversationsEntry(e.name));
    if (convEntries.length) {
      const all: ParsedConversation[] = [];
      for (const e of convEntries) all.push(...parseConversationsJsonText(decoder.decode(await readZipEntry(fa, e, (d) => inflateSync(d)))));
      return { conversations: sortNewest(all), source: "EXPORT" };
    }
    const html = entries.find((e) => isChatHtmlEntry(e.name));
    if (html) {
      const data = extractJsonFromChatHtml(decoder.decode(await readZipEntry(fa, html, (d) => inflateSync(d))));
      if (data) return { conversations: parseConversationsJson(data), source: "CHAT_HTML" };
    }
    throw new Error("That .zip doesn't have ChatGPT's conversations in it. Make sure it's the file from OpenAI's “Your data export is ready” email.");
  }
  const text = await file.text();
  if (name.endsWith(".html") || name.endsWith(".htm") || /^\s*</.test(text)) {
    const data = extractJsonFromChatHtml(text);
    if (!data) throw new Error("Couldn't find the chats inside that page. Choose the .zip from OpenAI's email instead.");
    return { conversations: parseConversationsJson(data), source: "CHAT_HTML" };
  }
  return { conversations: parseConversationsJsonText(text), source: "EXPORT" };
}

function sortNewest(list: ParsedConversation[]): ParsedConversation[] {
  return [...list].sort((a, b) => (b.updatedAt ?? b.createdAt ?? "").localeCompare(a.updatedAt ?? a.createdAt ?? ""));
}

async function save(c: ParsedConversation, source: PlanContextSource, sourceRef: string | null, planContextId?: string | null): Promise<Saved> {
  const payload = {
    source,
    sourceRef,
    conversationId: c.conversationId,
    title: c.title.slice(0, 300),
    conversationCreatedAt: c.createdAt,
    conversationUpdatedAt: c.updatedAt,
    messages: c.messages,
    planContextId: planContextId || null,
  };
  const body = gzipSync(new TextEncoder().encode(JSON.stringify(payload)));
  const res = await fetch("/api/plan-context", { method: "POST", headers: { "content-type": "application/octet-stream", "x-body-encoding": "gzip" }, body: body as BodyInit });
  const data = (await res.json().catch(() => ({}))) as { planContextId?: string; status?: string; version?: number; error?: string };
  if (!res.ok || !data.planContextId) throw new Error(data.error ?? "Couldn't save that conversation — try again.");
  return { planContextId: data.planContextId, title: c.title, status: data.status ?? "created", version: data.version ?? 1 };
}

function fmtDate(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function ContextImportClient({ existing }: { existing: { id: string; title: string }[] }) {
  const [tab, setTab] = useState<Tab>("export");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exp, setExp] = useState<{ conversations: ParsedConversation[]; source: PlanContextSource; fileName: string } | null>(null);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [shareLink, setShareLink] = useState("");
  const [share, setShare] = useState<{ conversation: ParsedConversation; url: string } | null>(null);
  const [pasteText, setPasteText] = useState("");
  const [pasteTitle, setPasteTitle] = useState("");
  const [pasteTarget, setPasteTarget] = useState("");
  const [pasted, setPasted] = useState<ParsedConversation | null>(null);
  const [saved, setSaved] = useState<Saved[] | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const summaries = useMemo(() => (exp ? exp.conversations.map((c, i) => summarizeConversation(c, i)) : []), [exp]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || !exp) return summaries;
    return summaries.filter((s) => s.title.toLowerCase().includes(q) || exp.conversations[s.index]!.messages.some((m) => m.text.toLowerCase().includes(q)));
  }, [summaries, query, exp]);

  async function onFile(file: File | undefined) {
    if (!file) return;
    setError(null);
    setBusy("Reading your export on this phone…");
    try {
      const r = await readExportFile(file);
      if (r.conversations.length === 0) throw new Error("No chats found in that file.");
      setExp({ ...r, fileName: file.name });
      setPicked(new Set());
      setQuery("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't read that file.");
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function saveMany(items: { c: ParsedConversation; source: PlanContextSource; ref: string | null; target?: string | null }[]) {
    setError(null);
    const out: Saved[] = [];
    try {
      for (const [i, it] of items.entries()) {
        setBusy(items.length > 1 ? `Saving ${i + 1} of ${items.length}…` : "Saving…");
        out.push(await save(it.c, it.source, it.ref, it.target));
      }
      setSaved(out);
      window.scrollTo({ top: 0 });
    } catch (err) {
      if (out.length) setSaved(out);
      setError(err instanceof Error ? err.message : "Couldn't save.");
    } finally {
      setBusy(null);
    }
  }

  async function readShare() {
    if (!shareLink.trim()) return setError("Paste the share link first.");
    setError(null);
    setBusy("Opening the link…");
    const r = await readShareLink(shareLink.trim());
    setBusy(null);
    if ("error" in r) return setError(r.error);
    setShare(r);
  }

  function readPaste() {
    if (!pasteText.trim()) return setError("Paste the conversation first.");
    setError(null);
    const c = parsePastedConversation(pasteText, pasteTitle);
    if (c.messages.length === 0) return setError("There's no text in that paste.");
    setPasted(c);
  }

  // ---------- Saved ----------
  if (saved) {
    return (
      <div className="panel flex flex-col gap-3 px-5 py-6" data-testid="context-saved">
        <h2 className="text-[20px] font-semibold">{saved.length === 1 ? "Conversation saved" : `${saved.length} conversations saved`}</h2>
        <ul className="flex flex-col gap-2">
          {saved.map((s) => (
            <li key={s.planContextId}>
              <Link href={`/plan/context/${s.planContextId}`} className="flex min-h-[52px] items-center justify-between gap-3 rounded-2xl bg-white/[0.04] px-3 py-2 active:bg-white/10">
                <span className="min-w-0">
                  <span className="block truncate text-[15px] font-medium">{s.title}</span>
                  <span className="block text-[12.5px] text-[var(--color-text-muted)]">
                    {s.status === "unchanged" ? "Already saved — nothing changed" : s.status === "new-version" ? `Updated — version ${s.version} (older versions kept)` : "Saved"}
                  </span>
                </span>
                <span className="shrink-0 text-[13.5px] text-[var(--color-gold-400)]">Open</span>
              </Link>
            </li>
          ))}
        </ul>
        <button type="button" className="btn btn-ghost w-full" onClick={() => { setSaved(null); setExp(null); setShare(null); setPasted(null); }}>
          Bring in another
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-3 gap-1 rounded-2xl bg-white/[0.05] p-1" role="tablist">
        {(
          [
            ["export", "Export file"],
            ["share", "Share link"],
            ["paste", "Paste"],
          ] as [Tab, string][]
        ).map(([t, label]) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            onClick={() => {
              setTab(t);
              setError(null);
            }}
            className={`min-h-[42px] rounded-xl text-[14.5px] font-medium ${tab === t ? "bg-[var(--color-gold-500)] text-black" : "text-[var(--color-text-muted)] active:bg-white/10"}`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "export" && !exp && (
        <section className="panel flex flex-col gap-3 p-4">
          <label className={`flex min-h-[140px] cursor-pointer flex-col items-center justify-center gap-2 rounded-3xl border-2 border-dashed px-4 py-6 text-center ${busy ? "opacity-60" : "border-[var(--color-gold-500)]/60 bg-[var(--color-gold-500)]/[0.08] active:bg-[var(--color-gold-500)]/15"}`}>
            <input ref={fileRef} type="file" accept=".zip,.json,.html,application/zip,application/json,text/html" className="sr-only" disabled={!!busy} onChange={(e) => void onFile(e.target.files?.[0])} data-testid="export-file" />
            <span className="text-[17px] font-semibold">{busy ?? "Choose the export file"}</span>
            <span className="text-[13px] text-[var(--color-text-faint)]">The .zip from OpenAI&apos;s email (or conversations.json). It&apos;s read on this phone — photos never upload, only the chats you pick are saved.</span>
          </label>
          <details className="rounded-2xl bg-white/[0.04] px-3 py-2" data-testid="export-howto">
            <summary className="min-h-[40px] cursor-pointer py-2 text-[14.5px] font-medium">How to get the export on iPhone</summary>
            <ol className="flex list-decimal flex-col gap-1.5 pb-2 pl-5 text-[14px] leading-snug text-[var(--color-text-muted)]">
              <li>Open the ChatGPT app, tap the menu (two lines, top left), then your name / Settings.</li>
              <li>
                Tap <b>Data Controls</b> → <b>Export Data</b>. It opens ChatGPT on the web — tap <b>Export</b>, then <b>Confirm export</b> (enter the code from your email if it asks).
              </li>
              <li>Wait for OpenAI&apos;s email “Your data export is ready” (minutes to a few hours). The link works for 24 hours.</li>
              <li>Open the email on your iPhone and tap the download link — Safari saves a .zip in Files → Downloads. Don&apos;t unzip it.</li>
              <li>Come back here, tap “Choose the export file” and pick that .zip.</li>
            </ol>
            <p className="pb-2 text-[12.5px] text-[var(--color-text-faint)]">Export is available on Free, Plus and Pro accounts (not work/Enterprise workspaces).</p>
          </details>
        </section>
      )}

      {tab === "export" && exp && (
        <section className="flex flex-col gap-3" data-testid="conversation-picker">
          <div className="panel flex flex-col gap-2 p-4">
            <p className="eyebrow">{exp.fileName}</p>
            <p className="text-[17px] font-semibold">Pick your planning chat</p>
            <p className="text-[13.5px] text-[var(--color-text-muted)]">{exp.conversations.length} chats found. Tap the one(s) where you planned your videos.</p>
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search titles and messages" className="field-input" type="search" data-testid="conversation-search" />
          </div>
          <ul className="flex flex-col gap-2">
            {filtered.slice(0, 200).map((s) => {
              const on = picked.has(s.index);
              return (
                <li key={s.index}>
                  <button
                    type="button"
                    aria-pressed={on}
                    onClick={() => setPicked((p) => { const n = new Set(p); if (n.has(s.index)) n.delete(s.index); else n.add(s.index); return n; })}
                    className={`panel flex w-full items-start gap-3 px-4 py-3 text-left ${on ? "!border-[var(--color-gold-500)]" : ""}`}
                    data-testid="conversation-row"
                  >
                    <span className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border ${on ? "border-[var(--color-gold-500)] bg-[var(--color-gold-500)] text-black" : "border-[var(--color-border)]"}`} aria-hidden>
                      {on ? "✓" : ""}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[15.5px] font-medium leading-snug">{s.title}</span>
                      <span className="block text-[12.5px] text-[var(--color-text-muted)]">
                        {fmtDate(s.updatedAt ?? s.createdAt)} · {s.messageCount} messages
                      </span>
                      {s.preview && <span className="mt-0.5 line-clamp-2 block text-[13px] text-[var(--color-text-faint)]">{s.preview}</span>}
                    </span>
                  </button>
                </li>
              );
            })}
            {filtered.length === 0 && <li className="px-2 text-[14px] text-[var(--color-text-muted)]">No chats match “{query}”.</li>}
            {filtered.length > 200 && <li className="px-2 text-[13px] text-[var(--color-text-faint)]">Showing 200 of {filtered.length} — search to narrow it down.</li>}
          </ul>
          <div className="flex gap-2 pb-24">
            <button type="button" className="btn btn-ghost flex-1" onClick={() => setExp(null)} disabled={!!busy}>
              Different file
            </button>
            <button
              type="button"
              className="btn btn-primary flex-[2]"
              disabled={!!busy || picked.size === 0}
              onClick={() => void saveMany([...picked].map((i) => ({ c: exp.conversations[i]!, source: exp.source, ref: exp.fileName })))}
              data-testid="save-conversations"
            >
              {busy ?? (picked.size ? `Save ${picked.size} chat${picked.size === 1 ? "" : "s"}` : "Pick a chat")}
            </button>
          </div>
        </section>
      )}

      {tab === "share" && (
        <section className="panel flex flex-col gap-3 p-4">
          {!share ? (
            <>
              <label className="block">
                <span className="field-label">ChatGPT share link</span>
                <input value={shareLink} onChange={(e) => setShareLink(e.target.value)} inputMode="url" autoCapitalize="off" autoCorrect="off" placeholder="https://chatgpt.com/share/…" className="field-input" data-testid="share-input" />
              </label>
              <button type="button" className="btn btn-primary w-full" onClick={() => void readShare()} disabled={!!busy} data-testid="share-read">
                {busy ?? "Read the link"}
              </button>
              <p className="text-[12.5px] leading-snug text-[var(--color-text-faint)]">
                In the chat: tap the share icon → Create link → Copy. ChatGPT often blocks apps from reading these pages — if it does, use the export file or paste.
              </p>
            </>
          ) : (
            <ConversationPreview c={share.conversation} onBack={() => setShare(null)} busy={busy} onSave={() => void saveMany([{ c: share.conversation, source: "SHARE_LINK", ref: share.url }])} />
          )}
        </section>
      )}

      {tab === "paste" && (
        <section className="panel flex flex-col gap-3 p-4">
          {!pasted ? (
            <>
              <label className="block">
                <span className="field-label">Paste the conversation</span>
                <textarea
                  value={pasteText}
                  onChange={(e) => setPasteText(e.target.value)}
                  rows={10}
                  placeholder={"On chatgpt.com in Safari: open the chat, select all, copy, paste here.\n\nYou said:\nHelp me plan 120 videos…\nChatGPT said:\nHere's the plan…"}
                  className="field-input min-h-[220px] font-[inherit] leading-snug"
                  data-testid="paste-conversation"
                />
              </label>
              <label className="block">
                <span className="field-label">Name (optional)</span>
                <input value={pasteTitle} onChange={(e) => setPasteTitle(e.target.value)} className="field-input" placeholder="e.g. 120-video plan" />
              </label>
              {existing.length > 0 && (
                <label className="block">
                  <span className="field-label">Save as</span>
                  <select value={pasteTarget} onChange={(e) => setPasteTarget(e.target.value)} className="field-input">
                    <option value="">A new conversation</option>
                    {existing.map((e) => (
                      <option key={e.id} value={e.id}>
                        Update “{e.title}” (keeps the old version)
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <button type="button" className="btn btn-primary w-full" onClick={readPaste} data-testid="paste-read">
                Read it
              </button>
            </>
          ) : (
            <ConversationPreview c={pasted} onBack={() => setPasted(null)} busy={busy} onSave={() => void saveMany([{ c: pasted, source: "PASTE", ref: null, target: pasteTarget || null }])} />
          )}
        </section>
      )}

      {error && (
        <p className="rounded-2xl bg-[var(--color-rose-500)]/10 px-4 py-3 text-[14px] text-[var(--color-rose-400)]" role="alert" data-testid="context-error">
          {error}
        </p>
      )}
    </div>
  );
}

function ConversationPreview({ c, onBack, onSave, busy }: { c: ParsedConversation; onBack: () => void; onSave: () => void; busy: string | null }) {
  const you = c.messages.filter((m) => m.role === "user").length;
  const gpt = c.messages.filter((m) => m.role === "assistant").length;
  return (
    <div className="flex flex-col gap-3" data-testid="conversation-preview">
      <p className="text-[17px] font-semibold">{c.title}</p>
      <p className="text-[13.5px] text-[var(--color-text-muted)]">
        {c.messages.length} message{c.messages.length === 1 ? "" : "s"}
        {you || gpt ? ` · ${you} from you, ${gpt} from ChatGPT` : ""}
      </p>
      {c.notes.map((n) => (
        <p key={n} className="text-[12.5px] text-[var(--color-text-faint)]">
          {n}
        </p>
      ))}
      <p className="line-clamp-4 rounded-2xl bg-white/[0.04] px-3 py-2 text-[13.5px] text-[var(--color-text-muted)]">{c.messages[0]?.text}</p>
      <div className="flex gap-2">
        <button type="button" className="btn btn-ghost flex-1" onClick={onBack} disabled={!!busy}>
          Back
        </button>
        <button type="button" className="btn btn-primary flex-[2]" onClick={onSave} disabled={!!busy} data-testid="save-conversation">
          {busy ?? "Save"}
        </button>
      </div>
    </div>
  );
}
