import { z } from "zod";

/**
 * What /api/editor-health accepts (docs/decisions-pending/editor-rebuild.md): the editor health
 * report (lib/editor/health.ts) — numbers, short strings, small arrays. No field can carry media,
 * titles or transcript text of any size.
 */
const Scalar = z.union([z.string().max(300), z.number(), z.boolean(), z.null()]);
const Bag = z.record(z.string().max(40), Scalar);

export const EditorHealthReportSchema = z.object({
  v: z.literal(1),
  kind: z.enum(["session", "glitch"]),
  sessionId: z.string().min(4).max(64),
  contentItemId: z.string().max(64).nullable(),
  engine: z.string().max(32).nullable(),
  engineInfo: Bag,
  device: Bag,
  edit: Bag,
  marks: z.record(z.string().max(40), z.number()),
  totals: z.record(z.string().max(40), z.union([z.number(), z.null()])),
  fps: z.array(z.number()).max(200),
  memMB: z.number().nullable(),
  errors: z.array(z.string().max(300)).max(20),
  events: z.array(z.object({ t: z.number(), type: z.string().max(24), data: Bag.optional() })).max(400),
  note: z.string().max(300).optional(),
});

export type ParsedEditorHealthReport = z.infer<typeof EditorHealthReportSchema>;
