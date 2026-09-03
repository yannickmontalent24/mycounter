# Handoff: mycounter — visual redesign

## Overview

A full visual re-skin of **mycounter**, an offline-first, single-purpose calorie and protein
tracker PWA (repo: `github.com/yannickmontalent24/mycounter`). The product, information
architecture, navigation and flows are unchanged — this handoff replaces the surface only:
palette, typography, iconography, component styling, texture, motion, and the empty/loading
states.

The design covers the full screen inventory (11 screens), a style tile, two alternate display-face
tiles, a component sheet, and the chosen app mark.

## About the design files

The file in this bundle is a **design reference created in HTML**. It is a prototype showing the
intended look — **not production code to copy**. The task is to recreate these designs in the
app's existing environment: plain hand-written HTML/CSS/JS with no build step, shipping as one
`css/style.css`, per the product's constraints.

Two constraints from the brief that the HTML reference deliberately violates for convenience, and
that the implementation must honour:

1. **Fonts must be self-hosted** in `fonts/` — the reference loads them from Google Fonts. Both
   families are OFL and downloadable from Google Fonts: **Hanken Grotesk** (400/500/600/700/800)
   and **Space Grotesk** (400/500/700).
2. **Styling is inline in the reference** (a requirement of the design tool). Production should
   express these as semantic CSS custom properties (see Design tokens) in `css/style.css`, so a
   dark theme is a later token swap.

## Fidelity

**High fidelity.** Colours, type sizes, weights, spacing, radii, borders and shadows are final and
exact. Recreate pixel-for-pixel at 390px width. Where the reference clips a screen at the phone's
bottom edge, that is a scroll cut — the real screen scrolls.

## Design tokens

### Colour

| Token | Hex | Use |
|---|---|---|
| `--accent` | `#A6182A` | The single accent. Ring fill, primary button, active tab, over-target, destructive |
| `--accent-press` | `#7C0F1F` | Pressed state of accent-filled controls |
| `--accent-tint` | `#FBE9EB` | Draft badge, over-target badge backgrounds |
| `--accent-tint-border` | `#E9C4C9` | Border on tinted accent surfaces |
| `--text-primary` | `#16203A` | Ink, structural fills, colour-blocked headers, protein ring |
| `--text-secondary` | `#5A6480` | Metadata, labels, secondary copy |
| `--text-tertiary` | `#98A0B5` | Disabled text, placeholder-adjacent copy, index numbers |
| `--surface` | `#EEF0F5` | Page ground (carries the grain) |
| `--raised` | `#FFFFFF` | Cards, list containers, tab bar |
| `--well` | `#E1E5EE` | Sunken fields, steppers, inset placeholders |
| `--well-strong` | `#D5DAE6` | Focused/active well (paired with `#A7B0C4` border) |
| `--line` | `#C9CFDC` | 1.5px card borders |
| `--line-soft` | `#E1E5EE` | 1px hairlines between list rows |
| `--on-dark` | `#EEF0F5` | Text/icons on navy |
| `--on-dark-dim` | `#3A4360` / `#4A5470` | Tracks and dividers on navy |
| `--canvas` | `#DDE1EA` | Design-canvas background only, not an app surface |

Rules:
- **One accent.** Crimson does accent, over-target and destructive work. Because it carries both
  "good" and "danger", **every state is paired with a glyph or label** — never colour alone.
- Navy is ink and structure, **not** a second accent.
- No amber, no teal, no fourth or fifth colour family.

### Typography

