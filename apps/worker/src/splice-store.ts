import { readStoredFullEdit, readStoredStyleCut, type PrismaClient } from "@chris/domain";
import { isSpliceAnalysis, type SpliceAnalysis } from "@chris/media";

/**
 * The splice engine's voice analysis of a take, cached on the latest automatic edit of its
 * video (packages/media splice/analysis.ts; stored by style-cut-job). Null for edits made
 * before the engine existed. Read by the quality gate (free splice audit) and the render
 * (caption word times refined to the voice).
 */
export async function storedSpliceAnalysisFor(db: PrismaClient, contentItemId: string, mediaAssetId: string): Promise<SpliceAnalysis | null> {
  const plans = await db.editPlan.findMany({ where: { contentItemId }, orderBy: { createdAt: "desc" }, take: 30, select: { plan: true } });
  for (const p of plans) {
    const fe = readStoredFullEdit(p.plan);
    if (fe && fe.mediaAssetId === mediaAssetId && isSpliceAnalysis(fe.splice)) return fe.splice;
    const sc = readStoredStyleCut(p.plan);
    if (sc && sc.mediaAssetId === mediaAssetId && isSpliceAnalysis(sc.splice)) return sc.splice;
  }
  return null;
}
