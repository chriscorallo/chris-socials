"use client";

import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import {
  FIELD_LABELS,
  assignDefaultTimes,
  detectPastedTable,
  formatTime12,
  formatYmdShort,
  looksLikeGoogleSheetLink,
  parseDelimited,
  parseFreeText,
  reresolveRows,
  suggestTableMapping,
  summarizeRows,
  summaryLine,
  tableToRows,
  validateRows,
  type ColumnField,
  type ExistingPlanned,
  type PlanDraftRow,
  type PlanSourceKind,
  type TableMapping,
  type ValidatedRow,
} from "@chris/domain/plan-import";
import { parsePlanSegments } from "@chris/domain/plan-context";
import type { PlatformCadence, PlanPlatform } from "@chris/domain/planning";
import { cleanUpPlanWithAi, createPlanFromImport, fetchGoogleSheet } from "../actions";

type Tab = "paste" | "file" | "sheet";
type Source = { kind: PlanSourceKind; ref: string | null; raw: string };
type TableState = { cells: string[][]; mapping: TableMapping; sheets?: { name: string; rows: string[][] }[]; sheetIndex?: number };
type Row = PlanDraftRow & { dropped?: boolean };
type Done = { created: number; skipped: number; failed: { title: string; error: string }[]; alreadyImported: boolean };

const PLATFORM_CHIPS: { p: PlanPlatform; label: string }[] = [
  { p: "TIKTOK", label: "TikTok" },
  { p: "INSTAGRAM", label: "Reels" },
  { p: "YOUTUBE", label: "Shorts" },
];

const FIELD_OPTIONS: ColumnField[] = ["ignore", "date", "time", "title", "platforms", "hook", "notes", "format", "pillar", "week", "platform:TIKTOK", "platform:INSTAGRAM", "platform:YOUTUBE"];