| Role | Family | Size / weight |
|---|---|---|
| Screen title | Hanken Grotesk | 26px / 800, letter-spacing −0.02em |
| Card title | Hanken Grotesk | 16px / 700 |
| List row title | Hanken Grotesk | 14–15px / 600 |
| Body | Hanken Grotesk | 14–16px / 400–500, line-height 1.5–1.55 |
| Metadata | Hanken Grotesk | 12–13px / 400–600, `--text-secondary` |
| Section label | Space Grotesk | 11px / 400, letter-spacing 0.18em, uppercase |
| Badge | Hanken Grotesk | 10–12px / 600–700 |
| Hero number | Space Grotesk | 64px / 700, letter-spacing −0.04em, line-height 1 |
| Secondary number | Space Grotesk | 38px / 700, letter-spacing −0.03em |
| Figure in row | Space Grotesk | 16–22px / 700 |
| Figure caption | Space Grotesk | 11–14px |

Rules:
- **Space Grotesk is for figures only** — numbers, units next to numbers, section labels, status-bar
  time. Never for prose. Always `font-variant-numeric: tabular-nums` on figures that change.
- Metadata is small sans, **not** mono. (This is a deliberate reversal of the old design, where mono
  was over-used and made the app read as a terminal.)
- Body text never below 14px; hero numbers must be legible at ~1m.

### Radius

Two values only: **10px** for controls (buttons, fields, chips, steppers, small tiles) and **20px**
for cards and sheets. Badges use 5–6px. Phone frames in the reference use 40px (device bezel only).

### Surface & elevation

Chosen treatment: **paper grain + inset wells**. No shadows on cards, no gradients.

- **Page**: `--surface` with a faint grain overlay. The grain is an inline SVG `feTurbulence`
  data-URI at ~0.85 baseFrequency, 3 octaves, desaturated, 0.5 opacity, tiled at 140×140. Ship it
  as a CSS custom property (`--grain`) and apply as `background-image`.
- **Raised**: `--raised` fill, `1.5px solid var(--line)`, radius 20px, **no shadow**.
- **Well** (anything typeable, scrubbable, or awaiting input): `--well` fill with
  `box-shadow: inset 0 2px 4px rgba(22,32,58,.14)`, radius 10px (20px when the well is card-sized,
  e.g. empty states).
- **Focused well**: `--well-strong` fill, `1.5px solid #A7B0C4`, `inset 0 2px 5px rgba(22,32,58,.20)`.
- **Colour-blocked headers**: meal section headers and table headers are solid `--text-primary`
  with white text — this is the main source of contrast between levels.

### Motion

| Transition | Spec |
|---|---|
| Bottom sheet in | 280ms `cubic-bezier(.32,.72,0,1)`, translateY |
| Bottom sheet out | 200ms `ease-in` |
| Ring fill | 700ms `ease-out`, once on mount (animate `stroke-dasharray`) |
| Tab change | 120ms, colour only |

`prefers-reduced-motion: reduce` → all of the above become instant opacity swaps.

### Focus

`:focus-visible` → `outline: 3px solid var(--accent); outline-offset: 2px`. Every interactive
target ≥ 44×44px; primary actions in the bottom third.

## Components

Sizes are the rendered values from the reference at 390px width.

### Hero readout
Card (raised, radius 20, padding 20) laid out `flex; align-items:center; gap:18px`.
- Ring: 112×112 SVG, `viewBox 0 0 104 104`, `r=44`, stroke-width 13, `stroke-linecap:round`,
  rotated −90° so it fills from 12 o'clock. Track `--well`; fill `--accent` (calories) or
  `--text-primary` (protein). Circumference 277 — set `stroke-dasharray="<filled> 277"`.
- Right column: section label 11px/0.16em uppercase → hero number 64px Space Grotesk → sub-line
  13px Space Grotesk `x / y unit`.
- **Protein met** is a success state: number reads `+14` with a `✓ target met` label at 14px/700 in
  `--text-primary`.
- **Over target**: number and label in `--accent` with a `▲ over` label. Never colour alone.
- **No target set**: dashed track (`stroke-dasharray="6 10"`), no fill, copy "Set a target to see
  what's left" plus a "Set targets" text action.

