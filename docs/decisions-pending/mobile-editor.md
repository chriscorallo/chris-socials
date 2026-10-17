# Pending decisions — mobile (iPhone-first) finishing editor

To be merged into `/docs/DECISIONS.md`. Scope: `apps/web/app/content/[id]/edit/**` and
`apps/web/lib/editor/**` only (the rest of the app's mobile pass is a separate workstream).

## 2026-10-16 — The finishing editor gets a touch shell; desktop stays a ≥1024px enhancement

**Problem:** Chris edits on his iPhone. The editor was a desktop three-column workspace
(media bin | 9:16 preview | inspector, timeline below) driven by mouse and keyboard; at 393px
wide it rendered the desktop grid squeezed off-screen (baseline screenshot before this change).

**Decision:** `Editor` keeps one document/reducer/playback engine and renders one of two shells,
chosen by a media query (`layout-hooks.ts`): **desktop** at `(min-width: 1024px) and
(min-height: 560px)` (unchanged workspace), otherwise the **touch shell** (`MobileShell.tsx`) —
phones in portrait and landscape, iPad in portrait. Mobile-first: the server and the first
hydration pass render the touch shell; `useSyncExternalStore` swaps to desktop before paint.

Touch shell (CapCut / VN / Edits conventions):
- Full-screen `100dvh` app shell with `env(safe-area-inset-*)` padding; the edit route exports
  its own `viewport` (`viewportFit: "cover"`, `maximumScale: 1`, `userScalable: false`,
  dark `themeColor`) — the root layout is untouched. `html:has(.ed-root)` turns off page
  scroll/overscroll; iOS `gesturestart` is prevented so pinches never zoom the page.
- Compact top bar (back, truncated title + length/save status, Save when dirty, **Finish**),
  preview filling the upper area, transport row (time, big play, undo/redo), the timeline,
  and a bottom toolbar of 64px icon+label tools (Split, Edit, Text, Captions, Zoom, Look,
  Add clip, Cover, Platforms). Selecting something swaps the toolbar for that item's quick
  actions (clip: Split/Trim/Volume/Reframe/Duplicate/Delete; text: Edit text/Style/
  Duplicate/Delete; zoom: Adjust/Aim/Delete).
- **Timeline with a fixed centre playhead** (`MobileTimeline.tsx`): tracks scroll under it
  (native momentum scrolling = scrubbing), pinch zooms, tap selects; a selected clip grows
  20px white trim handles (`touch-action: none`) that snap to the playhead/cut points with a
  haptic tick where supported; long-press (380ms) lifts a clip to reorder it (a document-level
  non-passive `touchmove` blocks scrolling only while lifted). Text/zoom spans: tap to select,
  then drag body/handles.
- **Bottom sheets** (`Sheet.tsx`) hold the existing inspector panels: grabber + title + Done,
  half/full snap points, flick or swipe down to dismiss, transform-only animation. While a sheet
  is at half height the stage shrinks so the whole 9:16 preview and the transport stay visible
  above it. On a landscape phone sheets become a right-hand side panel.
- Inspector controls are re-laid-out for fingers under `.ed-m` (44px inputs at 16px font so iOS
  never zooms on focus, 28px slider thumbs, 36px swatches, iOS-size toggles, 40px segments).
- **Typing** a text happens in a bar docked above the keyboard (`visualViewport` inset — iOS
  overlays the keyboard rather than resizing the page); it edits the element live. Tapping a
  selected text opens it; the canvas suppresses compatibility mouse events on touch so the
  bar's field keeps focus.
- Finish & schedule becomes a near-full-screen sheet with 16px date input, 56px platform rows
  (the whole row is the checkbox's label) and a 52px primary button.

**Alternatives considered:** CSS-only responsiveness of the desktop shell (rejected: a
side-panel inspector and a left-anchored, mouse-drag timeline are the wrong interaction model
on a phone, not just the wrong size); a separate mobile route (rejected: two editors would
drift; one doc/engine/reducer is shared and every edit op is the same pure function).

**Reversibility:** high — the desktop shell is untouched except shared refactors below; the
breakpoint is one media query.

## 2026-10-16 — One multi-pointer gesture controller on the preview (mouse and touch)

**Decision:** overlays (`Overlays.tsx`) no longer attach their own window listeners; elements
carry `data-gesture`/`data-id` and the canvas (`Preview.tsx` `Canvas`) runs a single
Pointer Events controller with pointer capture and per-pointer tracking: one finger drags
(text with centre-snap guides, captions vertically, reframe pan, zoom aim), two fingers pinch
(text size, caption size, reframe zoom), re-baselining whenever a finger is added or lifted so
nothing jumps. Pinching on empty picture while a text is selected scales that text. A tap on
empty picture toggles playback on touch (selects the clip on screen with a mouse). Behaviour
change on desktop: clicking an already-selected text starts typing (double-click still works).
The pure geometry (pinch scale/translation, slop, snap) is in `lib/editor/touch-math.ts` with
unit tests.

## 2026-10-16 — Preview playback uses a fixed pool of two `<video>` elements

**Problem:** the engine mounted up to two elements per take (2 × N decoders). iOS Safari limits
concurrent hardware decoders and only lets an element play with sound once `play()` was called
on it inside a user gesture.

**Decision:** clip *i* plays on pool element *i % 2* (`lib/editor/player-pool.ts`); the engine
swaps `src` only when the take changes and applies the seek on `loadedmetadata`. The other
element is pre-rolled to the next clip's first frame, so cuts remain a visibility swap
(verified: playing across a Take 1 → Take 2 cut switches elements with the clock continuous).
`play()` is only ever called from the play tap, and in that same gesture the engine starts
(muted) and pauses the other pool element to unlock it for sound. Elements are `playsInline`,
`preload="auto"`, `disablePictureInPicture`; no `requestVideoFrameCallback` dependency.

**Known limit:** iOS ignores `HTMLMediaElement.volume` — on an iPhone the preview plays at full
volume (mute works); the clip level is applied by the renderer. The volume sheet says so.

## 2026-10-16 — Mobile visual verification ran on Chromium only

Playwright WebKit could not be installed offline in this environment, so the iPhone/iPad checks
(375×667, 393×852, 430×932, 852×393 landscape, 820×1180, plus desktop 1440×900) ran on Chromium
with `isMobile`/`hasTouch`, an iOS user agent and real CDP multi-touch (taps, swipes, pinches,
long-press). iOS-specific behaviour (keyboard/visualViewport, gesture unlock for audio, decoder
limits, safe-area insets) is implemented to the WebKit rules but **still needs a pass on a real
iPhone**. Evidence: `docs/evidence/2026-10-16-mobile/editor-*.jpg`.
