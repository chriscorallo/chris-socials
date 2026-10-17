import { EditTimelineSchema } from "@chris/media/timeline";
import { TEMPLATE_LABEL, visualPropsProblem } from "./visuals";
import { normalizeDoc, type AssetDurations } from "./timeline-ops";
import type { EditorDoc, Selection } from "./types";

/**
 * The editor's single source of truth: the document, the selection, and undo/redo history.
 *
 * Every edit is an `apply` with a pure recipe (see timeline-ops.ts). Continuous gestures
 * (dragging a clip edge, moving a text, scrubbing a slider) pass a `coalesce` key: while
 * consecutive applies share the key they rewrite the SAME history entry, so one drag = one
 * undo step. `commit` (pointer-up / blur) ends the gesture.
 */
export interface EditorState {
  doc: EditorDoc;
  past: EditorDoc[];
  future: EditorDoc[];
  selection: Selection;
  /** Coalesce key of the gesture in progress, if any. */
  gesture: string | null;
  /** The doc as last saved to the server (for "unsaved changes"). */
  savedDoc: EditorDoc;
  durations: AssetDurations;
}

export type EditorAction =
  | { type: "apply"; recipe: (doc: EditorDoc) => EditorDoc; coalesce?: string; select?: Selection }
  | { type: "commit" }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "select"; selection: Selection }
  /** Replace the whole doc (e.g. restoring a local draft) — undoable. */
  | { type: "replace"; doc: EditorDoc }
  | { type: "markSaved"; doc?: EditorDoc };

export const HISTORY_LIMIT = 200;

export function initEditorState(doc: EditorDoc, durations: AssetDurations): EditorState {
  const normalized = normalizeDoc(doc, durations);
  return { doc: normalized, past: [], future: [], selection: null, gesture: null, savedDoc: normalized, durations };
}

function selectionStillValid(doc: EditorDoc, sel: Selection): Selection {
  if (!sel) return null;
  if (sel.kind === "clip") return doc.clips.some((c) => c.id === sel.id) ? sel : null;
  if (sel.kind === "text") return doc.texts.some((t) => t.id === sel.id) ? sel : null;
  if (sel.kind === "zoom") return doc.zooms.some((z) => z.id === sel.id) ? sel : null;
  if (sel.kind === "visual") return doc.visuals.some((v) => v.id === sel.id) ? sel : null;
  if (sel.kind === "sfx") return doc.sfx.some((x) => x.id === sel.id) ? sel : null;
  return sel;
}

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case "apply": {
      const next = normalizeDoc(action.recipe(state.doc), state.durations);
      const selection = action.select !== undefined ? action.select : selectionStillValid(next, state.selection);
      if (next === state.doc) return selection === state.selection ? state : { ...state, selection };
      const continuing = action.coalesce != null && action.coalesce === state.gesture;
      const past = continuing ? state.past : [...state.past, state.doc].slice(-HISTORY_LIMIT);
      return { ...state, doc: next, past, future: [], selection, gesture: action.coalesce ?? null };
    }
    case "commit":
      return state.gesture === null ? state : { ...state, gesture: null };
    case "undo": {
      const prev = state.past[state.past.length - 1];
      if (!prev) return state;
      return {
        ...state,
        doc: prev,
        past: state.past.slice(0, -1),
        future: [state.doc, ...state.future].slice(0, HISTORY_LIMIT),
        selection: selectionStillValid(prev, state.selection),
        gesture: null,
      };
    }
    case "redo": {
      const next = state.future[0];
      if (!next) return state;
      return {
        ...state,
        doc: next,
        past: [...state.past, state.doc].slice(-HISTORY_LIMIT),
        future: state.future.slice(1),
        selection: selectionStillValid(next, state.selection),
        gesture: null,
      };
    }
    case "select":
      return action.selection === state.selection ? state : { ...state, selection: action.selection };
    case "replace": {
      const doc = normalizeDoc(action.doc, state.durations);
      return { ...state, doc, past: [...state.past, state.doc].slice(-HISTORY_LIMIT), future: [], gesture: null, selection: null };
    }
    case "markSaved":
      return { ...state, savedDoc: action.doc ?? state.doc };
    default:
      return state;
  }
}

/** Validates the doc against the committed contract and returns the canonical timeline to save. */
export function buildSavePayload(
  doc: EditorDoc,
): { ok: true; timeline: EditorDoc; durationSeconds: number } | { ok: false; error: string } {
  const parsed = EditTimelineSchema.safeParse(doc);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { ok: false, error: first ? `${first.path.join(".") || "timeline"}: ${first.message}` : "Invalid timeline" };
  }
  // Visual props are a free-form record in the contract (validated per template); a graphic
  // that wouldn't render is caught here, with its name, instead of silently vanishing.
  for (const v of parsed.data.visuals) {
    const problem = visualPropsProblem(v);
    if (problem) return { ok: false, error: `the ${TEMPLATE_LABEL[v.template].toLowerCase()} at ${v.start.toFixed(1)}s: ${problem}` };
  }
  const durationSeconds = parsed.data.clips.reduce((s, c) => s + Math.max(0, c.sourceEnd - c.sourceStart), 0);
  return { ok: true, timeline: parsed.data, durationSeconds };
}