### Meal section
Container: raised card, radius 20, `overflow:hidden`.
- Header: `--text-primary` fill, white text, padding 12px 14px, `justify-content:space-between`.
  Left: meal name 14px/700 + subtotal 12px Space Grotesk at 0.7 opacity. Right: 30×30 add button,
  radius 8, `--accent`, `+` at 17px/700. (Enlarge to ≥44px hit area in production.)
- Entry row: padding 11px 14px, `1px solid var(--line-soft)` between rows. Name 14px/600, then a
  meta line with the amount (12px Space Grotesk `--text-secondary`) and the source badge. Right:
  kcal 16px/700 Space Grotesk over `N g P` 11px `--text-secondary`. Trailing move (`⇄`) and delete
  (`×`, `--accent`) icon buttons.
- Meal-empty placeholder: well, inset shadow, centred 14px `--text-secondary` copy
  "Nothing logged for Lunch · **add something**" with the action in accent underlined.

### Day-total strip
Raised card, radius 20, padding 14px 18px, `space-between`. Left: "Day so far" section label.
Right: two figures 19px/700 Space Grotesk with 12px `--text-secondary` units.

### Badges
Height 22–26px, padding 0 7–9px, radius 5–6px, 10–12px/600–700. **Each carries a glyph so it is
distinguishable without colour:**

| Badge | Glyph | Style |
|---|---|---|
| label | `▣` | white fill, `1.5px solid var(--text-primary)`, weight 700 |
| reference | `◨` | white fill, `1.5px solid var(--line)`, `--text-secondary` |
| estimate | `◌` | `--well` fill, **1.5px dashed** `#98A0B5`, `--text-secondary` |
| draft | `⌛` | `--accent-tint` fill, `1.5px solid var(--accent)`, accent text |
| recipe | `▤` | `--text-primary` fill, white text |
| read only | `🔒` | white fill, `1.5px solid var(--line)`, `--text-secondary` |
| offline | `⊘` | `--well` fill, `1.5px solid #98A0B5` |
| synced | `⟳` | white fill, `1.5px solid var(--text-primary)` |

Note: the glyphs above are placeholders for **in-repo SVG icons** — replace with a consistent
stroke set (1.8px, round caps) before shipping. The tab bar icons in the reference are already
inline SVG at 24×24, `stroke-width` 1.8 (inactive) / 1.9 (active), round caps, and are the
reference for stroke language.

### Buttons
- **Primary**: height 56, radius 10, `--accent`, white 17px/700, centred. Pressed `--accent-press`.
  Disabled: `--well` fill, `--text-tertiary` text, `inset 0 2px 4px rgba(22,32,58,.10)`.
- **Secondary**: height 56, radius 10, white, `1.5px solid var(--text-primary)`, 17px/700.
- **Text/link**: 14–15px/700, `--accent`, underlined. No box.
- **Compact pill**: height 44–48, padding 0 14px, white, `1.5px solid var(--line)`, 14px/600.
- **Icon button**: 44×44 (30–32px glyph box inside rows), radius 10, white, `1.5px solid var(--line)`.
- **Stepper**: well container radius 10, inset shadow; 44×44 `−` / `+` at 20–26px/700 flanking a
  centred Space Grotesk value (18px/700 inline, 34px/700 in the Log amount block).

The three-way distinction is: **button** = filled or 1.5px-bordered box, centred, 700 weight ·
**field** = sunken well, left-aligned, 400–600 weight · **link** = bare accent underlined text.

### Fields
Height 48–52, radius 10, well fill, inset shadow, padding 0 14px, 16px text. Placeholder
`--text-tertiary`. Search fields carry an 18×18 magnifier at `--text-secondary` (`--text-primary`
when filled) with 10px gap. Mono textarea: Space Grotesk 13px/1.5 in a well, radius 10, padding
12px 14px. Numeric amount field: 64px tall well, value + unit baseline-aligned, centred.

