# Handoff: mycounter — bottom sheets

Addendum to the mycounter visual redesign. Covers the **six bottom sheets** only. The base tokens,
components and screens are in the main handoff (`design_handoff_mycounter_redesign/README.md`);
everything below assumes those tokens.

## About the design file

`Bottom Sheets.dc.html` is a **design reference created in HTML** — a prototype of the intended
look, not production code to copy. Recreate it in the app's own environment (hand-written
HTML/CSS/JS, no build step, one `css/style.css`). As in the main handoff, the reference loads fonts
from Google and styles everything inline for tooling reasons; production self-hosts
**Hanken Grotesk** + **Space Grotesk** in `fonts/` and expresses these values as CSS custom
properties.

**Fidelity: high.** Colours, sizes, weights, spacing, radii and shadows are final. Recreate
pixel-for-pixel at 390px width.

## The sheet shell

Every sheet is the same shell. Build it once.

| Part | Spec |
|---|---|
| Scrim | `rgba(22, 32, 58, .45)` over the full viewport. Tapping it dismisses |
| Sheet | `--surface` (`#EEF0F5`) + the `--grain` background image, `border-top: 1.5px solid var(--line)`, `border-radius: 20px 20px 0 0` |
| Sheet padding | `10px 20px 28px` — the 28px is the home-indicator safe area, use `env(safe-area-inset-bottom)` |
| Internal rhythm | `display:flex; flex-direction:column; gap:16px` (14px on the recipe builder, which is the densest) |
| Drag handle | 44×5, radius 3, `--line` fill, `align-self:center` |
| Title row | `space-between`, baseline-aligned: title 20px/800 letter-spacing −0.02em; right side a text action (Cancel / Reset / Deselect all) at 14px/700 `--accent` underlined |
| Primary action | Last child. Height 56, radius 10, `--accent`, white 17px/700, centred |
| Status bar | Stays visible above the scrim, in `--on-dark` (`#EEF0F5`) |

Rules:
- Sheets are the **only** modal surface in the app. No dialogs, no full-screen modals.
- The sheet is anchored to the bottom edge and sized by its content; it never fills the screen.
- Only one text action in the title row. Destructive or secondary paths go inline in the content.
- The primary action is always last so it lands in the thumb zone. When the action is not yet
  possible, it renders **disabled** (`--well` fill, `--text-tertiary` text,
  `inset 0 2px 4px rgba(22,32,58,.10)`) rather than being hidden.

### Motion

| Transition | Spec |
|---|---|
| In | 280ms `cubic-bezier(.32, .72, 0, 1)`, `translateY(100%) → 0` |
| Out | 200ms `ease-in`, reverse |
| Scrim | fades with the sheet, same durations |

Dismissed by dragging the handle down, tapping the scrim, or the title-row text action.
`prefers-reduced-motion: reduce` → instant opacity swap, no translate.

## The six sheets

### 1. Add a food
Reached from Library → Foods (`+`), or from the Log tab's "Add "gran" as a new food" row. Same sheet
serves edit — only the title and primary label change ("Edit food" / "Save changes").

Content, top to bottom:
1. **Name** — section label + full-width well, 52px. Shown in the *focused* well treatment
   (`--well-strong`, `1.5px solid #A7B0C4`, `inset 0 2px 5px rgba(22,32,58,.20)`), 16px/600.
2. **Per 100** — section label, then two 52px wells side by side (`gap:10px`, `flex:1` each), each
   `space-between`: value in Space Grotesk 18px/700, unit label 13px `--text-secondary`
   ("kcal", "g protein").
3. **Unit chips** — `grams` selected (`--text-primary` fill, white, 700) / `millilitres`
   unselected. 36px tall, radius 10.
4. **Source selector** — section label "Where the numbers came from", then three chips carrying
   their badge glyphs: `▣ label` (selected), `◨ reference`, `◌ estimate` (the estimate chip keeps
   its **1.5px dashed** `#98A0B5` border even as a chip). Helper line beneath at 13px/1.5
   `--text-secondary`: "Read off the packet. Estimates are marked everywhere they appear."
5. **Primary**: "Save food".

The source is mandatory — it drives the badge shown on every row where the food appears, so it
cannot default silently.

### 2. Paste from Claude
Reached from the "Paste from Claude" text action in the Library header. Two-stage in one sheet:
paste, then review.

1. **Paste target** — a 96px-tall mono well: Space Grotesk 13px/1.55, `--text-secondary`, radius 10,
   padding 12px 14px, `overflow:hidden`. Shows the pasted JSON.
2. **Review list** — section label "Ready to import" with a "Deselect all" text action on the right,
   then a single raised card of rows:
   - **Importable row**: 20×20 accent check (`stroke-width` 2.4, round caps), name 14px/600,
     per-100 figure in Space Grotesk 12px `--text-secondary`, source badge on the right.
   - **Conflict row**: `--accent-tint` (`#FBE9EB`) row background, 20×20 accent warning circle,
     name, "Already in your library" in 12px/600 `--accent`, and a "Replace" text action. The row
     is excluded from the count until resolved.
3. **Primary**: "Import 2 foods" — the count reflects selected, non-conflicting rows and updates live.

