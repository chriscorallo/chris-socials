import type { GraphicPreset } from "../presets";
import { classicPreset } from "./kit";

/**
 * Library 2 — new 3D objects on the classic ICON_3D template (procedurally modeled, original
 * geometry, each with a small frame-driven beat: the bulb lights, the dart lands, the lid
 * lifts, the flame flickers…). Captions are short, in Chris's voice.
 */
const O = (id: string, name: string, description: string, tags: string[], icon: string, caption: string | null, opts: Parameters<typeof classicPreset>[7] = {}) =>
  classicPreset(id, name, description, "OBJECTS_3D", ["3d", "object", ...tags], "ICON_3D", { icon, caption }, opts);

export const OBJECTS_PRESETS: GraphicPreset[] = [
  O("3d-trophy", "3D trophy", "A gold trophy spins in and a star pops on the cup.", ["trophy", "win", "winner", "award", "goal"], "TROPHY", "You earned this", { enterSfx: "SHIMMER" }),
  O("3d-rocket", "3D rocket", "A rocket launches in with a flickering thrust flame.", ["rocket", "launch", "growth", "takeoff", "startup"], "ROCKET", "Launch day", { featured: true, enterSfx: "RISER" }),
  O("3d-rocket-growth", "3D rocket — to the moon", "Rocket with a growth caption for compounding beats.", ["rocket", "launch", "growth", "stocks", "investing"], "ROCKET", "Compounding, unlocked", { enterSfx: "RISER" }),
  O("3d-lightbulb", "3D lightbulb", "A bulb flickers, then lights up with idea rays.", ["lightbulb", "idea", "big idea", "insight", "tip"], "LIGHTBULB", "Big idea", { enterSfx: "SOFT_POP" }),
  O("3d-brain", "3D brain", "A stylized brain spins in with a gentle thinking pulse.", ["brain", "think", "mindset", "psychology", "smart"], "BRAIN", "Think it through", { seconds: 4 }),
  O("3d-gift", "3D gift box", "A wrapped gift whose lid lifts with sparkles.", ["gift", "present", "bonus", "free", "reward"], "GIFT", "Free money", { enterSfx: "SOFT_POP" }),
  O("3d-key", "3D key", "A gold key twists like it just opened something.", ["key", "unlock", "secret", "access", "solution"], "KEY", "Unlock it", { enterSfx: "CLICK" }),
  O("3d-magnifier", "3D magnifying glass", "A magnifying glass sweeps, searching.", ["search", "magnifying glass", "find", "research", "fees"], "MAGNIFIER", "Find the fee", { seconds: 4 }),
  O("3d-megaphone", "3D megaphone", "A megaphone with sound waves pulsing out.", ["megaphone", "announcement", "loud", "news", "speak up"], "MEGAPHONE", "Say it louder", { enterSfx: "IMPACT" }),
  O("3d-crown", "3D crown", "A gold crown whose gems pop in one by one.", ["crown", "king", "queen", "best", "royalty"], "CROWN", "Cash is king", { enterSfx: "SHIMMER" }),
  O("3d-fire", "3D flame", "A stylized flame flickering with rising embers.", ["fire", "hot", "flame", "hot take", "trending", "burn"], "FIRE", "Hot take", { seconds: 4 }),
  O("3d-fire-burn", "3D flame — money burning", "Flame for the money-you're-burning beat.", ["fire", "burn", "waste", "money", "hot"], "FIRE", "You're burning cash", { seconds: 4 }),
  O("3d-lightning", "3D lightning bolt", "A bolt strikes in with a flash, then crackles.", ["lightning", "fast", "energy", "power", "quick tip"], "LIGHTNING", "Quick win", { enterSfx: "IMPACT" }),
  O("3d-target", "3D target + dart", "A dart flies in and lands dead center.", ["target", "goal", "bullseye", "aim", "focus"], "TARGET", "The goal", { seconds: 4, enterSfx: "WHOOSH" }),
  O("3d-laptop", "3D laptop", "A laptop opens to a glowing dashboard.", ["laptop", "computer", "work", "remote", "side hustle"], "LAPTOP", "Build in public", { seconds: 4, enterSfx: "SOFT_POP" }),
  O("3d-car", "3D car", "A sleek car rolls in, wheels turning, headlights on.", ["car", "vehicle", "payment", "lease", "auto", "personality"], "CAR", "The car payment", { featured: true, seconds: 4, enterSfx: "WHOOSH" }),
  O("3d-car-payment", "3D car — financing", "Car for the 72-month-loan beat.", ["car", "loan", "financing", "72 months", "payment"], "CAR", "72 months of this", { seconds: 4, enterSfx: "WHOOSH" }),
  O("3d-diamond", "3D diamond", "A cut gem turns and catches the light.", ["diamond", "ring", "luxury", "expensive", "status", "engagement"], "DIAMOND", "Looks rich", { seconds: 4, enterSfx: "SHIMMER" }),
  O("3d-diamond-status", "3D diamond — status", "Diamond for the looking-rich beat.", ["diamond", "status", "flex", "luxury"], "DIAMOND", "Rich on paper", { seconds: 4, enterSfx: "SHIMMER" }),
  O("3d-wallet", "3D wallet", "A leather wallet opens; the cards fan out.", ["wallet", "cash", "cards", "spending", "money", "budget"], "WALLET", "What's actually in it", { seconds: 4, enterSfx: "SOFT_POP" }),
  O("3d-wallet-empty", "3D wallet — empty", "Wallet for the end-of-month beat.", ["wallet", "empty", "broke", "end of month"], "WALLET", "By the 20th", { seconds: 4, enterSfx: "SOFT_POP" }),
  O("3d-bank", "3D bank", "A columned bank with a coin dropping in.", ["bank", "savings", "account", "deposit", "institution", "high yield"], "BANK", "Where it should sit", { seconds: 4, enterSfx: "CLICK" }),
  O("3d-bank-interest", "3D bank — interest", "Bank for the where-your-cash-earns beat.", ["bank", "interest", "apy", "savings", "yield"], "BANK", "4.3% vs 0.01%", { seconds: 4, enterSfx: "CLICK" }),
  O("3d-trophy-level-up", "3D trophy — level up", "Trophy for milestone and level-up beats.", ["trophy", "win", "level up", "milestone"], "TROPHY", "Level up", { enterSfx: "SHIMMER" }),
];