### Chips
Height 30–38 (36 typical), padding 0 12–14px, radius 10, 13–14px.
- Selected mode chip: `--text-primary` fill, white, 700.
- Unselected: white, `1.5px solid var(--line)`, `--text-secondary`, 600.
- Date/meal chip: as unselected, with a `▾` in `--text-secondary`.
- "now" marker: `--accent-tint` fill, `1.5px solid var(--accent)`, accent text 700, with a 9–11px
  `NOW` label at 0.10–0.12em tracking.

### Tab bar
Static last child of the screen column (not absolutely positioned). White, `border-top: 1.5px solid
var(--line)`, padding `8px 8px 26px` (the 26px is the home-indicator safe area — use
`env(safe-area-inset-bottom)`). Five items, `justify-content:space-around`, each a 64px-wide column
with a 24×24 SVG and an 11px label (600 inactive / 700 active). Active colour `--accent`, inactive
`--text-secondary`. Order and labels: **Today · Log · Library · Workouts · Settings**.
(Label decision: "Workouts", matching the screen title.)

### Trend chart — "route profile"
White card, radius 20, padding 18px. SVG with three 1px `--line-soft` gridlines, a 2.5px `--accent`
polyline with round joins, 3.5px white-filled accent-stroked points at intervals, and a solid 5px
accent dot on the latest reading. Axis labels 11px Space Grotesk `--text-secondary`.
Empty state: well card, 30px chart glyph in `--text-tertiary`, "Not enough data yet" 14px/600
`--text-secondary`, "Two weigh-ins draw a trend" 13px `--text-tertiary`.

### Toast
`--text-primary` fill, white text, radius 10, padding 14px 16px, `space-between`. Message 14px/600;
action ("Undo") 13px/700 in `#F0B9C0` underlined.

### Loading
- **Section**: skeleton bars — 11px tall, radius 6, `--well` fill, widths 60% / 85% / 40%. No spinner.
- **Splash**: navy full screen, app tile at 120×120 radius 26, wordmark 24px/800 `--on-dark`,
  and a 96×3 progress track (`#3A4360`) with an `--accent` fill.

### Empty state pattern
Well card (radius 20, inset shadow, padding 20–26px): optional 30px glyph, a 14px/600
`--text-secondary` line, a 13px `--text-tertiary` sub-line, and an optional accent text action.

## Screens

All at 390×844, portrait only, `viewport-fit=cover`, safe areas respected top and bottom.

### 1. Today — populated
Purpose: answer "how much can I still eat today?" in under five seconds.
Layout: status bar → header (date section label + "Today" 26px/800, right: race-countdown chip
"52 · days to race") → "Copy today for Claude" text action → scrolling column (`gap:12px`,
96px bottom padding to clear the tab bar) → tab bar.
Content: calories hero (665 left, 1,385 / 2,050, ring 187/277), protein hero (+14, ✓ target met,
139 / 125 g, full navy ring), then meal sections: **Breakfast** 382 · 38 g (Tia's Granola — No
Sugar Added 55 g / 270 / 12 g P / label; Whey isolate, vanilla 30 g / 112 / 26 g P / label),
**Lunch** 505 · 47 g (Batch A — chicken & rice 480 g / 505 / 47 g P / recipe), **Dinner** 497 · 54 g
(Grilled fish plate (restaurant) 350 g / 497 / 54 g P / estimate). Snacks (Espresso 30 ml / 1 / 0,
reference) follows below the fold.

### 2. Today — near-empty
Same header. Calories hero shows the full target (2,050) with a near-zero ring and the sub-line
"the whole day ahead"; protein hero shows 125 "g to go" with an empty track. A well card reads
"Wednesday · Pull day" / "Nothing logged yet. Start with breakfast." / "Your usual breakfast bundle
is two taps away." Two bottom-third buttons: primary "Log the usual breakfast", secondary
"Log something else".

