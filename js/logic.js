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
    return { name: food.name, ...foodPortionMacros(food, entry.grams) };
  }
  if (entry.recipeId != null) {
    const recipe = recipesById.get(entry.recipeId);
    if (!recipe) return null;
    return { name: recipe.name, ...recipePortionMacros(recipe, foodsById, entry.grams) };
  }
  return null;
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

const VALID_SOURCES = new Set(['label', 'reference', 'estimate']);

export function validateFood(obj) {
  const errors = [];
  if (typeof obj.id !== 'string' || !obj.id) errors.push('food.id is required');
  if (typeof obj.name !== 'string' || !obj.name) errors.push('food.name is required');
  if (!obj.per100g || typeof obj.per100g.kcal !== 'number') errors.push('food.per100g.kcal is required');
  if (!obj.per100g || typeof obj.per100g.protein !== 'number') errors.push('food.per100g.protein is required');
  if (!VALID_SOURCES.has(obj.source)) errors.push(`food.source must be one of label/reference/estimate (got: ${obj.source ?? 'missing'})`);
  return errors;
}

export function validateRecipe(obj) {
  const errors = [];
  if (typeof obj.id !== 'string' || !obj.id) errors.push('recipe.id is required');
  if (typeof obj.name !== 'string' || !obj.name) errors.push('recipe.name is required');
  if (!Array.isArray(obj.ingredients) || obj.ingredients.length === 0) errors.push('recipe.ingredients must be a non-empty array');
  else for (const ing of obj.ingredients) {
    if (typeof ing.foodId !== 'string' || !ing.foodId) errors.push('recipe.ingredients[].foodId is required');
    if (typeof ing.grams !== 'number' || ing.grams <= 0) errors.push('recipe.ingredients[].grams must be a positive number');
  }
  if (typeof obj.cookedWeightG !== 'number' || obj.cookedWeightG <= 0) errors.push('recipe.cookedWeightG must be a positive number');
  if (typeof obj.portions !== 'number' || obj.portions <= 0) errors.push('recipe.portions must be a positive number');
  return errors;
}

export function formatDateHeader(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const dayName = date.toLocaleDateString('en-GB', { weekday: 'short' });
  return `${dayName} ${d} ${date.toLocaleDateString('en-GB', { month: 'short' })}`;
}

export function exportDayText(dateStr, resolvedEntries, target) {
  const header = `${dateStr} (${formatDateHeader(dateStr).split(' ')[0]})`;
  const lines = resolvedEntries.map(e => `${e.name} ${e.grams}g — ${e.kcal} kcal, ${e.protein.toFixed(1)} P`);
  const kcalTotal = resolvedEntries.reduce((a, e) => a + e.kcal, 0);
  const protTotal = resolvedEntries.reduce((a, e) => a + e.protein, 0);
  const targetText = target.kcal != null && target.protein != null
    ? `target ${target.kcal} / ${target.protein}`
    : 'target not set';
  const total = `TOTAL: ${kcalTotal} kcal · ${protTotal.toFixed(1)} P · ${targetText}`;
  return [header, ...lines, total].join('\n');
}
