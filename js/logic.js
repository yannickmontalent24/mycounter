// Pure, DOM-free logic: target resolution, cooked-weight derivation, macro math.
// Kept separate from db.js/render.js so it can be unit tested with plain `node`.

export function resolveTarget(dayTargets, overrides, dateStr, weekday) {
  const override = overrides.find(o => o.date === dateStr);
  if (override) return { kcal: override.kcal ?? null, protein: override.protein ?? null };
  const wk = dayTargets.find(d => d.weekday === weekday);
  return { kcal: wk?.kcal ?? null, protein: wk?.protein ?? null };
}

export const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export function weekdayOf(dateStr) {
  // dateStr is YYYY-MM-DD, parsed as local calendar date (not UTC-shifted).
  const [y, m, d] = dateStr.split('-').map(Number);
  return WEEKDAYS[new Date(y, m - 1, d).getDay()];
}

// Cooked-weight rule (brief §5 / code-brief §3):
// 1. sum raw-ingredient macros, 2. divide by COOKED weight (never raw weight) to get per-gram figures.
export function recipePerGram(recipe, foodsById) {
  const totals = { kcal: 0, protein: 0, carbs: 0, fat: 0, fibre: 0 };
  let hasCarbs = false, hasFat = false, hasFibre = false;
  for (const ing of recipe.ingredients) {
    const food = foodsById.get(ing.foodId);
    if (!food) throw new Error(`Unknown ingredient foodId: ${ing.foodId}`);
    const factor = ing.grams / 100;
    totals.kcal += food.per100g.kcal * factor;
    totals.protein += food.per100g.protein * factor;
    if (food.per100g.carbs != null) { totals.carbs += food.per100g.carbs * factor; hasCarbs = true; }
    if (food.per100g.fat != null) { totals.fat += food.per100g.fat * factor; hasFat = true; }
    if (food.per100g.fibre != null) { totals.fibre += food.per100g.fibre * factor; hasFibre = true; }
  }
  const cw = recipe.cookedWeightG;
  if (!cw || cw <= 0) throw new Error('cookedWeightG must be a positive number');
  return {
    kcal: totals.kcal / cw,
    protein: totals.protein / cw,
    carbs: hasCarbs ? totals.carbs / cw : null,
    fat: hasFat ? totals.fat / cw : null,
    fibre: hasFibre ? totals.fibre / cw : null,
  };
}

// Rough per-category cooking weight change, used only to suggest a starting cooked weight so
// a recipe is loggable as soon as its ingredients are entered — without making the batch
// actually be weighed a precondition. Always editable, and replaced outright the moment
// someone weighs the real batch; this is a starting point, not a substitute for that.
export const COOK_CATEGORIES = [
  { id: 'meat_poultry', label: 'Meat or poultry', factor: 0.75 },
  { id: 'fish_seafood', label: 'Fish or seafood', factor: 0.80 },
  { id: 'vegetable', label: 'Vegetable', factor: 0.90 },
  { id: 'grain_starch', label: 'Grain, rice, pasta, or legumes', factor: 2.2 },
  { id: 'liquid_dairy', label: 'Liquid, sauce, or dairy', factor: 1.0 },
];
const COOK_FACTOR = new Map(COOK_CATEGORIES.map(c => [c.id, c.factor]));
export const VALID_COOK_CATEGORIES = new Set(COOK_CATEGORIES.map(c => c.id));

// Ingredients without a cooking category (or not yet resolvable) are simply left out of the
// estimate rather than assumed to be 1:1 — a partial estimate from known ingredients is more
// useful than silently pretending the unknown ones don't change weight at all.
export function estimateCookedWeightG(ingredients, foodsById) {
  let total = 0;
  let any = false;
  for (const ing of ingredients) {
    const food = foodsById.get(ing.foodId);
    const grams = Number(ing.grams);
    if (!food || !(grams > 0) || !COOK_FACTOR.has(food.cookCategory)) continue;
    total += grams * COOK_FACTOR.get(food.cookCategory);
    any = true;
  }
  return any ? Math.round(total) : null;
}

export function foodPortionMacros(food, grams) {
  return {
    kcal: Math.round(food.per100g.kcal * grams / 100),
    protein: Math.round(food.per100g.protein * grams / 100),
  };
}

export function recipePortionMacros(recipe, foodsById, grams) {
  const perGram = recipePerGram(recipe, foodsById);
  return {
    kcal: Math.round(perGram.kcal * grams),
    protein: Math.round(perGram.protein * grams),
  };
}

// Resolves a logEntry (which references either a foodId or a recipeId) to display macros.
export function entryMacros(entry, foodsById, recipesById) {
  if (entry.foodId != null) {
    const food = foodsById.get(entry.foodId);
    if (!food) return null;
    return { name: food.name, unit: unitOf(food), ...foodPortionMacros(food, entry.grams) };
  }
  if (entry.recipeId != null) {
    const recipe = recipesById.get(entry.recipeId);
    if (!recipe) return null;
    // A batch is weighed, so recipe portions are always grams regardless of ingredient units.
    return { name: recipe.name, unit: 'g', ...recipePortionMacros(recipe, foodsById, entry.grams) };
  }
  return null;
}

