# Design Brief — Full visual redesign

**For use in:** Claude Design (multi-artboard canvas)
**Companion to:** `calorietrackerbrief.md` v1.1 (product), `README.md` (architecture), the app itself
at `github.com/yannickmontalent24/mycounter`
**Matches app behaviour as of:** the Library-merge / meal-bundles release (Sept 2026)
**Type of change:** new visual identity, same product. See §3 for exactly what is and isn't on the table.

---

## 1. What this brief is for

The app works. Its information architecture is settled, its flows are tuned, and two people use
it every day. What it lacks is a **visual identity**. The current styling is competent but
generic — flat cards, one navy, one teal, a mono font doing a lot of work — and it reads as a
utility someone wired up, not as a considered product.

This redesign keeps every screen, every flow, and the navigation exactly where they are, and
replaces the surface: palette, typography, iconography, component styling, texture, motion, and
the overall mood. The output should feel **designed on purpose** — warm, confident, tactile —
while staying a fast one-handed instrument, not a lifestyle app.

**Deliverable:** a Claude Design canvas containing a style tile, a component sheet, and every
screen listed in §9, each in its realistic populated state plus the empty/loading states called
out. See §12.

---

## 2. The product in one paragraph

A single-purpose, offline-first PWA that answers one question: **"how much can I still eat
today?"** You log what you eat against a per-weekday calorie and protein target; the Today
screen shows how much of each is left. There is no backend, no barcode scanner, and no food
database — new foods enter by hand or by pasting JSON that Claude generated in a separate
conversation. It also carries a body-weight log with a trend chart and a read-only gym
programme. It is installed to the iPhone home screen and used at a kitchen counter, phone in
one hand.

---

## 3. What is NOT changing

Treat these as fixed. A design that breaks one of them is wrong, however good it looks.