Parse failures are not modal: an unparseable paste leaves the review list empty and shows the
empty-state pattern inside the sheet.

### 3. Filter & sort
Reached from the "Sort" pill on Library → Foods. Title-row action is **Reset**.

1. **Sort by** — section label, then a raised card of four single-select rows (14px 16px padding,
   `1px solid var(--line-soft)` between). Selected: 15px/700 with a trailing 20×20 accent check.
   Unselected: 15px/600 `--text-secondary`, no glyph. Options: Most logged · Recently added ·
   Name A–Z · Highest protein.
2. **Show only** — section label, then multi-select chips, each carrying its glyph:
   `▣ label` (selected), `◨ reference`, `◌ estimate`, `⌛ drafts` (selected state uses the accent
   tint treatment: `--accent-tint` fill, `1.5px solid var(--accent)`, accent text 700), `▤ recipes`.
3. **Primary**: "Show 31 foods" — the count is live and reflects the current filter.

Applying is explicit; the list behind the sheet does not re-sort until the primary is tapped.

### 4. Recipe builder
Reached from Library → Recipes → "+ New recipe", and from "Cook again" (which pre-fills the
ingredients). Internal `gap:14px` — this is the densest sheet.

1. **Recipe name** — 52px well, 16px/600.
2. **Ingredients — raw weights** — section label, then a raised card:
   - Ingredient row: name 14px/600 (`flex:1`), amount in Space Grotesk 14px/700, accent `×` delete.
   - Last row is the add affordance: 28×28 accent `+` tile (radius 8) + "Add an ingredient" 14px/600
     `--text-secondary`. Tapping it opens the food search — as a **second sheet stacked over this
     one**, not a replacement.
3. **Cooked weight + Portions** — a `gap:10px` row. Cooked weight is a `flex:1` 52px well showing an
   em dash in `--text-tertiary` when empty, with a `g` unit label. Portions is a 140px stepper
   (44px `−` / centred Space Grotesk 18px/700 value / 44px `+`) in the well treatment.
4. **Draft notice** — shown only while cooked weight is empty: `--accent-tint` fill,
   `1.5px solid var(--accent)`, radius 10, padding 12px 14px, a `⌛` glyph and 13px/1.5 accent copy:
   "Saves as a draft. Weigh the cooked batch to unlock per-portion macros and logging."
5. **Primary**: **"Save as draft"** while cooked weight is empty; becomes **"Save recipe"** once a
   weight is entered, at which point the draft notice is replaced by a per-portion figure strip
   (kcal / portion and protein, Space Grotesk 19px/700 with 11px uppercase captions).

This is the one sheet whose primary label changes with state. A draft recipe cannot be logged
anywhere in the app until it has a cooked weight.

### 5. Log a weight
Reached from Body weight → "Log a weight".

1. **Value** — a centred row: 56×56 `−` well, an 84px-tall focused well showing the value
   (Space Grotesk 44px/700, letter-spacing −0.03em) baseline-aligned with a 17px `kg` unit, and a
   56×56 `+` well. Steps by 0.1. The field is directly typeable.
2. **Date** — raised card, `space-between`: "Date" 15px/600 and a date chip ("Wed 3 Sep ▾") for
   backdating.
3. **Live effect** — raised card with two Space Grotesk figures, tabular: "new average" (67.9) and
   the "3 weeks" delta (−0.8). Recomputes as the value changes, so the consequence of the entry is
   visible before saving.
4. **Helper** — 13px/1.5 `--text-secondary`: "Weighed first thing, before breakfast, gives the
   steadiest trend."
5. **Primary**: "Save weight".

### 6. Meal picker — "Move to"
Reached from the `⇄` icon on any log entry. Also the meal chooser when logging (title "Log to",
primary "Add to Breakfast").

1. **Title block** — "Move to" plus a sub-line naming the entry: "Tia's Granola — No Sugar Added ·
   55 g" at 14px `--text-secondary`.
2. **Meal list** — raised card, four rows at 15px 16px padding: meal name (15px/700 for the current
   meal, 600 for the rest) over its subtotal in Space Grotesk 12px `--text-secondary`. The entry's
   current meal carries a "now here" label (12px/700 uppercase, 0.08em, `--text-secondary`) and a
   20×20 accent check.
3. **Day** — raised card with a date chip, so an entry can move to another day as well as another
   meal.
4. **Primary**: "Move entry" — **disabled** until the selection differs from the current
   meal/day. This is the disabled state shown in the reference.

## State

No new state. The sheets are all views onto existing records; the only sheet-local state is the
in-progress form and, for Paste from Claude, the parsed-but-not-yet-imported list.

## Files

- `Bottom Sheets.dc.html` — the six sheets, each in a 390×844 frame over its own dimmed context.
  Frames carry `data-screen-label` ("Sheet — Add food", "Sheet — Paste from Claude",
  "Sheet — Filter & sort", "Sheet — Recipe builder", "Sheet — Log a weight", "Sheet — Meal picker").
- `support.js` — runtime for the reference file. Not part of the app.

No new assets. Glyphs in the reference (`▣ ◨ ◌ ⌛ ▤ × + ▾`) stand in for **in-repo SVG icons** —
replace with the same 1.8px round-cap stroke set used by the tab bar before shipping.