### 3. Log entry
Header: "Log" title, then a date chip ("Wed 3 Sep ▾") and a filled meal chip ("Breakfast ▾").
Body: search field (shown filled with "gran" in the focused well treatment) → "Most logged"
section label → results. First result is the selected state: white card with a **1.5px accent
border** and a trailing accent check. Second result unselected. Third row is the escape hatch:
well card with an accent `+` tile and "Add "gran" as a new food". Then the amount card: "Amount"
label, `−` / 64px value ("55 g") / `+`, and a live macro preview strip (270 kcal · 12 g protein ·
395 kcal left) above a primary "Add to Breakfast".

### 4. Library — Foods
Header: "Library" + offline badge; mode chips Foods / Recipes / Bundles; a row of two text actions
("Paste from Claude", "Copy list for Claude"). Body: search well + "Sort" pill; a single raised card
containing six food rows (name 15px/600, per-100 figure in Space Grotesk, source badge, edit and
delete icon buttons): Tia's Granola (491 kcal · 22 g, label), Chicken breast raw (120 · 23,
reference), Basmati rice dry (349 · 8, reference), Whey isolate vanilla (373 · 87, label),
Coca-Cola (42 · 0 / 100 ml, label), Batch B — lentil dhal (draft, "— not yet weighed"). Then two
expanders: "Show all foods (48) ▾" and "Recipe ingredients (12) ▾".

### 5. Library — Recipes
Recipe cards: title 16px/700, sub-line "cooked 2,400 g · 5 portions of 480 g", `▤ recipe` badge,
a divided figure strip (505 kcal / portion, 47 g protein), then an action row: primary "Log a
portion", secondary "Cook again", edit icon button.
**Draft recipe** (Batch B — lentil dhal): "6 ingredients · cooked weight not entered", `⌛ draft`
badge, a well explaining "Weigh the batch to unlock per-portion macros. Logging is locked until
then.", and a **disabled** "🔒 Log a portion" beside a secondary "Add weight".
**Missing ingredient** state: card with "⚠ ingredient "Basmati rice dry" was deleted" in accent
600, and a "Fix" text action.

### 6. Library — Bundles
Bundle cards: name + item count, an itemised list (name · amount, right-aligned kcal), a figure
strip (382 kcal total, 38 g protein), then primary "Log all to Breakfast" + edit icon button.
Second card "Post-ride refuel" (3 items, 618 kcal, 52 g). Footer: secondary "+ New bundle".

