# Skill Brief — "Paste from Claude" (Foods import generator)

**For use in:** Cowork / skill-creator, to generate a reusable skill
**Companion to:** `calorietrackerbrief.md` v1.1 §7 (import/export) and the app itself at
`github.com/yannickmontalent24/mycounter`
**Target consumer of the output:** the Foods tab → "Paste from Claude" field
**Matches app behaviour as of:** the import-review release (`prepareImport` / `commitImport`)

---

## 1. What this skill is for

The tracker app deliberately has no barcode scanner, no food database, and no LLM calls of its
own (main brief §3). New foods and recipes enter the app exactly one way: the user has a
conversation with Claude, Claude emits a JSON array, and the user pastes it into the app's
import field.

This skill's job is to make that emitted JSON **correct on the first paste, every time.**

That is a higher bar than "well-formatted JSON". The importer works in two stages, and they
fail very differently:

- **Validation is all-or-nothing.** A single malformed object — a missing `source`, a quoted
  number, a recipe pointing at a food that doesn't exist — rejects the *entire* paste and writes
  nothing. This is deliberate: a bad object must never reach the database.
- **ID collisions are not fatal.** Items whose `id` already exists are shown in a review step
  where the user chooses Skip or Replace per item. Everything else still imports.

So a collision costs the user a couple of taps. A validation error costs them a round trip back
to the conversation, at a kitchen counter, on a phone. **Optimise hard against validation
errors; treat collisions as merely untidy.**

**Success criterion:** the user pastes, taps Review, sees everything marked `new`, taps Import.
Zero edits, zero retries.

---

## 2. When the skill should trigger

Trigger when the user is trying to get food or recipe data *into the app*. Typical openers:

- "Add this to my tracker" / "give me the JSON for this"
- Pasting or photographing a nutrition label
- "I made a batch of X, here's what went in"
- "What are the macros for [restaurant meal / whole food]?" — where the evident next step is
  logging it
- Any conversation that ends with a food or recipe the user will want to log

Do **not** trigger for: reviewing an exported day, weekly progress analysis, or target-setting.
Those are separate conversations (see §12).

Note that the app now has its own **quick-add** on the Log screen — five fields, inline, without
leaving the logging flow. For a single simple food the user already has the numbers for, that is
faster than a conversation. This skill earns its place on **bulk additions, label transcription,
recipes, and anything needing macros worked out** — not on "add one food I already know."

---

## 3. The output contract

The skill must emit **exactly one fenced code block containing a JSON array**, with no prose,
comments, ellipses, or trailing commentary inside the block.

Rationale: the user copies with one tap. Anything inside the fence that isn't JSON — a `//`
comment, a "..." placeholder, an explanatory line — makes `JSON.parse` fail and the whole paste
is rejected.

- Top level **must be an array**, even for a single item. A bare object is rejected.
- An empty array is rejected too — don't emit `[]` as a "nothing to add" signal; say it in prose.
- Foods and recipes may be mixed freely in the same array. The importer writes all foods before
  all recipes regardless of array order, so a recipe may safely appear before the foods it
  references *within the same paste*.
- Explanation, caveats, and the reasoning behind estimates belong **outside** the fence, above
  or below it. Keep it brief — this is read on a phone.