// Turns stored log entries into rows ready to render. Every field the UI groups or filters on
// must survive this step — `meal` was previously dropped here, which sent every entry to the
// "not assigned" pile regardless of what was actually saved.
export function resolveEntriesForDisplay(entries, foodsById, recipesById) {
  return entries
    .map(entry => {
      const macros = entryMacros(entry, foodsById, recipesById);
      if (!macros) return null;
      return {
        ...macros,
        id: entry.id,
        grams: entry.grams,
        meal: entry.meal ?? null,
        loggedAt: entry.loggedAt ?? null,
      };
    })
    .filter(Boolean);
}

export function heroState(consumed, target) {
  if (target == null) {
    return { remaining: null, over: false, mark: '·', stateText: 'no target set', ofTargetText: `${consumed} logged`, dash: '0 1' };
  }
  const remaining = target - consumed;
  const over = remaining < 0;
  return {
    remaining,
    over,
    mark: over ? '▲' : '▼',
    stateText: over ? 'over target' : 'left today',
    ofTargetText: `${consumed} / ${target}`,
    dash: ringDash(consumed, target),
  };
}

export function ringDash(consumed, target) {
  const C = 2 * Math.PI * 54;
  if (!target || target <= 0) return `0 ${C.toFixed(1)}`;
  const frac = Math.max(0, Math.min(1, consumed / target));
  return `${(frac * C).toFixed(1)} ${C.toFixed(1)}`;
}

export const MEALS = ['breakfast', 'lunch', 'dinner', 'snacks'];
export const MEAL_LABELS = {
  breakfast: 'Breakfast', lunch: 'Lunch', dinner: 'Dinner', snacks: 'Snacks',
};

// Meal is inferred from the clock at log time rather than asked for, so logging keeps costing
// one flow and no extra tap (main brief §12 — anything that adds a second at the counter is
// suspect). It is always editable afterwards, and logging from a section header sets it
// explicitly. Snacks can't be inferred meaningfully at any hour, so it's only ever chosen.
export function inferMeal(when = new Date()) {
  const h = when.getHours();
  if (h < 4) return 'snacks';      // small hours belong to the night before, not to breakfast
  if (h < 11) return 'breakfast';
  if (h < 16) return 'lunch';
  if (h < 22) return 'dinner';
  return 'snacks';
}

// Entries logged before meals existed carry no category. They are not guessed at — there is no
// timestamp to guess from — so they surface in their own group to be assigned by hand.
export function groupEntriesByMeal(entries) {
  const groups = new Map(MEALS.map(m => [m, []]));
  const unsorted = [];
  for (const entry of entries) {
    if (entry.meal && groups.has(entry.meal)) groups.get(entry.meal).push(entry);
    else unsorted.push(entry);
  }
  return { groups, unsorted };
}

export function sumMacros(entries) {
  return entries.reduce(
    (acc, e) => ({ kcal: acc.kcal + (e.kcal ?? 0), protein: acc.protein + (e.protein ?? 0) }),
    { kcal: 0, protein: 0 },
  );
}

const VALID_SOURCES = new Set(['label', 'reference', 'estimate']);
export const VALID_UNITS = new Set(['g', 'ml']);

// Liquids are measured by volume, and their labels are already printed per 100 ml — so the
// unit is a property of the food, and the stored figures are "per 100 units of that unit".
// Nothing is ever converted between g and ml: a density conversion on top of a per-100-ml
// label would apply the transformation twice and silently corrupt every portion.
// (`per100g` / `defaultPortionG` keep their key names to avoid migrating stored data; read
// them as "per 100 units" and "default portion" respectively.)
export function unitOf(food) {
  return food?.unit === 'ml' ? 'ml' : 'g';
}

export function validateFood(obj) {
  const errors = [];
  if (typeof obj.id !== 'string' || !obj.id) errors.push('food.id is required');
  if (typeof obj.name !== 'string' || !obj.name) errors.push('food.name is required');
  if (!obj.per100g || typeof obj.per100g.kcal !== 'number') errors.push('food.per100g.kcal is required');
  if (!obj.per100g || typeof obj.per100g.protein !== 'number') errors.push('food.per100g.protein is required');
  if (!VALID_SOURCES.has(obj.source)) errors.push(`food.source must be one of label/reference/estimate (got: ${obj.source ?? 'missing'})`);
  if (obj.unit != null && !VALID_UNITS.has(obj.unit)) errors.push(`food.unit must be "g" or "ml" (got: ${obj.unit})`);
  if (obj.cookCategory != null && !VALID_COOK_CATEGORIES.has(obj.cookCategory)) errors.push(`food.cookCategory must be a known category (got: ${obj.cookCategory})`);
  return errors;
}