### 7. Workouts
Header: "Workouts" + `🔒 read only` badge; phase chip "Base — build" with "6-week phase"; a week
selector of six 44×38 chips with **week 3** in the "now" treatment (stacked numeral + NOW); a
session chip row (Mon — Push / **Wed — Pull** selected / Fri — Legs).
Body: compact exercise rows (index 01 in `--text-tertiary`, name 16px/700, cue 12px, sets/reps
22px/700 Space Grotesk) with the **current** exercise expanded: navy header ("02 Chest-supported
row" + NOW in `#F0B9C0`), a 52px `4 × 8–10` readout (must read at arm's length), a demo-photo
placeholder, the instruction "Brace against the pad; drive elbows to the hip.", and a "How weeks
4–6 differ" text action. The expanded card is bordered `1.5px solid var(--accent)`.

### 8. Body weight
Sub-screen (back chevron, Settings stays lit in the tab bar). Three stat cards (67.4 latest kg /
67.9 average / −0.8 3 weeks), the route-profile chart (22 Aug → 2 Sep), a primary "Log a weight",
then an entry list (Tue 2 Sep 67.4 kg · Tue 26 Aug 67.8 · Fri 22 Aug 68.2 · Fri 15 Aug 68.1), each
row tappable to edit.

### 9. Settings
Sectioned list under section labels. **Daily targets**: a table with a navy header row
(Weekday / kcal / protein) and per-weekday rows whose figures are wells (Wed shown focused);
"Show all seven days" text action. **Date overrides**: "Sat 25 Oct — race day · 3,200 kcal · 140 g"
with a delete `×`, plus an "Add an override" row with an accent `+` tile. **Data & account**:
Body weight (67.9 avg ›), View history ›, Export JSON ›, and "Signed in as yannick" with a
`⟳ synced` badge and a "Log out" text action.

### 10. History
Sub-screen. Header: back chevron, "History", `🔒 read only` badge; then a "Jump to a date ▾" well
and a "Copy range" secondary button. Body: day cards — date 15px/700, a status label, a divider,
two figures and a diff. Under-target days show the diff in `--text-secondary` ("−145"); the
**over-target** day (Mon 1 Sep, 2,230 kcal / 141 g, +180) is bordered `1.5px solid var(--accent)`
with a "▲ over target" label and an accent diff. Footer: an empty-state well, "Nothing logged
before 15 Aug / That is where your log starts".

### 11. Login and Splash
**Login**: centred column — app tile 96×96 radius 22, wordmark 24px/800, then a raised card with
labelled Email and Password wells, a primary "Sign in", and the note "The first sign-in needs a
connection. After that the app works offline."
**Splash**: navy full-bleed, tile 120×120 radius 26, wordmark in `--on-dark`, 96×3 progress track.

## Not yet designed

The brief also calls for the **bottom-sheet set** (add/edit food with the source selector, paste
from Claude with its review list, filter & sort, recipe builder, log a weight, meal picker) and a
consolidated **states artboard**. These are not in this bundle. The sheet pattern itself is fixed:
slides up from the edge, drag handle, dismissed by dragging down or tapping the backdrop — build to
the motion spec above.

## Interactions & behaviour

- **Tabs**: five-way switch, colour-only transition at 120ms. History and Body weight are
  sub-screens reached from Settings; **Settings stays lit** while they are open.
- **Rings** animate their fill once on mount over 700ms `ease-out`.
- **Sheets** are the only modal surface; all secondary flows use them.
- **Logging** is one tap from a bundle ("Log all"), two from a recipe ("Log a portion"), and
  search → amount → add from the Log tab.
- **Draft recipes cannot be logged** — the primary action is disabled until a cooked weight exists.
- **Offline** is surfaced as a badge in the screen header, not a blocking state. No runtime network
  dependency anywhere.
- **Backdating** is via the date chip in the Log header.

## State

Unchanged from the current app. The redesign adds no new state. The only new derived value is the
**days-to-race countdown** on the Today header (target date 25 Oct 2026 — currently sourced from
the date-specific override; make it a single configured date).

## Assets

- `assets/logo-bike.png` — the app mark, **supplied by the user**: black road-bike silhouette whose
  front wheel is the counter ring (navy track, crimson arc), on a white rounded-square tile.
  1024×1024 raster. Used for the app icon, splash and login.
- `assets/logo-mark.png` — the same artwork trimmed to its bounding box with the white plate knocked
  out to transparency (724×444), for in-UI lockups.
- **Recommendation**: commission or trace a **vector (SVG)** version before shipping the app icon —
  the current asset is raster and will not scale cleanly across iOS icon sizes.
- Tab-bar icons are inline SVG in the reference and can be lifted directly.
- The Workouts demo image is a **striped placeholder** — real exercise photography is needed.
- No other imagery. Fonts: Hanken Grotesk + Space Grotesk, both to be self-hosted.

## Files

- `Calories Counter Redesign.dc.html` — the full design canvas. Sections top to bottom:
  Turn 3 (the seven remaining screens), Turn 2 (four logo directions; **2d is the chosen mark**),
  Turn 1 (style tile `1a`, alternate display-face tiles `1b`, component sheet `1c`, and the first
  four screens `1d`: Today populated, Today near-empty, Log, Library Foods).
- `assets/logo-bike.png`, `assets/logo-mark.png` — the mark.

Each phone frame carries a `data-screen-label` attribute naming the screen, which is the quickest
way to navigate the file.
