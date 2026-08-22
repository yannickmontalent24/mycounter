import { getAll, entriesInRange, put } from './db.js';
import { entryMacros, exportDayText, resolveTarget, weekdayOf } from './logic.js';

async function loadResolverContext() {
  const [foods, recipes, dayTargets, overrides] = await Promise.all([
    getAll('foods'), getAll('recipes'), getAll('dayTargets'), getAll('dayTargetOverrides'),
  ]);
  return {
    foodsById: new Map(foods.map(f => [f.id, f])),
    recipesById: new Map(recipes.map(r => [r.id, r])),
    dayTargets, overrides,
  };
}

function resolveEntriesForDay(entries, ctx) {
  return entries
    .map(e => {
      const macros = entryMacros(e, ctx.foodsById, ctx.recipesById);
      if (!macros) return null;
      return { grams: e.grams, name: macros.name, kcal: macros.kcal, protein: macros.protein };
    })
    .filter(Boolean);
}

export async function exportDay(dateStr) {
  const ctx = await loadResolverContext();
  const entries = await entriesInRange(dateStr, dateStr);
  const resolved = resolveEntriesForDay(entries, ctx);
  const target = resolveTarget(ctx.dayTargets, ctx.overrides, dateStr, weekdayOf(dateStr));
  return exportDayText(dateStr, resolved, target);
}

function allDatesInRange(fromDate, toDate) {
  const dates = [];
  const [fy, fm, fd] = fromDate.split('-').map(Number);
  const [ty, tm, td] = toDate.split('-').map(Number);
  const cursor = new Date(fy, fm - 1, fd);
  const end = new Date(ty, tm - 1, td);
  while (cursor <= end) {
    const y = cursor.getFullYear();
    const m = String(cursor.getMonth() + 1).padStart(2, '0');
    const d = String(cursor.getDate()).padStart(2, '0');
    dates.push(`${y}-${m}-${d}`);
    cursor.setDate(cursor.getDate() + 1);
  }
  return dates;
}

// Day-by-day detail by default (main brief §7: preserves the detail Claude needs to spot patterns).
export async function exportRange(fromDate, toDate) {
  const ctx = await loadResolverContext();
  const allEntries = await entriesInRange(fromDate, toDate);
  const byDate = new Map();
  for (const e of allEntries) {
    if (!byDate.has(e.date)) byDate.set(e.date, []);
    byDate.get(e.date).push(e);
  }
  const blocks = allDatesInRange(fromDate, toDate).map(dateStr => {
    const entries = byDate.get(dateStr) ?? [];
    const resolved = resolveEntriesForDay(entries, ctx);
    const target = resolveTarget(ctx.dayTargets, ctx.overrides, dateStr, weekdayOf(dateStr));
    if (resolved.length === 0) return `${dateStr} — no entries logged`;
    return exportDayText(dateStr, resolved, target);
  });
  return blocks.join('\n\n');
}

export class ImportError extends Error {}

// Paste-from-Claude import: a JSON array of food and/or recipe objects.
// Rejects (with a clear error, not a silent partial import) on any invalid object or ID collision.
export async function importFromClipboardText(text) {
  const { validateFood, validateRecipe } = await import('./logic.js');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ImportError('Not valid JSON.');
  }
  if (!Array.isArray(parsed)) throw new ImportError('Expected a JSON array of food/recipe objects.');

  const [existingFoods, existingRecipes] = await Promise.all([getAll('foods'), getAll('recipes')]);
  const existingFoodIds = new Set(existingFoods.map(f => f.id));
  const existingRecipeIds = new Set(existingRecipes.map(r => r.id));

  const foodsToAdd = [];
  const recipesToAdd = [];

  parsed.forEach((obj, i) => {
    const isRecipe = Array.isArray(obj.ingredients);
    if (isRecipe) {
      const errors = validateRecipe(obj);
      if (errors.length) throw new ImportError(`Item ${i} (recipe): ${errors.join('; ')}`);
      if (existingRecipeIds.has(obj.id)) throw new ImportError(`Item ${i}: recipe id "${obj.id}" already exists. Rename it or remove the existing one first.`);
      recipesToAdd.push(obj);
    } else {
      const errors = validateFood(obj);
      if (errors.length) throw new ImportError(`Item ${i} (food): ${errors.join('; ')}`);
      if (existingFoodIds.has(obj.id)) throw new ImportError(`Item ${i}: food id "${obj.id}" already exists. Rename it or remove the existing one first.`);
      foodsToAdd.push(obj);
    }
  });

  for (const f of foodsToAdd) await put('foods', f);
  for (const r of recipesToAdd) await put('recipes', r);

  return { foods: foodsToAdd.length, recipes: recipesToAdd.length };
}