// `allowDraft` permits saving a recipe before its batch has been weighed — you enter raw
// ingredients while the food is still cooking and fill in cookedWeightG later. A draft can
// never be logged from (see isDraftRecipe), so the cooked-weight rule is still never bypassed.
export function validateRecipe(obj, { allowDraft = false } = {}) {
  const errors = [];
  if (typeof obj.id !== 'string' || !obj.id) errors.push('recipe.id is required');
  if (typeof obj.name !== 'string' || !obj.name) errors.push('recipe.name is required');
  if (!Array.isArray(obj.ingredients) || obj.ingredients.length === 0) errors.push('recipe.ingredients must be a non-empty array');
  else for (const ing of obj.ingredients) {
    if (typeof ing.foodId !== 'string' || !ing.foodId) errors.push('recipe.ingredients[].foodId is required');
    if (typeof ing.grams !== 'number' || ing.grams <= 0) errors.push('recipe.ingredients[].grams must be a positive number');
  }
  const cookedMissing = obj.cookedWeightG == null;
  if (!(allowDraft && cookedMissing)) {
    if (typeof obj.cookedWeightG !== 'number' || obj.cookedWeightG <= 0) errors.push('recipe.cookedWeightG must be a positive number');
  }
  if (typeof obj.portions !== 'number' || obj.portions <= 0) errors.push('recipe.portions must be a positive number');
  return errors;
}

export function isDraftRecipe(recipe) {
  return recipe.cookedWeightG == null || !(recipe.cookedWeightG > 0);
}

// Loose name matching, to warn before the library fills up with "Chicken breast",
// "Chicken breast, raw" and "chicken" as three separate foods.
export function normalizeFoodName(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function findSimilarFoods(name, foods, { excludeId = null } = {}) {
  const target = normalizeFoodName(name);
  if (!target) return [];
  return foods.filter(f => {
    if (excludeId && f.id === excludeId) return false;
    const candidate = normalizeFoodName(f.name);
    if (!candidate) return false;
    if (candidate === target) return true;
    // Containment only counts for reasonably long strings, or "egg" matches "eggplant".
    const shorter = candidate.length < target.length ? candidate : target;
    if (shorter.length < 4) return false;
    return candidate.includes(target) || target.includes(candidate);
  });
}

// A food used only as a recipe ingredient (never logged on its own) clutters the Foods screen,
// which exists to choose what to log next. `loggedFoodIds` should be every food that has ever
// been logged directly — a food moves back into the main list the moment that's true, so
// nothing that's actually eaten on its own stays hidden away.
export function splitFoodLibrary(foods, recipes, loggedFoodIds) {
  const usedAsIngredient = new Set();
  for (const r of recipes) for (const ing of r.ingredients ?? []) usedAsIngredient.add(ing.foodId);
  const main = [], ingredients = [];
  for (const f of foods) {
    (usedAsIngredient.has(f.id) && !loggedFoodIds.has(f.id) ? ingredients : main).push(f);
  }
  return { foods: main, ingredients };
}

export const FOOD_SORTS = ['name', 'frequency', 'kcal', 'protein'];

export function sortFoods(foods, sortKey, frequencyOf = () => 0) {
  const arr = foods.slice();
  const byName = (a, b) => a.name.localeCompare(b.name);
  if (sortKey === 'kcal') arr.sort((a, b) => b.per100g.kcal - a.per100g.kcal || byName(a, b));
  else if (sortKey === 'protein') arr.sort((a, b) => b.per100g.protein - a.per100g.protein || byName(a, b));
  else if (sortKey === 'frequency') arr.sort((a, b) => frequencyOf(b.id) - frequencyOf(a.id) || byName(a, b));
  else arr.sort(byName);
  return arr;
}

export function formatDateHeader(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const dayName = date.toLocaleDateString('en-GB', { weekday: 'short' });
  return `${dayName} ${d} ${date.toLocaleDateString('en-GB', { month: 'short' })}`;
}

// ---- Body weight log ----
// The log is a list of { date: 'YYYY-MM-DD', kg: number }. One entry per date (date is the
// document key), so editing a weigh-in that keeps its date overwrites in place.
export function weightSeries(weightLog) {
  return (weightLog ?? [])
    .filter(w => typeof w.kg === 'number' && w.kg > 0 && /^\d{4}-\d{2}-\d{2}$/.test(w.date))
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date));
}

export function averageWeight(weightLog) {
  const s = weightSeries(weightLog);
  if (!s.length) return null;
  return s.reduce((sum, w) => sum + w.kg, 0) / s.length;
}

export function exportDayText(dateStr, resolvedEntries, target) {
  const header = `${dateStr} (${formatDateHeader(dateStr).split(' ')[0]})`;
  const lines = resolvedEntries.map(e => `${e.name} ${e.grams}${e.unit ?? 'g'} — ${e.kcal} kcal, ${e.protein.toFixed(1)} P`);
  const kcalTotal = resolvedEntries.reduce((a, e) => a + e.kcal, 0);
  const protTotal = resolvedEntries.reduce((a, e) => a + e.protein, 0);
  const targetText = target.kcal != null && target.protein != null
    ? `target ${target.kcal} / ${target.protein}`
    : 'target not set';
  const total = `TOTAL: ${kcalTotal} kcal · ${protTotal.toFixed(1)} P · ${targetText}`;
  return [header, ...lines, total].join('\n');
}
