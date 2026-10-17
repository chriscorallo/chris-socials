import type { ReactNode } from "react";
import type { MotionTemplate } from "@chris/media/timeline";

/**
 * Static thumbnails for the motion-template gallery — one small drawing per template in the
 * BRAND palette (gold primary, violet secondary). Deliberately not live Remotion players: 14
 * players (several three.js scenes) would cost an iPhone seconds and battery just to open a
 * sheet. The live preview is the graphic itself on the canvas, the moment it's inserted.
 */
const G = "#FFD54A";
const V = "#A78BFA";
const W = "rgba(255,255,255,0.85)";
const M = "rgba(255,255,255,0.35)";

const ART: Record<MotionTemplate, ReactNode> = {
  KINETIC_TEXT: (
    <>
      <text x="8" y="31" fontSize="17" fontWeight="800" fill={W} fontFamily="Inter, sans-serif">Say</text>
      <text x="8" y="44" fontSize="13" fontWeight="900" fill={G} fontFamily="Inter, sans-serif">IT!</text>
      <path d="M36 22h7M34 28h9M37 34h6" stroke={V} strokeWidth="2" strokeLinecap="round" />
    </>
  ),
  NUMBER_COUNTER: (
    <>
      <text x="24" y="31" textAnchor="middle" fontSize="18" fontWeight="900" fill={G} fontFamily="Inter, sans-serif">$1,2</text>
      <path d="M12 38h24" stroke={M} strokeWidth="2" strokeLinecap="round" />
      <path d="M38 14v8M35 17l3-3 3 3" stroke={V} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </>
  ),
  STAT_CARD: (
    <>
      <rect x="7" y="11" width="34" height="26" rx="6" fill="rgba(255,255,255,0.08)" stroke={M} />
      <text x="13" y="27" fontSize="12" fontWeight="900" fill={G} fontFamily="Inter, sans-serif">7.2%</text>
      <path d="M13 32h18" stroke={M} strokeWidth="2" strokeLinecap="round" />
      <path d="M33 22l3-4 3 4" stroke="#6EE7B0" strokeWidth="2" fill="none" strokeLinecap="round" />
    </>
  ),
  BAR_CHART: (
    <>
      <rect x="9" y="22" width="6" height="16" rx="1.5" fill={M} />
      <rect x="18" y="14" width="6" height="24" rx="1.5" fill={G} />
      <rect x="27" y="26" width="6" height="12" rx="1.5" fill={M} />
      <rect x="36" y="30" width="5" height="8" rx="1.5" fill={V} />
      <path d="M7 40h36" stroke={M} strokeWidth="1.5" />
    </>
  ),
  LINE_CHART: (
    <>
      <path d="M8 38h33M8 38V10" stroke={M} strokeWidth="1.5" />
      <path d="M9 34l8-5 7 2 7-9 9-10" stroke={G} strokeWidth="2.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="40" cy="12" r="3" fill={G} />
    </>
  ),
  COMPARISON: (
    <>
      <rect x="5" y="14" width="16" height="22" rx="4" fill="rgba(255,255,255,0.08)" stroke={G} />
      <rect x="27" y="14" width="16" height="22" rx="4" fill="rgba(255,255,255,0.08)" stroke={M} />
      <text x="24" y="28" textAnchor="middle" fontSize="7" fontWeight="800" fill={V} fontFamily="Inter, sans-serif">VS</text>
      <path d="M9 30h8M31 30h8" stroke={W} strokeWidth="2" strokeLinecap="round" />
    </>
  ),
  PERCENT_RING: (
    <>
      <circle cx="24" cy="24" r="13" stroke={M} strokeWidth="4" fill="none" />
      <path d="M24 11a13 13 0 1 1-12.4 17" stroke={G} strokeWidth="4" fill="none" strokeLinecap="round" />
      <text x="24" y="27.5" textAnchor="middle" fontSize="9" fontWeight="900" fill={W} fontFamily="Inter, sans-serif">68</text>
    </>
  ),
  LIST_STEPS: (
    <>
      {[14, 24, 34].map((y, i) => (
        <g key={y}>
          <circle cx="12" cy={y} r="3.5" fill={i === 0 ? G : M} />
          <path d={`M19 ${y}h${i === 1 ? 18 : 22}`} stroke={i === 0 ? W : M} strokeWidth="2.4" strokeLinecap="round" />
        </g>
      ))}
    </>
  ),
  ICON_3D: (
    <>
      <path d="M24 9l13 7v15l-13 7-13-7V16z" fill="rgba(255,213,74,0.18)" stroke={G} strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M11 16l13 7 13-7M24 23v15" stroke={G} strokeWidth="1.6" strokeLinejoin="round" fill="none" />
      <ellipse cx="24" cy="42" rx="11" ry="2" fill="rgba(0,0,0,0.45)" />
    </>
  ),
  MONEY_STACK_3D: (
    <>
      {[34, 28, 22, 16].map((y, i) => (
        <g key={y}>
          <path d={`M10 ${y}l14-5 14 5-14 5z`} fill={i === 3 ? "#7BD88F" : "#4FA866"} stroke="#1f5f33" strokeWidth="0.8" />
          <path d={`M10 ${y}v3l14 5 14-5v-3`} fill="#2f7d46" stroke="#1f5f33" strokeWidth="0.8" />
        </g>
      ))}
    </>
  ),
  CALLOUT: (
    <>
      <rect x="5" y="9" width="24" height="11" rx="5.5" fill={G} />
      <path d="M10 14.5h14" stroke="#1a1408" strokeWidth="2" strokeLinecap="round" />
      <path d="M22 20l10 12" stroke={W} strokeWidth="2" strokeLinecap="round" />
      <circle cx="35" cy="35" r="4.5" fill="none" stroke={G} strokeWidth="2" />
    </>
  ),
  TIMELINE: (
    <>
      <path d="M14 9v30" stroke={M} strokeWidth="2" />
      {[12, 24, 36].map((y, i) => (
        <g key={y}>
          <circle cx="14" cy={y} r="3.5" fill={i === 2 ? G : V} />
          <path d={`M21 ${y}h${i === 2 ? 20 : 15}`} stroke={i === 2 ? W : M} strokeWidth="2.4" strokeLinecap="round" />
        </g>
      ))}
    </>
  ),
  DEFINITION: (
    <>
      <text x="8" y="21" fontSize="11" fontWeight="900" fill={G} fontFamily="Inter, sans-serif">APR</text>
      <path d="M8 28h32M8 34h26M8 40h18" stroke={M} strokeWidth="2" strokeLinecap="round" />
      <path d="M33 13h7" stroke={V} strokeWidth="2" strokeLinecap="round" />
    </>
  ),
  TITLE_CARD: (
    <>
      <rect x="6" y="8" width="36" height="32" rx="4" fill="rgba(0,0,0,0.5)" stroke={M} />
      <path d="M13 23h22" stroke={W} strokeWidth="3.4" strokeLinecap="round" />
      <path d="M18 30h12" stroke={G} strokeWidth="2" strokeLinecap="round" />
    </>
  ),
};

export function TemplateArt({ template, size = 48 }: { template: MotionTemplate; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden>
      {ART[template]}
    </svg>
  );
}
