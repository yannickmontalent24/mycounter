# Skill Brief — "Paste from Claude" (Foods import generator)

**For use in:** Cowork / skill-creator, to generate a reusable skill
**Companion to:** `calorietrackerbrief.md` v1.1 §7 (import/export) and the app itself at
`github.com/yannickmontalent24/mycounter`
**Target consumer of the output:** the Foods tab → "Paste from Claude" field

---

## 1. What this skill is for

The tracker app deliberately has no barcode scanner, no food database, and no LLM calls of its
own (main brief §3). New foods and recipes enter the app exactly one way: the user has a
conversation with Claude, Claude emits a JSON array, and the user taps once to paste it into
the app's import field.

This skill's job is to make that emitted JSON **correct on the first paste, every time.**

That is a higher bar than "well-formatted JSON". The app's importer is deliberately strict — it
rejects the entire paste on any single invalid object rather than partially importing (main
brief §7, implemented in `importFromClipboardText`). A malformed paste is not a soft failure;
it is a rejected paste and a retyped conversation, at a kitchen counter, on a phone.

**Success criterion:** the user pastes, taps Import, and sees a success toast. Zero edits, zero
retries.

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

---

## 3. The output contract

The skill must emit **exactly one fenced code block containing a JSON array**, with no prose,
comments, ellipses, or trailing commentary inside the block.

Rationale: the user copies with one tap. Anything inside the fence that isn't JSON — a `//`
comment, a "..." placeholder, an explanatory line — makes `JSON.parse` fail and the whole paste
is rejected with "Not valid JSON."

- Top level **must be an array**, even for a single item. A bare object is rejected with
  "Expected a JSON array of food/recipe objects."
- Foods and recipes may be mixed freely in the same array. The importer writes all foods before
  all recipes regardless of array order, so a recipe may safely appear before the foods it
  references *within the same paste*.
- Explanation, caveats, and the reasoning behind estimates belong **outside** the fence, above
  or below it. Keep it brief — this is read on a phone.

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
| `id` | **yes** | Non-empty string. Kebab-case slug. Must not collide — see §7. |
| `name` | **yes** | Non-empty string. Shown in lists; keep under ~40 chars or it truncates with an ellipsis. |
| `per100g.kcal` | **yes** | Number, per 100 grams. |
| `per100g.protein` | **yes** | Number, per 100 grams. Decimals fine (`10.3`). |
| `per100g.carbs` / `.fat` / `.fibre` | no | Number or `null`. Not validated, not currently displayed — include when known, `null` when not. Never guess a number here just to fill the field. |
| `defaultPortionG` | no, but **always include** | Number. Pre-fills the grams field on the Log screen. Falls back to 100 if omitted. This is the single biggest lever on the "log in under five seconds" goal — set it to a realistic single serving, not a round number. |
| `source` | **yes** | `"label"` \| `"reference"` \| `"estimate"`. See §5. |
| `tags` | no | Array of strings. Drives the filter chips on the Foods tab. See §8. |

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
| `id` | **yes** | Non-empty string, kebab-case, must not collide. |
| `name` | **yes** | Non-empty string. |
| `ingredients` | **yes** | Non-empty array. Each entry needs `foodId` (non-empty string) and `grams` (number > 0). **Grams are RAW weights** — see §6. |
| `cookedWeightG` | **yes** | Number > 0. The weight of the finished batch, weighed after cooking. See §6. |
| `portions` | **yes** | Number > 0. |

A recipe has no `source` field and no macros of its own — the app derives them from the
ingredients.

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

If the user can't or won't weigh the batch, the correct move is to **not emit a recipe** and
instead emit the component foods, so they can log ingredients individually. Say why.

---

## 7. IDs and collisions

The importer **hard-rejects** the entire paste if any `id` already exists in the app:

> `Item 0: food id "chicken-breast-raw" already exists. Rename it or remove the existing one first.`

There is no overwrite or merge path. So:

- Use stable, descriptive kebab-case slugs derived from the name: `greek-yoghurt-0`,
  `tias-granola-gold`, `batch-a-chicken-rice`.
- **Before emitting, ask what's already in the library** — unless the user has already told you
  in this conversation. The app has an "Export all data (JSON)" button in Settings → Data that
  copies the entire dataset; asking the user to paste that is the reliable way to know. For a
  one-off addition, asking "is there already a chicken breast entry?" is enough.
- If a collision is likely and you can't confirm, prefer a more specific id
  (`chicken-breast-raw-tesco`) over a generic one, and mention it.
- Ids are permanent in practice — the user has no rename UI, only delete-and-re-add. Choose as
  if it's forever.

---

## 8. Tags

Free-form strings; the Foods tab builds its filter chips from whatever tags exist across the
library. That means an inconsistent vocabulary silently degrades the filter into noise.

Default to this small set, and reuse rather than invent:

`protein` · `carbs` · `fats` · `dairy` · `breakfast` · `snack`

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

## 10. Traps — silent failures to design against

These are the failure modes that don't produce an error message, which makes them the dangerous
ones:

1. **A recipe referencing a `foodId` that doesn't exist.** The importer does *not* validate that
   ingredient foods exist. It will accept the recipe. The recipe then shows "—" instead of
   per-portion macros, and — worse — any log entry made from it **silently disappears from the
   Today list**, because the app can't resolve its macros. **Rule: every `foodId` in a recipe
   must either already be in the user's library or be included in the same paste.**
2. **`cookedWeightG` guessed rather than weighed.** See §6. Produces confidently wrong numbers
   forever.
3. **`source` upgraded for confidence.** Marking an estimate as `label` destroys the one signal
   the user has for judging their own data.
4. **Strings where numbers belong.** `"kcal": "106"` passes `JSON.parse` but fails validation
   (`typeof !== 'number'`). Emit bare numbers, never quoted.
5. **Per-portion figures in `per100g`.** The app has no per-piece or per-serving concept. A food
   sold by the unit (one egg, one bar) must still be expressed per 100 g, with
   `defaultPortionG` set to the weight of one unit.
6. **Volume units.** The app is grams-only; there is no ml. For liquids, either convert using
   density or treat per-100 ml as per-100 g — and say which you did in the prose.

---

## 11. Interaction pattern

Before emitting, the skill should have:

1. **The numbers, or an explicit decision to estimate.** Ask for the label if a label plausibly
   exists.
2. **For recipes: the raw ingredient weights AND the weighed cooked batch weight AND the portion
   count.** All three. No emitting a recipe with any of them assumed.
3. **Enough confidence on id collisions** (§7).

Then emit: a short line of prose (what this is, and any estimate caveats), then one fenced JSON
block, then nothing else.

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
  only; other object types are silently misclassified as foods and rejected on validation.
- **Editing or deleting existing entries.** Import is additive only, and collides rather than
  overwrites.

---

## 13. Worked examples

**A. Two foods from a label**

> Both from the packaging you photographed, so marked `label`.

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

> Chicken and rice figures are published reference values. Batch weighed at 1900 g cooked.

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

---

## 14. Open questions for the skill author

Decide these when building the skill; none are settled by the app or the briefs:

1. **Should the skill proactively ask for the full "Export all data (JSON)" dump at the start of
   a session** to eliminate id collisions, or only ask when a collision seems likely? The former
   is more reliable, the latter is less friction.
2. **How much estimate rationale to show.** Enough to judge trustworthiness, not so much it
   becomes an essay on a phone screen. Suggest capping at one or two lines.
3. **Whether to offer a "replacement" flow** — since the importer can't overwrite, replacing an
   existing food means the user deletes it in the app first, then pastes. Worth a scripted
   instruction, or worth leaving alone?