| Area | Constraint |
|---|---|
| **Platform** | Portrait-only, phone-width (iPhone). No landscape, no tablet, no desktop layout. `viewport-fit=cover`; respect `env(safe-area-inset-*)` top and bottom. |
| **Navigation** | A fixed bottom tab bar with **5 tabs**: Today, Log, Library, Gym, Settings. History and Body weight are sub-screens reached from Settings (no tab of their own — Settings stays lit while they're open). |
| **Screen inventory** | The 9 screens in §9. No screens added or removed. |
| **Overlays** | Secondary flows (add/edit food, recipe builder, bundle builder, paste-from-Claude, filter & sort, log a weight, export range, meal picker) all open as a **bottom sheet** that slides up from the edge, has a drag handle, and is dismissed by dragging down or tapping the backdrop. Keep this pattern. |
| **Offline** | No runtime network dependency. Fonts are **self-hosted** (`fonts/`), not loaded from Google Fonts. Any icon set must ship in-repo (inline SVG preferred). No CDN anything. |
| **Build** | Plain HTML/CSS/JS, no build step. The redesign ships as hand-written CSS in one `css/style.css`. Assume no Tailwind, no PostCSS, no framework. |
| **Theme** | **Light only** for this pass. But define colour as semantic tokens (`--surface`, `--text-primary`, `--accent`, …) rather than raw hex scattered through components, so a dark theme is a later token swap, not a rewrite. |
| **Accessibility** | Every interactive target ≥ 44×44 px. Never signal state (over/under target, food provenance, draft, meal) **by colour alone** — pair it with a glyph, label, or shape. Visible `:focus-visible` ring. Honour `prefers-reduced-motion`. Body text ≥ 14 px; the primary numbers much larger. |
| **Content truthfulness** | The UI must keep surfacing the `source` badge (label / reference / estimate) on every food, and the `draft` marker on unweighed recipes. These distinctions are load-bearing — see the product brief §4. Don't design them away for tidiness. |

---

## 4. What IS changing — the ask

Everything on the surface:

- **Palette** — a new, distinctive colour system. The current navy/teal is generic; replace it.
- **Typography** — new typeface pairing (self-hostable — see §8), a real type scale, and a
  clear rule for where a numeric/tabular face is used vs. prose.
- **The hero** — the two Today rings are the emotional centre of the app. Redesign them into
  something you'd want to open the app to look at.
- **Components** — cards, list rows, chips, buttons, fields, badges, the tab bar, bottom
  sheets, the trend chart. One coherent set, documented.
- **Texture & depth** — the current flat-card-on-off-white look is the main reason it reads as
  bland. Introduce a considered approach to elevation, edges, and surface (shadow? inset?
  border weight? paper texture? colour blocking?) — pick one idea and commit.
- **Iconography** — the tab bar currently uses lone Unicode glyphs (`◎ ⊕ ▤ ◫ ⚙`). Replace with
  a proper icon set (consistent stroke, ships as SVG).
- **Motion** — define the two or three transitions that matter (sheet in/out, ring fill, tab
  change) with real easing and duration, reduced-motion fallbacks stated.
- **Empty, loading, and error states** — currently an afterthought (a bare "—", a spinner and
  "Loading…"). Design them.

---

## 5. Who uses it, and where

Two people share the app (separate logs, shared food library). The primary user:

- In a **calorie deficit** with a **protein target of 110–135 g/day**, training for a race on
  **25 Oct 2026**. Protein-left and calories-left are the numbers that matter most.
- **Batch-cooks on Sundays** — logs the same recipe portions repeatedly through the week.
- **Lactose intolerant, no spicy food, legumes limited.** (Shapes food suggestions, not the UI.)
- **In Mauritius.** Warm climate. Not a cold-Scandinavian-minimalism context — a bit of warmth
  and colour is welcome.
- Logs standing in the kitchen, phone in one hand, often mid-task. Also opens it **at the gym**
  for the workout screen. Sometimes logs a day late (backdating).

Design for **speed, glance-ability, and one thumb.** The person opening this has 5 seconds and
a specific question.

---

## 6. Design principles

1. **An instrument, not a dashboard.** One primary number per screen, stated big. Everything
   else is support. Resist the urge to show more just because there's room.
2. **Calm, but not cold.** The old design mistook "restrained" for "grey." Keep the restraint;
   add warmth, a point of view, one confident accent.
3. **The number is the hero.** Calories-left and protein-left should be legible across the
   kitchen. Use a face and size that make them feel like a readout.
4. **Honest about confidence.** A day built from `label` foods and one built from `estimate`
   foods are not equally trustworthy, and the design must let that show — never flatten it.
5. **Thumb-first.** Primary actions in the bottom third. Nothing critical in a top corner.
6. **Degrade gracefully.** Empty library, no target set, offline, a recipe with a missing
   ingredient — all real. Each needs a designed state, not a blank.

---

## 7. Current design audit

### What exists today

- **Palette:** `--navy #14213D` (primary/ink), `--teal #0E6A70` (accent/protein/links),
  `--amber #8A5A0B` (dates, drafts, offline), `--red #A4262C` (delete, over-target), plus tint
  backgrounds and borders for each. Surface `#FAFAF7` off-white, raised `#FFFFFF`.
- **Type:** IBM Plex Sans (400/500/600) for everything; IBM Plex Mono (400/500/600) for all
  numbers, units, badges, and metadata. Screen titles 1.625rem/600. Hero number 2.125rem mono.
- **Components:** rounded cards (18px radius) with a flat 2-stop vertical gradient and a 1px
  tint border; list rows separated by hairlines; pill chips; a navy filled primary button
  (60px tall, 16px radius), a navy-outline secondary, a teal underlined "link" button; a
  bottom-sheet modal; SVG progress rings on Today; an inline SVG line chart for weight.
- **Tab bar:** 5 items, off-white sunken bar, active tab is a filled navy rounded rectangle
  with a mono `━` indicator underneath.
- **Rule currently enforced:** button = coloured border + 600 weight + centred label + big
  radius; field = grey border + 400 weight + left-aligned + tighter radius; link = teal
  underlined text. Keep an equally clear three-way distinction in the new system.

### What's tired and should go

- **Two-stop gradients on every card.** Reads as 2015. Pick a flatter or more deliberate
  surface treatment.
- **Mono font over-used.** Every badge, every unit, every date in mono makes the app look like
  a terminal. Reserve the numeric face for actual figures; let metadata be small sans.
- **Unicode-glyph icons** in the tab bar and buttons (`▾ ⇄ ✎ × ➜ ◎ ⊕`). Inconsistent weights,
  render differently per device. Replace wholesale.
- **Colour-coded everything** (navy things, teal things, amber things, red things) with no
  hierarchy between them — four accent families competing. The new palette should have **one**
  accent, plus a semantic red for destructive/over, plus neutrals.
- **Flat off-white everywhere** with hairline separators — the reason the whole thing feels
  bland. Needs contrast between surface levels, or colour blocking, or texture.
- **Empty states:** a literal "—" character. **Loading:** a spinner + "Loading…". Both need
  designing.

---

## 8. The new identity — direction

The user's call: **new visual identity, keep the bones.** Character to aim for:

> A well-made analog kitchen tool. Warm, tactile, confident, a little editorial. Think a good
> enamel scale or a Braun kitchen timer, not a fitness dashboard. Precise without being clinical.

**Recommended starting direction (render this as the primary style tile):**

- **Accent:** one saturated, slightly unexpected colour — a burnt orange / terracotta, or a
  deep chartreuse, or an ink blue that isn't navy. Warm-leaning. Used sparingly: the ring
  fill, the primary button, the active tab, one or two highlights per screen.
- **Neutrals:** a warm paper base (not grey-white), a distinctly darker raised surface or a
  distinctly darker page — commit to real contrast between levels — and a near-black warm ink
  for text (not pure `#000`).
- **Semantic red** for destructive actions and over-target only. No amber, no teal as separate
  families — fold "dates/drafts" into a single neutral-plus-glyph treatment.
- **Type:** a characterful humanist or transitional serif or grotesque for display (screen
  titles, hero labels) paired with a clean neutral sans for body, and **one** tabular-figure
  face for numbers. All three must be free and self-hostable (e.g. from the open-source
  families: Fraunces, Newsreader, Instrument Serif, Hanken Grotesk, Inter, Söhne-allikes,
  Commit Mono, IBM Plex Mono). Name the exact families and weights in the style tile.
- **Surface treatment:** pick ONE — (a) soft long shadows on a warm ground, (b) hard 1.5px
  borders with no shadow and colour-blocked headers, or (c) subtle paper grain + inset wells.
  Show the chosen one; you may show one alternate for comparison.
- **Corners:** choose a radius language and hold it (the current mix of 8/10/12/14/16/18/20 is
  noise). Suggest two values: a small one for controls, a large one for cards/sheets.

**Also render, smaller, on the canvas:** two alternate palette+type directions as compact
style tiles, so the user can compare before the full screen set is committed. Don't design all
screens three times — one recommended direction fully, two as tiles.

---

## 9. Screens to design (artboards)

Each at 390×844 (iPhone 14/15) unless noted. Show each in the **state described**, using the
sample content in §11.

1. **Today — populated.** Two hero readouts (calories left, protein left) with progress
   indicators; a per-meal breakdown (Breakfast / Lunch / Dinner / Snacks) with entries under
   each and a per-meal add control; a running day total; a "Copy today for Claude" action.
   Show: calories comfortably under target, protein slightly under, a mix of `label` and
   `estimate` foods visible, one recipe portion among the entries.
2. **Today — near-empty.** Target set, nothing logged yet. This is the first screen every
   morning — it should still feel good, not barren.
3. **Log entry.** A date chip + meal chip in the header; a food search field; a results list
   (showing "most logged" leading, plus an inline "add as new food" row when the query matches
   nothing); an amount stepper (−/+ with a large numeric field, unit g or ml); a live
   macro preview of the current draft; a primary "Add to today" button.
4. **Library — Foods.** Mode chips (Foods / Recipes / Bundles); a row of "Paste from Claude" /
   "Copy list for Claude" text actions at the top; a search field + "Filter & sort" button;
   a **short** list of foods (≈6) each with name, per-100 figure, a **source badge**
   (label/reference/estimate), edit + delete; a "Show all foods (N)" expander; a "Recipe
   ingredients (N)" expander below. Show one draft-tagged item.
5. **Library — Recipes.** List of recipes with derived per-portion macros, a portion-count,
   a "Log a portion" primary action per card, edit, "Cook this again". Show one `draft` recipe
   (no cooked weight yet) in its locked state.
6. **Library — Bundles.** Groups of foods logged together in one tap ("usual breakfast"). List
   with item count + combined macros + a "Log all" action.
7. **Gym (Workouts).** Read-only programme. Phase name chip; a Week selector (chips, "now"
   marked); a Session selector (chips); then exercise cards — index number, name, an optional
   demo image, a large sets/reps readout (must be readable at arm's length mid-set),
   instructions, links to how other weeks differ.
8. **Body weight.** Three summary stats (average / latest / change); a line chart of the trend;
   a "Log a weight" action; a list of past entries (date + weight), each tappable to edit.
9. **Settings.** Sectioned list: Daily targets (per-weekday calorie + protein inputs);
   Date-specific overrides (+ add); Body weight (average + open log); Data (view history,
   export JSON); Account (signed-in-as, connection status badge, log out).
10. **History** (sub-screen). "read only" marker; a date picker to jump to a day; "Copy a date
    range for Claude"; a list of day cards (date, totals, diff vs. target).
11. **Login / gate.** A single card: title, email, password, sign-in button, a one-line note
    that first sign-in needs a connection. Also design the **splash** (app icon + loader) it
    sits behind.

### Bottom-sheet variants (design as a set, one artboard each or stacked)

- **Add / edit food** — name, unit (g/ml), per-100 figures, default portion, source selector,
  tags. The `source` selector is important: make picking label/reference/estimate feel
  deliberate.
- **Paste from Claude** — a mono textarea, "Paste from clipboard" button, then a **review
  list** showing each pasted item as `new` or `already in library` with Skip/Replace per clash.
- **Filter & sort** (Foods) — sort options, source filter, tag filter, as chip rows; Reset / Done.
- **Recipe builder** — ingredient rows (food picker + grams), cooked batch weight, portions,
  a "New food" escape hatch; the draft case (empty cooked weight) explicitly allowed here.
- **Log a weight** — date + weight, delete if editing.
- **Meal picker** — "move this entry to which meal", 4 large targets.

### States to include somewhere on the canvas

- Empty library ("No foods yet") · target not set on Today · offline badge · a day card whose
  totals are **over** target · a recipe row with a missing ingredient · the `:focus-visible`
  ring on a control · a toast.

---

## 10. Component inventory to redesign

Deliver these on a component sheet, each with its states (default / hover-or-press / disabled /
focus where relevant):

- Hero readout (the ring/gauge + number + "left" state + "x / y" sub-line), calories and protein variants
- Screen title row (title + optional right-side chip/button)
- List row — entry (name, detail, kcal, protein, delete, move) and food (name, per-100, badge, edit, delete)
- Meal section header (label, subtotal, add button) + meal-empty placeholder
- Day-total strip
- Chips — mode chip, tag/filter chip (selectable), date chip, meal chip, "now" marker
- Buttons — primary, secondary, text/link, compact pill (e.g. "Filter & sort"), small icon button, stepper (−/+)
- Text field, textarea (mono), numeric amount field with unit
- Badges — `source` (label / reference / estimate), `draft`, `recipe`, `read only`, sync/offline
- Bottom sheet — handle, header, body, action row; backdrop
- Tab bar — 5 items, active + inactive, with new icons
- Trend chart — axes, line, point, empty ("not enough data")
- Toast
- Section label (the small uppercase caption used throughout)
- Loading — section-level and full-screen splash
- Empty state — generic pattern (icon + line + optional action)

---

## 11. Sample content for mockups

Use real, consistent data — no lorem, no round-number fantasies.

**Today (populated), targets 2,050 kcal / 125 g protein:**

| Meal | Entry | Amount | kcal | protein | source |
|---|---|---|---|---|---|
| Breakfast | Tia's Granola — No Sugar Added | 55 g | 270 | 12 | label |
| Breakfast | Whey isolate, vanilla | 30 g | 112 | 26 | label |
| Lunch | Batch A — chicken & rice (recipe portion) | 480 g | 505 | 47 | — |
| Dinner | Grilled fish plate (restaurant) | 350 g | 497 | 54 | estimate |
| Snacks | Espresso | 30 ml | 1 | 0 | reference |

Day so far: **1,385 kcal · 139 g** → **665 kcal left**, **protein target met (+14 g)**.
(Protein over is a *good* state here — design it as success, not error.)

**Library foods:** Tia's Granola (label), Chicken breast raw (reference), Basmati rice dry
(reference), Whey isolate vanilla (label), Coca-Cola (label, ml), Espresso (reference, ml),
"Batch B — lentil dhal" (recipe, **draft** — not yet weighed).

**Body weight:** latest 67.4 kg, average 67.9 kg, change −0.8 kg over 3 weeks. Entries roughly
weekly from 68.2 kg on 22 Aug 2026.

**Gym:** phase "Base — build", Week 3 of 6 ("now"), session "Wed — Pull". Exercise 2:
"Chest-supported row", 4 × 8–10, "Brace against the pad; drive elbows to the hip."

**Header date:** "Wed 3 Sep". **Account:** signed in as `yannick`, connection "synced".

---

## 12. Deliverables

On one Claude Design canvas:

1. **Style tile** (recommended direction) — palette with token names + hex, type families +
   the full scale + usage rules, radius language, surface/elevation treatment, motion specs.
2. **Two alternate style tiles** — compact, palette + type only, for comparison.
3. **Component sheet** — everything in §10, in its states.
4. **The 11 screens** in §9, in the specified states.
5. **The bottom-sheet set** from §9.
6. **A "states" artboard** collecting the edge cases from §9.
7. A short **rationale note** (on the canvas or alongside): what the accent is and why, what
   the surface idea is, what changed from today and what was kept.

---

## 13. Acceptance criteria

- Calories-left and protein-left are the largest thing on Today and readable at ~1 m.
- One accent colour does the accent work; red is reserved for destructive + over-target;
  no fourth and fifth colour families.
- `source` (label/reference/estimate) and `draft` are visually distinct **without relying on
  colour alone**.
- Field vs. button vs. link are unambiguous at a glance.
- Every tap target ≥ 44 px; primary actions reachable by thumb.
- Nothing depends on a webfont CDN or runtime network; icons are SVG in-repo.
- Colour is expressed as semantic tokens, ready for a later dark theme.
- Empty Library, no-target Today, and offline all have a designed state.
- The redesign is buildable as one hand-written `css/style.css` with no framework.

---

## 14. Open questions

1. **Accent colour** — terracotta / chartreuse / non-navy ink / something else? The style
   tiles should make this decidable.
2. **Serif or grotesque for display?** A serif (Fraunces / Newsreader) leans editorial and
   warm; a grotesque leans instrument. Show one of each in the alternates.
3. **Surface idea** — long-shadow, hard-border, or paper-grain (see §8). Pick in review.
4. **Do the hero readouts stay rings**, or become arcs / bars / a fuel-gauge? Rings are
   familiar; something more distinctive could be the signature element. Worth one exploration.
5. **Tab bar labels** — keep "Gym" (short, casual) or "Workouts" (formal, matches the screen
   title)? Minor, but decide.