export function ImportClient({
  today,
  existing,
  enabledPlatforms,
  cadences,
  fromConversation,
}: {
  today: string;
  existing: ExistingPlanned[];
  enabledPlatforms: PlanPlatform[];
  cadences: PlatformCadence[] | null;
  /** "Update my plan from this conversation" (/plan/context): the chosen messages' text,
   * each parsed on its own, straight into the preview. */
  fromConversation?: { title: string; texts: string[] } | null;
}) {
  // Rows found in a saved ChatGPT conversation open the preview directly.
  const [initial] = useState(() => (fromConversation?.texts.length ? parsePlanSegments(fromConversation.texts, { today, startDate: today, enabledPlatforms }) : null));
  const [tab, setTab] = useState<Tab>("paste");
  const [text, setText] = useState("");
  const [sheetLink, setSheetLink] = useState("");
  const [busy, setBusy] = useState<null | string>(null);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<Source | null>(() =>
    initial?.rows.length && fromConversation ? { kind: "TEXT", ref: `ChatGPT conversation: ${fromConversation.title}`.slice(0, 500), raw: fromConversation.texts.join("\n\n") } : null,
  );
  const [table, setTable] = useState<TableState | null>(null);
  const [rows, setRows] = useState<Row[] | null>(() => (initial?.rows.length ? initial.rows : null));
  const [startDate, setStartDate] = useState(today);
  const [usesRelative, setUsesRelative] = useState(() => initial?.usesRelativeDates ?? false);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [aiNote, setAiNote] = useState<string | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const ctx = (start = startDate) => ({ today, startDate: start, enabledPlatforms });

  const live = useMemo(() => (rows ?? []).filter((r) => !r.dropped), [rows]);
  const validated = useMemo(() => validateRows(live, existing), [live, existing]);
  const summary = useMemo(() => summarizeRows(validated), [validated]);
  const autoTimes = useMemo(() => {
    const t = assignDefaultTimes(validated, cadences ? { cadences } : null);
    return new Map(validated.map((r, i) => [r.key, t[i] ?? null]));
  }, [validated, cadences]);
  const needsFix = validated.filter((r) => r.status === "needsDate" || r.status === "needsTitle");

  function showRows(res: { rows: PlanDraftRow[]; usesRelativeDates: boolean }, src: Source, tbl: TableState | null) {
    if (res.rows.length === 0) {
      setError("Couldn't find any videos in that. Each line or row needs at least a title — dates help too.");
      return;
    }
    setError(null);
    setSource(src);
    setTable(tbl);
    setRows(res.rows);
    setUsesRelative(res.usesRelativeDates);
    setAiNote(null);
    window.scrollTo({ top: 0 });
  }

  function fromTable(cells: string[][], src: Source, sheets?: TableState["sheets"], sheetIndex?: number) {
    const mapping = suggestTableMapping(cells);
    showRows(tableToRows(cells, mapping, ctx()), src, { cells, mapping, sheets, sheetIndex });
  }

  async function readPasted() {
    const t = text.trim();
    if (!t) return setError("Paste your plan first.");
    if (looksLikeGoogleSheetLink(t)) {
      setSheetLink(t);
      return importSheet(t);
    }
    const src: Source = { kind: "TEXT", ref: null, raw: t };
    const pastedTable = detectPastedTable(t);
    if (pastedTable) return fromTable(pastedTable, src);
    showRows(parseFreeText(t, ctx()), src, null);
  }

  async function readFile(file: File | undefined) {
    if (!file) return;
    setError(null);
    const name = file.name.toLowerCase();
    try {
      if (name.endsWith(".xlsx") || name.endsWith(".xlsm")) {
        setBusy("Reading your spreadsheet…");
        const res = await fetch("/api/plan-xlsx", { method: "PUT", body: file });
        const data = (await res.json()) as { sheets?: { name: string; rows: string[][] }[]; error?: string };
        if (!res.ok || !data.sheets) throw new Error(data.error ?? "Couldn't read that spreadsheet.");
        const raw = JSON.stringify(data.sheets[0]!.rows).slice(0, 20000);
        fromTable(data.sheets[0]!.rows, { kind: "XLSX", ref: file.name, raw }, data.sheets, 0);
      } else if (name.endsWith(".xls") || name.endsWith(".numbers")) {
        throw new Error("That's an older Excel or a Numbers file — export it as CSV or .xlsx (File → Export) and upload that.");
      } else {
        const content = await file.text();
        if (name.endsWith(".csv") || name.endsWith(".tsv") || /^[^\n]*[,\t][^\n]*\n/.test(content)) {
          fromTable(parseDelimited(content, name.endsWith(".tsv") ? "\t" : undefined), { kind: "CSV", ref: file.name, raw: content });
        } else {
          showRows(parseFreeText(content, ctx()), { kind: "TEXT", ref: file.name, raw: content }, null);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't read that file.");
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function importSheet(link = sheetLink) {
    if (!link.trim()) return setError("Paste the sheet's link first.");
    setBusy("Opening your sheet…");
    setError(null);
    const res = await fetchGoogleSheet(link.trim());
    setBusy(null);
    if ("error" in res) return setError(res.error);
    fromTable(parseDelimited(res.csv), { kind: "GOOGLE_SHEETS", ref: link.trim(), raw: res.csv });
  }

  function remap(col: number, field: ColumnField) {
    if (!table || !source) return;
    const fields = [...table.mapping.fields];
    fields[col] = field;
    const mapping = { ...table.mapping, fields };
    const res = tableToRows(table.cells, mapping, ctx());
    setTable({ ...table, mapping });
    setRows(res.rows);
    setUsesRelative(res.usesRelativeDates);
  }

  function pickSheet(i: number) {
    if (!table?.sheets || !source) return;
    const cells = table.sheets[i]!.rows;
    fromTable(cells, { ...source, raw: JSON.stringify(cells).slice(0, 20000) }, table.sheets, i);
  }

  function changeStart(v: string) {
    setStartDate(v);
    if (rows && /^\d{4}-\d{2}-\d{2}$/.test(v)) setRows(reresolveRows(rows, ctx(v)) as Row[]);
  }

  function patch(key: string, next: Partial<Row>) {
    setRows((prev) => (prev ? prev.map((r) => (r.key === key ? { ...r, ...next } : r)) : prev));
  }

  async function aiCleanup() {
    if (!source) return;
    setBusy("Cleaning up with AI…");
    const res = await cleanUpPlanWithAi(source.raw, startDate);
    setBusy(null);
    if ("error" in res) return setAiNote(res.error);
    const aiRows: Row[] = res.result.rows.map((r, i) => ({
      key: `ai${i + 1}`,
      sourceLine: i + 1,
      title: r.title,
      dateText: r.dateText,
      spec: null,
      ymd: r.date,
      time: r.time,
      platforms: r.platforms.length ? r.platforms : [...enabledPlatforms],
      platformsDefaulted: r.platforms.length === 0,
      hook: r.hook,
      notes: r.notes,
      format: r.format,
      pillar: r.pillar,
      warnings: r.date ? [] : ["No date"],
    }));
    if (aiRows.length === 0) return setAiNote("AI couldn't find any videos either — try editing the text.");
    setRows(aiRows);
    setSource({ ...source, kind: "AI_CLEANUP" });
    setTable(null);
    setUsesRelative(false);
    setAiNote(res.result.warnings.length ? `Cleaned up with AI. ${res.result.warnings.join(" · ")}` : "Cleaned up with AI — check the rows below.");
  }

  async function create() {
    if (!source) return;
    const ok = validated.filter((r) => r.status === "ok");
    if (ok.length === 0) return;
    setBusy(`Creating ${ok.length} video${ok.length === 1 ? "" : "s"}…`);
    setError(null);
    const res = await createPlanFromImport({
      sourceKind: source.kind,
      sourceRef: source.ref,
      rawInput: source.raw,
      rows: ok.map((r) => ({
        title: r.title.trim(),
        ymd: r.ymd!,
        time: r.time,
        platforms: r.platforms.length ? r.platforms : [...enabledPlatforms],
        hook: r.hook,
        notes: r.notes,
        format: r.format,
        pillar: r.pillar,
      })),
    });
    setBusy(null);
    if ("error" in res) return setError(res.error);
    setDone(res);
    window.scrollTo({ top: 0 });
  }

  // ---------- Done ----------
  if (done) {
    return (
      <div className="panel flex flex-col items-center gap-3 px-5 py-8 text-center" data-testid="import-done">
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-[var(--color-emerald-500)]/15 text-[var(--color-emerald-400)]">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="m5 12 5 5L20 7" />
          </svg>
        </div>
        <h2 className="text-[22px] font-semibold">
          {done.alreadyImported ? "Already imported" : `${done.created} video${done.created === 1 ? "" : "s"} added to your plan`}
        </h2>
        <p className="max-w-sm text-[15px] text-[var(--color-text-muted)]">
          {done.alreadyImported
            ? "This exact plan was imported before — nothing was duplicated."
            : "They're on your calendar on their days. Film them, then upload the clips — the app matches each clip to its video."}
          {done.skipped > 0 && !done.alreadyImported && ` Skipped ${done.skipped} already planned.`}
        </p>
        {done.failed.length > 0 && (
          <p className="text-[13px] text-[var(--color-rose-400)]">
            {done.failed.length} couldn&apos;t be created: {done.failed.map((f) => f.title).join(", ")}
          </p>
        )}
        <div className="mt-2 flex w-full max-w-sm flex-col gap-2.5">
          <Link href="/plan" className="btn btn-primary w-full">
            See your plan
          </Link>
          <Link href="/plan/upload" className="btn btn-ghost w-full">
            Upload clips
          </Link>
          <Link href="/calendar?view=month" className="btn btn-ghost w-full">
            Open calendar
          </Link>
        </div>
      </div>
    );
  }

  // ---------- Preview ----------
  if (rows && source) {
    const problemKeys = new Set(needsFix.map((r) => r.key));
    const ordered = [...validated].sort((a, b) => Number(problemKeys.has(b.key)) - Number(problemKeys.has(a.key)));
    return (
      <div className="flex flex-col gap-4 pb-28">
        <section className="panel p-4" data-testid="import-summary">
          <p className="eyebrow mb-1">{sourceLabel(source)}</p>
          <p className="text-[19px] font-semibold leading-snug">{summaryLine(summary)}</p>
          <p className="mt-1 text-[13.5px] text-[var(--color-text-muted)]">
            {[
              needsFix.length ? `${needsFix.length} need${needsFix.length === 1 ? "s" : ""} a fix` : null,
              summary.duplicates ? `${summary.duplicates} already planned (skipped)` : null,
              rows.some((r) => r.dropped) ? `${rows.filter((r) => r.dropped).length} removed` : null,
            ]
              .filter(Boolean)
              .join(" · ") || "Everything looks good. Tap a video to change it."}
          </p>
          {usesRelative && (
            <label className="mt-3 flex items-center justify-between gap-3 rounded-2xl bg-white/[0.04] px-3 py-2.5">
              <span className="text-[14px]">Plan starts on (Day 1 / Week 1)</span>
              <input type="date" value={startDate} onChange={(e) => changeStart(e.target.value)} className="field-input !w-auto !min-h-[40px]" aria-label="Plan start date" />
            </label>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" className="btn btn-ghost !min-h-[38px] !text-[13px]" onClick={() => { setRows(null); setSource(null); setTable(null); }}>
              Start over
            </button>
            {(source.kind === "TEXT" || source.kind === "AI_CLEANUP") && (
              <button type="button" className="btn btn-ghost !min-h-[38px] !text-[13px]" onClick={() => void aiCleanup()} disabled={!!busy}>
                ✨ Clean up with AI
              </button>
            )}
          </div>
          {aiNote && <p className="mt-2 text-[13px] text-[var(--color-text-muted)]">{aiNote}</p>}
        </section>

        {table && (
          <details className="panel min-w-0">
            <summary className="flex min-h-[52px] cursor-pointer items-center justify-between gap-3 px-4 py-3">
              <span className="text-[15px] font-medium">Columns</span>
              <span className="truncate text-[13px] text-[var(--color-text-faint)]">
                {table.mapping.fields.filter((f) => f !== "ignore").length} matched · tap to fix
              </span>
            </summary>
            <div className="flex flex-col gap-2 px-4 pb-4">
              {table.sheets && table.sheets.length > 1 && (
                <label className="flex items-center justify-between gap-3">
                  <span className="text-[14px]">Sheet</span>
                  <select className="field-input !w-auto" value={table.sheetIndex ?? 0} onChange={(e) => pickSheet(Number(e.target.value))}>
                    {table.sheets.map((s, i) => (
                      <option key={s.name} value={i}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {columnHeaders(table).map((h, c) => (
                <label key={c} className="flex items-center justify-between gap-3">
                  <span className="min-w-0 truncate text-[14px]" title={h}>
                    {h}
                  </span>
                  <select className="field-input !w-[44%] shrink-0" value={table.mapping.fields[c] ?? "ignore"} onChange={(e) => remap(c, e.target.value as ColumnField)} aria-label={`Column ${h}`}>
                    {FIELD_OPTIONS.map((f) => (
                      <option key={f} value={f}>
                        {FIELD_LABELS[f]}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
              <p className="text-[12.5px] text-[var(--color-text-faint)]">Changing a column re-reads the sheet (row edits are reset).</p>
            </div>
          </details>
        )}

        <ul className="flex flex-col gap-2.5" data-testid="import-rows">
          {ordered.filter((r) => r.status !== "duplicate").map((r) => (
            <RowCard
              key={r.key}
              row={r}
              open={openKey === r.key}
              onToggle={() => setOpenKey(openKey === r.key ? null : r.key)}
              onPatch={(p) => patch(r.key, p)}
              defaultTime={autoTimes.get(r.key) ?? null}
            />
          ))}
        </ul>

        {summary.duplicates > 0 && (
          <details className="panel min-w-0" data-testid="import-duplicates">
            <summary className="flex min-h-[52px] cursor-pointer items-center justify-between gap-3 px-4 py-3">
              <span className="text-[15px] font-medium">Already planned</span>
              <span className="text-[13px] text-[var(--color-text-faint)]">{summary.duplicates} skipped · tap to see</span>
            </summary>
            <ul className="flex flex-col gap-2 px-3 pb-3">
              {ordered.filter((r) => r.status === "duplicate").map((r) => (
                <RowCard key={r.key} row={r} open={false} onToggle={() => undefined} onPatch={() => undefined} defaultTime={null} />
              ))}
            </ul>
          </details>
        )}

        {error && <p className="text-sm text-[var(--color-rose-400)]">{error}</p>}

        <div
          className="fixed inset-x-0 z-40 border-t border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-ink)_93%,transparent)] backdrop-blur-xl"
          style={{ bottom: "var(--tabbar-h)", paddingLeft: "var(--safe-left)", paddingRight: "var(--safe-right)" }}
        >
          <div className="mx-auto flex max-w-xl items-center gap-3 px-4 py-3">
            <p className="min-w-0 flex-1 truncate text-[13.5px] text-[var(--color-text-muted)]">
              {needsFix.length ? `Fix or remove ${needsFix.length} row${needsFix.length === 1 ? "" : "s"} to continue` : summary.count ? `${summary.count} ready to add` : "Nothing new to add"}
            </p>
            <button
              type="button"
              className="btn btn-primary shrink-0"
              disabled={!!busy || needsFix.length > 0 || summary.count === 0}
              onClick={() => void create()}
              data-testid="create-plan"
            >
              {busy ?? `Create ${summary.count} video${summary.count === 1 ? "" : "s"}`}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ---------- Source ----------
  return (
    <div className="flex flex-col gap-4">
      <p className="-mt-2 text-[15px] leading-snug text-[var(--color-text-muted)]">
        A day, a week, a month or a year — paste it, upload the spreadsheet, or share a Google Sheet. You&apos;ll check it before anything is created.
      </p>
      <div className="grid grid-cols-3 gap-1 rounded-2xl bg-white/[0.05] p-1" role="tablist">
        {(
          [
            ["paste", "Paste"],
            ["file", "File"],
            ["sheet", "Google Sheet"],
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

      {tab === "paste" && (
        <section className="panel flex flex-col gap-3 p-4">
          <label className="block">
            <span className="field-label">Paste your plan</span>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={10}
              placeholder={"From Notes, Google Docs, a spreadsheet or ChatGPT — any shape works:\n\nMon 10/19 — 5 money myths — TikTok, Reels\nTue: Why I stopped budgeting (all) 6pm\nWeek 2\nMon: How I'd invest $1000"}
              className="field-input min-h-[220px] font-[inherit] leading-snug"
              data-testid="paste-input"
            />
          </label>
          <button type="button" className="btn btn-primary w-full" onClick={() => void readPasted()} disabled={!!busy} data-testid="read-plan">
            {busy ?? "Read my plan"}
          </button>
          <p className="text-[12.5px] text-[var(--color-text-faint)]">Nothing is created until you check the preview and tap Create.</p>
        </section>
      )}

      {tab === "file" && (
        <section className="panel flex flex-col gap-3 p-4">
          <label className={`flex min-h-[150px] cursor-pointer flex-col items-center justify-center gap-2 rounded-3xl border-2 border-dashed px-4 py-6 text-center ${busy ? "opacity-60" : "border-[var(--color-gold-500)]/60 bg-[var(--color-gold-500)]/[0.08] active:bg-[var(--color-gold-500)]/15"}`}>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,.tsv,.txt,.md,.xlsx,.xlsm,.xls,.numbers,text/csv,text/plain,text/tab-separated-values,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              className="sr-only"
              disabled={!!busy}
              onChange={(e) => void readFile(e.target.files?.[0])}
              data-testid="plan-file"
            />
            <span className="text-[17px] font-semibold">{busy ?? "Choose a file"}</span>
            <span className="text-[13px] text-[var(--color-text-faint)]">Excel (.xlsx), CSV or a text file — from Files, iCloud Drive or Google Drive.</span>
          </label>
        </section>
      )}

      {tab === "sheet" && (
        <section className="panel flex flex-col gap-3 p-4">
          <label className="block">
            <span className="field-label">Google Sheets link</span>
            <input value={sheetLink} onChange={(e) => setSheetLink(e.target.value)} inputMode="url" autoCapitalize="off" autoCorrect="off" placeholder="https://docs.google.com/spreadsheets/d/…" className="field-input" />
          </label>
          <button type="button" className="btn btn-primary w-full" onClick={() => void importSheet()} disabled={!!busy}>
            {busy ?? "Import sheet"}
          </button>
          <p className="text-[12.5px] leading-snug text-[var(--color-text-faint)]">
            In Google Sheets: Share → General access → “Anyone with the link”, then copy the link. The tab you have open is the one imported.
          </p>
        </section>
      )}

      {error && (
        <p className="rounded-2xl bg-[var(--color-rose-500)]/10 px-4 py-3 text-[14px] text-[var(--color-rose-400)]" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function sourceLabel(s: Source): string {
  switch (s.kind) {
    case "XLSX":
      return `Excel · ${s.ref ?? ""}`;
    case "CSV":
      return s.ref ? `File · ${s.ref}` : "Spreadsheet";
    case "GOOGLE_SHEETS":
      return "Google Sheet";
    case "AI_CLEANUP":
      return "Cleaned up with AI";
    case "TEXT":
      return s.ref ? (s.ref.startsWith("ChatGPT conversation") ? s.ref : `File · ${s.ref}`) : "Pasted plan";
    default:
      return s.ref ? `File · ${s.ref}` : "Pasted plan";
  }
}

function columnHeaders(t: TableState): string[] {
  const width = Math.max(...t.cells.map((r) => r.length));
  const header = t.mapping.headerRow >= 0 ? t.cells[t.mapping.headerRow]! : [];
  const sample = t.cells[t.mapping.headerRow + 1] ?? [];
  return Array.from({ length: width }, (_, c) => header[c]?.trim() || (sample[c] ? `“${sample[c]!.slice(0, 24)}”` : `Column ${c + 1}`));
}

function RowCard({
  row,
  open,
  onToggle,
  onPatch,
  defaultTime,
}: {
  row: ValidatedRow;
  open: boolean;
  onToggle: () => void;
  onPatch: (p: Partial<Row>) => void;
  defaultTime: string | null;
}) {
  const problem = row.status === "needsDate" || row.status === "needsTitle";
  const dup = row.status === "duplicate";
  return (
    <li
      className={`panel overflow-hidden ${problem ? "!border-[var(--color-gold-500)]/60" : ""} ${dup ? "opacity-60" : ""}`}
      data-testid="import-row"
      data-status={row.status}
    >
      <button type="button" onClick={onToggle} className="flex w-full items-start gap-3 px-4 py-3 text-left active:bg-white/[0.03]">
        <div className="w-[68px] shrink-0 pt-0.5">
          {row.ymd ? (
            <>
              <p className="text-[13px] font-semibold leading-tight">{formatYmdShort(row.ymd).split(" ")[0]}</p>
              <p className="text-[15px] font-semibold leading-tight">{formatYmdShort(row.ymd, false)}</p>
              <p className="mt-0.5 text-[11.5px] text-[var(--color-text-faint)]">{row.time ? formatTime12(row.time) : defaultTime ? formatTime12(defaultTime) : ""}</p>
            </>
          ) : (
            <p className="rounded-lg bg-[var(--color-gold-500)]/15 px-1.5 py-1 text-center text-[12px] font-semibold text-[var(--color-gold-400)]">No date</p>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className={`text-[15.5px] font-medium leading-snug ${row.title ? "" : "italic text-[var(--color-text-faint)]"}`}>{row.title || "No title"}</p>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            {row.platforms.map((p) => (
              <span key={p} className="rounded-full bg-white/[0.07] px-2 py-0.5 text-[11.5px] text-[var(--color-text-muted)]">
                {PLATFORM_CHIPS.find((c) => c.p === p)?.label}
              </span>
            ))}
            {dup && <span className="badge badge-neutral">Already planned — skipped</span>}
          </div>
          {row.hook && !open && <p className="mt-1 line-clamp-1 text-[13px] text-[var(--color-text-muted)]">“{row.hook}”</p>}
          {row.warnings.length > 0 && !dup && (
            <p className={`mt-1 text-[12.5px] ${problem ? "text-[var(--color-gold-400)]" : "text-[var(--color-text-faint)]"}`}>{row.warnings.join(" · ")}</p>
          )}
        </div>
      </button>
      {open && (
        <div className="flex flex-col gap-3 border-t border-[var(--color-border)] px-4 py-3">
          <label className="block">
            <span className="field-label">Title</span>
            <input className="field-input" value={row.title} onChange={(e) => onPatch({ title: e.target.value })} />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="field-label">Day</span>
              <input
                type="date"
                className="field-input"
                value={row.ymd ?? ""}
                onChange={(e) => onPatch({ ymd: e.target.value || null, spec: null, warnings: row.warnings.filter((w) => !/date|day/i.test(w)) })}
                data-testid="row-date"
              />
            </label>
            <label className="block">
              <span className="field-label">Time</span>
              <input type="time" className="field-input" value={row.time ?? ""} placeholder={defaultTime ?? ""} onChange={(e) => onPatch({ time: e.target.value || null })} />
            </label>
          </div>
          <div>
            <span className="field-label">Post on</span>
            <div className="mt-1 flex gap-2">
              {PLATFORM_CHIPS.map(({ p, label }) => {
                const on = row.platforms.includes(p);
                return (
                  <button
                    key={p}
                    type="button"
                    aria-pressed={on}
                    onClick={() => {
                      const next = on ? row.platforms.filter((x) => x !== p) : [...row.platforms, p];
                      if (next.length) onPatch({ platforms: next, platformsDefaulted: false });
                    }}
                    className={`min-h-[40px] flex-1 rounded-full border text-[14px] ${on ? "border-[var(--color-gold-500)] bg-[var(--color-gold-500)]/15 text-[var(--color-gold-400)]" : "border-[var(--color-border)] text-[var(--color-text-muted)]"}`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>
          <label className="block">
            <span className="field-label">Hook</span>
            <input className="field-input" value={row.hook ?? ""} onChange={(e) => onPatch({ hook: e.target.value || null })} />
          </label>
          <label className="block">
            <span className="field-label">Notes</span>
            <textarea className="field-input min-h-[72px]" value={row.notes ?? ""} onChange={(e) => onPatch({ notes: e.target.value || null })} />
          </label>
          <div className="flex gap-2">
            <button type="button" className="btn btn-ghost flex-1" onClick={onToggle}>
              Done
            </button>
            <button type="button" className="btn btn-danger flex-1" onClick={() => onPatch({ dropped: true })} data-testid="row-remove">
              Remove
            </button>
          </div>
        </div>
      )}
    </li>
  );
}
