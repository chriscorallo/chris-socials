import type { ComponentType } from "react";
import { GRAPHIC_COMPONENT_SPECS, isFullScreenGraphic, type GraphicComponent } from "@chris/media/timeline";
import type { TemplateComponentProps } from "../templates/types";
import { canvasUnit } from "../../timing";
import { makeCtx, prog, rgba, mix, type GCtx } from "./kit";
import { BigNumber, Formula, MonthGrid, StatTiles, ValueColumns } from "./money";
import { GRAPHIC_EXTRA_COMPONENTS } from "./registry";

/**
 * `GRAPHIC` template: dispatches to the base component, inside its designed box (overlay) or
 * centred on a full-screen scene with its own backdrop (`screen: "FULL"`, and TRANSITION).
 */
const CORE: Partial<Record<GraphicComponent, ComponentType<{ ctx: GCtx }>>> = {
  VALUE_COLUMNS: ValueColumns,
  MONTH_GRID: MonthGrid,
  STAT_TILES: StatTiles,
  BIG_NUMBER: BigNumber,
  FORMULA: Formula,
};

export function graphicComponentFor(c: GraphicComponent): ComponentType<{ ctx: GCtx }> | null {
  return CORE[c] ?? GRAPHIC_EXTRA_COMPONENTS[c] ?? null;
}

export function GraphicTemplate(tp: TemplateComponentProps<"GRAPHIC">) {
  const ctx = makeCtx(tp);
  const Comp = graphicComponentFor(tp.props.component);
  if (!Comp) return null;
  if (!isFullScreenGraphic(tp.props)) return <Comp ctx={ctx} />;
  if (GRAPHIC_COMPONENT_SPECS[tp.props.component].kind === "FULL_FRAME") {
    // Full-frame by design (transitions): draws in canvas space at 1080-wide design units.
    const unit = canvasUnit(tp.canvas);
    return (
      <div style={{ position: "absolute", left: 0, top: 0, width: 1080, height: tp.canvas.height / unit, transform: `scale(${unit})`, transformOrigin: "0 0" }}>
        <Comp ctx={{ ...ctx, width: 1080, height: tp.canvas.height / unit }} />
      </div>
    );
  }
  return <FullScreen tp={tp} ctx={ctx} Comp={Comp} />;
}

/** A full-screen scene: deep backdrop + vignette + a soft accent bloom, content centred. */
function FullScreen({ tp, ctx, Comp }: { tp: TemplateComponentProps<"GRAPHIC">; ctx: GCtx; Comp: ComponentType<{ ctx: GCtx }> }) {
  const { canvas } = tp;
  const unit = canvasUnit(canvas);
  const margin = 54 * unit;
  const fit = Math.min((canvas.width - 2 * margin) / ctx.width, (canvas.height * 0.84) / ctx.height);
  const scale = Math.min(fit, unit * 1.08);
  const w = ctx.width * scale;
  const h = ctx.height * scale;
  const t = prog(tp.frame, 0, Math.round(0.5 * tp.fps), ctx.ease);
  const p = ctx.p;
  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <div style={{ position: "absolute", inset: 0, opacity: t, background: `linear-gradient(180deg, ${mix("#0B0B12", p.secondary, 0.06)} 0%, #09090E 48%, ${mix("#07070B", p.primary, 0.04)} 100%)` }} />
      <div style={{ position: "absolute", inset: 0, opacity: t * 0.9, background: `radial-gradient(ellipse 70% 38% at 50% 18%, ${rgba(p.primary, 0.12)} 0%, transparent 70%), radial-gradient(ellipse 80% 40% at 50% 100%, ${rgba(p.secondary, 0.1)} 0%, transparent 70%)` }} />
      <div style={{ position: "absolute", inset: 0, opacity: t * 0.5, backgroundImage: `linear-gradient(${rgba("#FFFFFF", 0.025)} 1.5px, transparent 1.5px), linear-gradient(90deg, ${rgba("#FFFFFF", 0.025)} 1.5px, transparent 1.5px)`, backgroundSize: `${Math.round(72 * unit)}px ${Math.round(72 * unit)}px`, maskImage: "radial-gradient(ellipse 60% 55% at 50% 50%, black 30%, transparent 80%)", WebkitMaskImage: "radial-gradient(ellipse 60% 55% at 50% 50%, black 30%, transparent 80%)" }} />
      <div style={{ position: "absolute", left: (canvas.width - w) / 2, top: (canvas.height - h) / 2, width: ctx.width, height: ctx.height, transform: `scale(${scale})`, transformOrigin: "0 0" }}>
        <Comp ctx={ctx} />
      </div>
    </div>
  );
}
