import type { CSSProperties, ReactNode } from "react";
import type { MotionTemplate, SceneLook, TimelineVisual, VisualInteraction } from "@chris/media/timeline";
import { trackAt, type PlacementBox } from "../timing";

/**
 * Motion v2 — how a graphic sits IN the shot rather than on it (composition level; templates
 * are untouched apart from their timing hooks):
 *
 * - <TrackedMotion>: per-frame position/scale from `VisualInteraction.track` (subject anchor +
 *   camera coupling, computed by @chris/media's pure `visualMotionTrack`, identical in preview).
 * - <SceneIntegration>: one SVG filter per graphic —
 *     scene match: white balance toward the footage's colour temperature + black-level lift;
 *     light wrap: the footage colour bleeding ~10 px into the graphic's edges (screen blend);
 *     shadow: a tight contact shadow + a soft long drop shadow, offset down-right (key light
 *     top-left), tinted with the scene's own dark tone — never pure black.
 *   plus a soft scrim behind bare type that strengthens on bright footage.
 * Every value is in the template's DESIGN px (the filter lives inside the scaled box), so it
 * scales with the graphic.
 */

const BARE_TYPE: ReadonlySet<MotionTemplate> = new Set(["KINETIC_TEXT", "NUMBER_COUNTER", "CALLOUT"]);

export { trackAt };

/** Moves/scales the whole graphic (incl. a callout's leader) to the tracked centre. */
export function TrackedMotion({ ix, frame, box, children }: { ix: VisualInteraction | null | undefined; frame: number; box: PlacementBox; children: ReactNode }) {
  const p = trackAt(ix, frame);
  if (!p) return <>{children}</>;
  const dx = Math.round((p.x - box.cx) * 10) / 10;
  const dy = Math.round((p.y - box.cy) * 10) / 10;
  const style: CSSProperties = {
    position: "absolute",
    inset: 0,
    transformOrigin: `${box.cx}px ${box.cy}px`,
    transform: `translate(${dx}px, ${dy}px) scale(${p.s})`,
  };
  return <div style={style}>{children}</div>;
}

function rgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255];
}

const f3 = (v: number) => Math.round(v * 1000) / 1000;

export interface IntegrationFlags {
  shadow: boolean;
  lightWrap: boolean;
  sceneMatch: boolean;
}

/** The SVG filter primitives for a graphic's integration (null = nothing to do). Exported for tests. */
export function integrationFilterSpec(flags: IntegrationFlags, look: SceneLook) {
  if (!flags.shadow && !flags.lightWrap && !flags.sceneMatch) return null;
  const g = flags.sceneMatch ? look.gain : { r: 1, g: 1, b: 1 };
  const lift = flags.sceneMatch ? look.lift : 0;
  const matrix = [
    [f3(g.r * (1 - lift)), 0, 0, 0, f3(lift)],
    [0, f3(g.g * (1 - lift)), 0, 0, f3(lift)],
    [0, 0, f3(g.b * (1 - lift)), 0, f3(lift)],
    [0, 0, 0, 1, 0],
  ]
    .map((r) => r.join(" "))
    .join("  ");
  return {
    matrix,
    wrap: flags.lightWrap ? { color: look.wrap.color, strength: f3(look.wrap.strength) } : null,
    shadow: flags.shadow ? { color: look.shadow.color, opacity: f3(look.shadow.opacity) } : null,
  };
}

/** Wraps a template's content in its scene-integration filter (+ scrim behind bare type). */
export function SceneIntegration({
  id,
  template,
  integration,
  look,
  children,
}: {
  id: string;
  template: MotionTemplate;
  integration: TimelineVisual["integration"] | undefined;
  look: SceneLook | undefined;
  children: ReactNode;
}) {
  const flags = integration ?? { shadow: true, lightWrap: false, sceneMatch: true };
  if (!look) return <>{children}</>;
  const spec = integrationFilterSpec(flags, look);
  if (!spec) return <>{children}</>;
  const fid = `ix-${id.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  const scrim = flags.sceneMatch && look.scrim > 0 ? (BARE_TYPE.has(template) ? look.scrim : look.scrim * 0.35) : 0;
  const [sr, sg, sb] = rgb(look.shadow.color);
  return (
    <>
      <svg width={0} height={0} style={{ position: "absolute" }} aria-hidden>
        <defs>
          <filter id={fid} x="-25%" y="-25%" width="150%" height="160%" colorInterpolationFilters="sRGB">
            <feColorMatrix in="SourceGraphic" type="matrix" values={spec.matrix} result="graded" />
            {spec.wrap ? (
              <>
                <feMorphology in="SourceAlpha" operator="erode" radius={7} result="eroded" />
                <feGaussianBlur in="eroded" stdDeviation={6} result="inner" />
                <feComposite in="SourceAlpha" in2="inner" operator="out" result="edge" />
                <feGaussianBlur in="edge" stdDeviation={2.5} result="edgeSoft" />
                <feFlood floodColor={spec.wrap.color} floodOpacity={spec.wrap.strength} result="wrapColor" />
                <feComposite in="wrapColor" in2="edgeSoft" operator="in" result="wrapLight" />
                <feBlend in="graded" in2="wrapLight" mode="screen" result="wrapped0" />
                <feComposite in="wrapped0" in2="SourceAlpha" operator="in" result="wrapped" />
              </>
            ) : null}
            {spec.shadow ? (
              <>
                {/* contact: tight, close */}
                <feGaussianBlur in="SourceAlpha" stdDeviation={3} result="cBlur" />
                <feOffset in="cBlur" dx={3} dy={5} result="cOff" />
                <feColorMatrix in="cOff" type="matrix" values={`0 0 0 0 ${f3(sr)}  0 0 0 0 ${f3(sg)}  0 0 0 0 ${f3(sb)}  0 0 0 ${f3(spec.shadow.opacity * 0.9)} 0`} result="contact" />
                {/* drop: soft, long, down-right (key light top-left) */}
                <feGaussianBlur in="SourceAlpha" stdDeviation={22} result="dBlur" />
                <feOffset in="dBlur" dx={16} dy={30} result="dOff" />
                <feColorMatrix in="dOff" type="matrix" values={`0 0 0 0 ${f3(sr)}  0 0 0 0 ${f3(sg)}  0 0 0 0 ${f3(sb)}  0 0 0 ${f3(spec.shadow.opacity * 0.75)} 0`} result="drop" />
                <feMerge>
                  <feMergeNode in="drop" />
                  <feMergeNode in="contact" />
                  <feMergeNode in={spec.wrap ? "wrapped" : "graded"} />
                </feMerge>
              </>
            ) : spec.wrap ? (
              <feMerge>
                <feMergeNode in="wrapped" />
              </feMerge>
            ) : null}
          </filter>
        </defs>
      </svg>
      {scrim > 0.01 ? (
        <div
          aria-hidden
          style={{
            position: "absolute",
            inset: "-10% -8%",
            background: `radial-gradient(ellipse 50% 50% at 50% 50%, rgba(${Math.round(sr * 255 * 0.5)},${Math.round(sg * 255 * 0.5)},${Math.round(sb * 255 * 0.5)},${f3(scrim)}) 0%, rgba(0,0,0,${f3(scrim * 0.45)}) 50%, transparent 78%)`,
            filter: "blur(24px)",
          }}
        />
      ) : null}
      <div style={{ position: "absolute", inset: 0, filter: `url(#${fid})` }}>{children}</div>
    </>
  );
}