The user will see a review screen listing each item as `new` or already-in-library before
anything is written, so it is worth naming in prose what you have emitted ("three foods and one
recipe") — it gives them something to check the screen against.

---

## 4. Schema

The importer distinguishes the two types by one rule only: **if the object has an `ingredients`
array, it is a recipe; otherwise it is a food.** There is no `type` field.

### Food

```json
{
  "id": "chicken-breast-raw",
  "name": "Chicken breast, raw",
  "per100g": { "kcal": 106, "protein": 24, "carbs": null, "fat": null, "fibre": null },
  "defaultPortionG": 150,
  "source": "reference",
  "tags": ["protein"]
}
```

| Field | Required | Notes |
|---|---|---|
| `id` | **yes** | Non-empty string. Kebab-case slug. See §7. |
| `name` | **yes** | Non-empty string. Shown in lists; keep under ~40 chars or it truncates with an ellipsis. |
| `per100g` **or** `per100ml` | **yes** | Exactly one, never both. Use `per100ml` for anything drunk rather than eaten — see §4a. |
| `per100g.kcal` | **yes** | Number, per 100 grams (or 100 ml). |
| `per100g.protein` | **yes** | Number, per 100 grams (or 100 ml). Decimals fine (`10.3`). |
| `per100g.carbs` / `.fat` / `.fibre` | no | Number or `null`. Not validated, not currently displayed — include when known, `null` when not. Never guess a number here just to fill the field. |
| `defaultPortionG` / `defaultPortionMl` | no, but **always include** | Number, matching whichever base you used. Pre-fills the amount field on the Log screen. Falls back to 100 if omitted. This is the single biggest lever on the "log in under five seconds" goal — set it to a realistic single serving (a 330 ml can, a 30 ml espresso), not a round number. |
| `source` | **yes** | `"label"` \| `"reference"` \| `"estimate"`. See §5. |
| `tags` | no | Array of strings. Drives the filter chips on the Foods tab. See §8. |

### 4a. Drinks — use `per100ml`, never convert

Anything drunk rather than eaten (soft drinks, coffee, juice, beer, spirits, milk) should be
emitted with `per100ml` and `defaultPortionMl`:

```json
{
  "id": "coca-cola",
  "name": "Coca-Cola",
  "per100ml": { "kcal": 42, "protein": 0, "carbs": 10.6, "fat": 0, "fibre": null },
  "defaultPortionMl": 330,
  "source": "label",
  "tags": ["drinks"]
}
```

The app then logs that food in millilitres, shows "42 kcal · 0 g /100ml", and exports
`Coca-Cola 330ml`. A 330 ml can comes out at 139 kcal — `42 × 3.3`.

**Never apply a density conversion.** Drink labels are already printed per 100 ml, so converting
ml to grams and *then* applying per-100 g figures transforms the number twice and silently
inflates every portion. There is no density field in the schema and none should be invented.
The unit is a label on the food, not a conversion factor.

Corollaries:

- Don't mix bases. `per100g` with `defaultPortionMl`, or `per100ml` alongside `unit: "g"`, are
  both rejected outright.
- If a label genuinely gives per-100 g for a liquid (some syrups and oils do), use `per100g` and
  let it be logged in grams. Match the label; don't translate it.
- `unit: "g" | "ml"` is also accepted explicitly, but `per100ml` already implies `ml`, so
  there's rarely a reason to send it.
- Solids stay exactly as before — omitting the unit means grams.

### Recipe

```json
{
  "id": "batch-a-chicken-rice",
  "name": "Batch A — chicken & rice",
  "ingredients": [
    { "foodId": "chicken-breast-raw", "grams": 600 },
    { "foodId": "basmati-rice-dry", "grams": 300 }
  ],
  "cookedWeightG": 1900,
  "portions": 4
}
```

| Field | Required | Notes |
|---|---|---|
| `id` | **yes** | Non-empty string, kebab-case. See §7. |
| `name` | **yes** | Non-empty string. |
| `ingredients` | **yes** | Non-empty array. Each entry needs `foodId` (non-empty string) and `grams` (number > 0). **Grams are RAW weights** — see §6. Every `foodId` must resolve — see §10. |
| `cookedWeightG` | **yes** | Number > 0. The weight of the finished batch, weighed after cooking. See §6. |
| `portions` | **yes** | Number > 0. |

A recipe has no `source` field and no macros of its own — the app derives them from the
ingredients.

**On drafts:** the app itself lets a user save a recipe *without* a cooked weight, as a draft, to
be filled in when the batch is weighed. **The importer does not accept drafts.** An imported
recipe must always carry a real `cookedWeightG`. If the user hasn't weighed the batch yet, the
right answer is to tell them to start the recipe in the app as a draft — not to emit a recipe
with a guessed weight (see §6).

---

## 5. `source` — the honesty field

Every food carries a provenance marker, surfaced as a badge on every row in the Foods tab. It
exists because the user needs to know which numbers to trust: a day built from `label` entries
and a day built from `estimate` entries are not equally reliable, and the UI must not flatten
that distinction (main brief §4).

| Value | Means | Use when |
|---|---|---|
| `label` | Read off the product's back panel | The user gave you actual packaging text or a photo of it |
| `reference` | Published food-composition table value for a whole food | Chicken breast, banana, olive oil — commonly cited figures |
| `estimate` | Your best guess | Restaurant meals, homemade dishes with unknown prep, anything you reasoned toward |

**Rules:**

- The importer **rejects** any food without a valid `source`. It is never defaulted, by design.
- **Never inflate confidence.** If the user describes a restaurant dish and you reason out
  plausible macros, that is `estimate` — not `reference`, and certainly not `label`.
- If you used a published table value but adjusted it (e.g. scaled for a different cut), that is
  `estimate`, not `reference`.
- When emitting an `estimate`, say so in the prose *outside* the code block, with one line on
  what drove the guess. The user should be able to decide whether to trust it.

---

## 6. The cooked-weight rule (non-negotiable)

Cooked weight ≠ raw weight. Rice roughly triples; chicken loses ~25% to water. The app handles
this correctly *only if it receives the right inputs*, and it cannot detect a wrong one.

How the app uses what you emit:

1. It sums total batch macros from the **raw** ingredient grams you provide × each ingredient's
   per-100 g figures.
2. It divides that total by `cookedWeightG` to get macros **per gram of cooked food**.
3. Every portion the user logs is cooked grams × that per-gram figure.

Therefore:

- `ingredients[].grams` **must be raw weights** — what went into the pan.
- `cookedWeightG` **must be the finished batch weight**, actually weighed after cooking.
- **Never invent `cookedWeightG`.** If the user hasn't weighed the finished batch, ask. Do not
  estimate it from a shrinkage rule of thumb, and do not fall back to the sum of raw weights —
  either error silently corrupts every portion the user logs from that recipe, in a way that
  looks completely normal on screen.

If the batch hasn't been weighed yet, the correct move is **not** to emit a recipe. Either:

- tell the user to build it in the app as a draft and fill in the weight when they weigh it, or
- emit only the component foods, so they can log ingredients individually.

Say which, and why.

---

## 7. IDs, collisions, and updating existing items

Use stable, descriptive kebab-case slugs derived from the name: `greek-yoghurt-0`,
`tias-granola-gold`, `batch-a-chicken-rice`. IDs are permanent in practice — the user has no
rename UI, only delete-and-re-add. Choose as if it's forever.

### Avoiding collisions

A collision no longer breaks the paste, but it still costs taps and invites the wrong choice at
the review screen. To avoid them:

**Ask the user to tap "Copy my food list for Claude"** (Foods tab) and paste the result at the
start of the conversation. It produces a compact `id — name` listing of every food and recipe
they already have — small enough to paste without thought, unlike the full data export. Once you
have it, you can pick non-colliding ids with certainty.

If you don't have that listing and a collision seems likely, prefer a more specific id
(`chicken-breast-raw-tesco` over `chicken-breast-raw`) and mention why.

### Reusing an id on purpose

Reusing an existing id is a legitimate move when the user wants to **correct** stored data — the
label numbers were wrong, a typo, a bad estimate now replaced by a real label. Emit it with the
same id and tell the user to choose **Replace** at the review screen.

**But understand what Replace does.** Log entries store only a reference and a gram weight;
macros are computed live. So replacing an item **also changes every meal already logged from
it** — the totals on past days shift retroactively, silently.

That gives a clean rule:

| Situation | Right move |
|---|---|
| The stored numbers were **wrong** | Same id → Replace. Rewriting history is correct: the old figures were never right. |
| The thing itself **changed** (reformulated product, different batch, new supplier) | **New id.** The old entries recorded what was actually eaten at the time. |

### Repeat batches — do not reuse a recipe id

The user batch-cooks on Sundays (main brief §2). Next week's Batch A has different weights, so
it is a **different batch**, not an edit of last week's. Reusing the recipe id and choosing
Replace would silently rewrite what last week's meals say they ate.

- If the user asks for "Batch A again, but with 650 g chicken", emit it under a **new id**
  (`batch-a-2026-09-14` or similar) — or better, tell them the app has a **"Cook this again"**
  button on each recipe that copies it for a fresh batch without touching history. That is
  usually faster than a conversation.
- Never emit a recipe with an existing id unless the user has explicitly said the stored recipe
  was *wrong*.

---

## 8. Tags

Free-form strings; the Foods tab builds its filter chips from whatever tags exist across the
library. That means an inconsistent vocabulary silently degrades the filter into noise.

Default to this small set, and reuse rather than invent:

`protein` · `carbs` · `fats` · `dairy` · `breakfast` · `snack` · `drinks`

Add a new tag only when the user asks for one or it's clearly a recurring category for them.
One to three tags per food. Tags are optional — an empty array or omitting the field is fine.

---

## 9. User context that shapes suggestions

These are established facts (main brief §2). They constrain what the skill should *propose*;
they do not change the schema.

- **Lactose intolerant.** Hard and aged cheeses are tolerated; fresh dairy is excluded. Don't
  suggest milk, fresh yoghurt, or soft cheese as protein sources without flagging it.
- **No spicy food.**
- **Legumes limited** — beans and lentils in small quantities only.
- **Market: Mauritius.** Product availability and labelling differ from EU/US assumptions; don't
  assume a brand or product is obtainable. Prefer asking for the label over guessing at a
  product's numbers.
- The user is in a calorie deficit with a **protein target of 110–135 g/day** ahead of a race on
  25 Oct 2026. Protein-dense options are usually the useful ones.

**Do not invent values to fill gaps.** Main brief §11 lists inputs that are explicitly
undetermined (TDEE, several product macros). If a number isn't known, ask for it or mark the
food `estimate` and say what's uncertain — never quietly produce a plausible-looking figure.

---

## 10. Failure modes to design against

**Hard rejections** — these bin the whole paste, so never emit them:

1. **A recipe referencing a `foodId` that doesn't exist.** The importer checks that every
   ingredient resolves either to a food already in the library or to one included in the same
   paste, and rejects with the missing ids named. **Rule: always include the foods a recipe
   needs in the same array**, unless you have confirmed from the library listing (§7) that they
   are already there. (This check exists because such a recipe used to import cleanly and then
   break invisibly — portions logged from it vanished from the day's list with no error.)
2. **Strings where numbers belong.** `"kcal": "106"` parses as JSON but fails validation. Emit
   bare numbers, never quoted.
3. **A missing or invalid `source`** on any food (§5).
4. **A recipe without `cookedWeightG`** — the app's draft state is not available via import (§4).
5. **Anything that isn't a JSON array** — including a bare object, an empty array, or prose that
   slipped inside the fence (§3).

**Silent damage** — no error, wrong data:

6. **`cookedWeightG` guessed rather than weighed.** See §6. Confidently wrong, forever.
7. **`source` upgraded for confidence.** Destroys the one signal the user has for judging their
   own data.
8. **Reusing an id to record a change rather than a correction.** Rewrites past meals (§7).
9. **Per-portion figures in `per100g`.** The app has no per-piece or per-serving concept. A food
   sold by the unit (one egg, one bar) must still be expressed per 100 g, with
   `defaultPortionG` set to the weight of one unit.
10. **Density-converting a drink.** Emitting `per100g` for a liquid by converting its per-100 ml
    label, or including a density factor of any kind. The app measures drinks in ml directly —
    see §4a. Converting corrupts the numbers.

---

## 11. Interaction pattern

Before emitting, the skill should have:

1. **The numbers, or an explicit decision to estimate.** Ask for the label if a label plausibly
   exists.
2. **For recipes: the raw ingredient weights AND the weighed cooked batch weight AND the portion
   count.** All three. No emitting a recipe with any of them assumed.
3. **Every ingredient food accounted for** — in the library already, or included in the same
   array (§10.1).
4. **The library listing, if collisions are plausible** — or an explicit decision to proceed
   without it (§7).

Then emit: a short line of prose (what this is, how many items, and any estimate caveats), then
one fenced JSON block, then nothing else.

Keep the conversation short. Every exchange is friction, and the whole import/export design
exists because friction is what kills daily logging by week three (main brief §12).

---

## 12. Out of scope for this skill

- **Reading the app's day/range export.** The app exports a plain-text day summary for pasting
  *into* Claude for review and advice. That's the opposite direction and a different job — worth
  its own sibling skill, deliberately not merged into this one.
- **Setting calorie/protein targets.** Those are user-entered in Settings and depend on a TDEE
  figure that is still undetermined (main brief §11).
- **Weight-log entries, day targets, date overrides.** The import field accepts foods and recipes
  only; other object types are treated as foods and rejected on validation.
- **Deleting anything.** Import only adds or replaces.

---

## 13. Worked examples

**A. Two foods from a label**

> Both from the packaging you photographed, so marked `label`. Two new foods.

```json
[
  {
    "id": "tias-granola-gold",
    "name": "Tia's Granola — No Sugar Added",
    "per100g": { "kcal": 491, "protein": 22, "carbs": null, "fat": null, "fibre": 10 },
    "defaultPortionG": 50,
    "source": "label",
    "tags": ["breakfast", "carbs"]
  },
  {
    "id": "whey-isolate-vanilla",
    "name": "Whey isolate, vanilla",
    "per100g": { "kcal": 373, "protein": 86, "carbs": 4.2, "fat": 1.1, "fibre": null },
    "defaultPortionG": 30,
    "source": "label",
    "tags": ["protein"]
  }
]
```

**B. A recipe plus the foods it needs, in one paste**

> Chicken and rice figures are published reference values. Batch weighed at 1900 g cooked. Two
> foods and one recipe.

```json
[
  {
    "id": "chicken-breast-raw",
    "name": "Chicken breast, raw",
    "per100g": { "kcal": 106, "protein": 24, "carbs": null, "fat": null, "fibre": null },
    "defaultPortionG": 150,
    "source": "reference",
    "tags": ["protein"]
  },
  {
    "id": "basmati-rice-dry",
    "name": "Basmati rice, dry",
    "per100g": { "kcal": 349, "protein": 8.1, "carbs": 78, "fat": 0.9, "fibre": 1.3 },
    "defaultPortionG": 75,
    "source": "reference",
    "tags": ["carbs"]
  },
  {
    "id": "batch-a-chicken-rice",
    "name": "Batch A — chicken & rice",
    "ingredients": [
      { "foodId": "chicken-breast-raw", "grams": 600 },
      { "foodId": "basmati-rice-dry", "grams": 300 }
    ],
    "cookedWeightG": 1900,
    "portions": 4
  }
]
```

**C2. Drinks**

> Both per 100 ml, straight off the labels. The espresso is a published reference figure.

```json
[
  {
    "id": "coca-cola",
    "name": "Coca-Cola",
    "per100ml": { "kcal": 42, "protein": 0, "carbs": 10.6, "fat": 0, "fibre": null },
    "defaultPortionMl": 330,
    "source": "label",
    "tags": ["drinks"]
  },
  {
    "id": "espresso",
    "name": "Espresso",
    "per100ml": { "kcal": 2, "protein": 0.1, "carbs": null, "fat": null, "fibre": null },
    "defaultPortionMl": 30,
    "source": "reference",
    "tags": ["drinks"]
  }
]
```

**C. A restaurant meal**

> This is an estimate — no label exists. Based on a typical grilled fish plate with rice and
> vegetables; the oil used in cooking is the biggest unknown and could swing this ±120 kcal.

```json
[
  {
    "id": "grilled-fish-plate-restaurant",
    "name": "Grilled fish plate (restaurant)",
    "per100g": { "kcal": 142, "protein": 15.5, "carbs": null, "fat": null, "fibre": null },
    "defaultPortionG": 350,
    "source": "estimate",
    "tags": ["protein"]
  }
]
```

**D. Correcting a food that's already stored**

> Same id as the existing entry, so this is an update rather than a new food — choose
> **Replace** at the review screen. Note that your previously logged granola portions will
> recalculate with these corrected numbers, which is what you want here since the old figures
> were wrong.

```json
[
  {
    "id": "tias-granola-gold",
    "name": "Tia's Granola — No Sugar Added",
    "per100g": { "kcal": 478, "protein": 21.5, "carbs": null, "fat": null, "fibre": 10 },
    "defaultPortionG": 50,
    "source": "label",
    "tags": ["breakfast", "carbs"]
  }
]
```

---

## 14. Open questions for the skill author

1. **How aggressively to request the library listing.** Asking for "Copy my food list for
   Claude" every session is reliable but adds an exchange; asking only when a collision looks
   likely is lighter but occasionally wrong. Consider asking once per conversation, only when
   the user is adding more than one or two items.
2. **How much estimate rationale to show.** Enough to judge trustworthiness, not so much it
   becomes an essay on a phone screen. Suggest capping at one or two lines.
3. **Whether to volunteer the in-app alternatives.** Quick-add (single known food) and "Cook
   this again" (repeat batch) are both faster than a conversation. A skill that occasionally
   says "you can do this faster in the app" is more useful than one that always produces JSON —
   but it shouldn't nag.
