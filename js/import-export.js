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
      return { grams: e.grams, unit: macros.unit, name: macros.name, kcal: macros.kcal, protein: macros.protein };
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

// Paste-from-Claude import, step 1 of 2: parse and validate, and report which items collide
// with something already stored. A genuinely malformed object still hard-rejects the whole
// paste (a bad object must never reach the database), but an ID collision is no longer fatal —
// it becomes a per-item choice in the UI, since Claude has no reliable way to know what the
// library already contains.
// Drinks are labelled per 100 ml, so the import accepts `per100ml` / `defaultPortionMl` as
// self-documenting alternatives to the gram-based keys. Both normalise onto the same stored
// shape with a `unit` marker — no value is ever converted, only labelled.
function normalizeImportedFood(obj, index) {
  const hasG = obj.per100g != null;
  const hasMl = obj.per100ml != null;
  if (hasG && hasMl) {
    throw new ImportError(`Item ${index + 1}: give either per100g or per100ml, not both.`);
  }
  if (obj.unit != null && obj.unit !== 'g' && obj.unit !== 'ml') {
    throw new ImportError(`Item ${index + 1}: unit must be "g" or "ml" (got: ${obj.unit}).`);
  }
  if (hasMl && obj.unit === 'g') {
    throw new ImportError(`Item ${index + 1}: per100ml contradicts unit "g".`);
  }

  const unit = hasMl ? 'ml' : (obj.unit === 'ml' ? 'ml' : 'g');
  const portion = obj.defaultPortionMl ?? obj.defaultPortionG;
  const normalized = {
    ...obj,
    per100g: hasMl ? obj.per100ml : obj.per100g,
    unit,
  };
  if (portion != null) normalized.defaultPortionG = portion;
  delete normalized.per100ml;
  delete normalized.defaultPortionMl;
  return normalized;
}

export async function prepareImport(text) {
  const { validateFood, validateRecipe } = await import('./logic.js');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ImportError('That doesn’t look like JSON. Copy the whole block, including the square brackets.');
  }
  if (!Array.isArray(parsed)) throw new ImportError('Expected a JSON array — the pasted text should start with [ and end with ].');
  if (parsed.length === 0) throw new ImportError('That list is empty — nothing to import.');

  const [existingFoods, existingRecipes] = await Promise.all([getAll('foods'), getAll('recipes')]);
  const existingFoodIds = new Set(existingFoods.map(f => f.id));
  const existingRecipeIds = new Set(existingRecipes.map(r => r.id));

  // Foods arriving in this same paste count as available to recipes in it.
  const incomingFoodIds = new Set(parsed.filter(o => !Array.isArray(o.ingredients)).map(o => o.id));

  const items = parsed.map((raw, i) => {
    const isRecipe = Array.isArray(raw.ingredients);
    const label = isRecipe ? 'recipe' : 'food';
    const obj = isRecipe ? raw : normalizeImportedFood(raw, i);
    const errors = isRecipe ? validateRecipe(obj) : validateFood(obj);
    if (errors.length) throw new ImportError(`Item ${i + 1} (${label}): ${errors.join('; ')}`);

    // A recipe pointing at a food that doesn't exist imports "successfully" and then silently
    // breaks: its macros can't be resolved, so portions logged from it vanish from Today.
    // Catch it here rather than letting it become an invisible data problem.
    if (isRecipe) {
      const missing = obj.ingredients
        .map(ing => ing.foodId)
        .filter(id => !existingFoodIds.has(id) && !incomingFoodIds.has(id));
      if (missing.length) {
        throw new ImportError(
          `Item ${i + 1} (recipe "${obj.name}") uses ${missing.length === 1 ? 'a food' : 'foods'} that isn’t in your library: ` +
          `${missing.join(', ')}. Ask Claude to include ${missing.length === 1 ? 'it' : 'them'} in the same paste.`
        );
      }
    }

    const conflict = isRecipe ? existingRecipeIds.has(obj.id) : existingFoodIds.has(obj.id);
    return { kind: isRecipe ? 'recipe' : 'food', obj, conflict, action: conflict ? 'skip' : 'add' };
  });

  return {
    items,
    newCount: items.filter(it => !it.conflict).length,
    conflictCount: items.filter(it => it.conflict).length,
  };
}

// Step 2 of 2: write the items the user accepted. `action` is 'add' | 'replace' | 'skip'.
export async function commitImport(items) {
  let added = 0, replaced = 0, skipped = 0;
  for (const item of items) {
    if (item.action === 'skip') { skipped++; continue; }
    await put(item.kind === 'recipe' ? 'recipes' : 'foods', item.obj);
    if (item.action === 'replace') replaced++; else added++;
  }
  return { added, replaced, skipped };
}

// Compact library listing to paste into Claude at the start of a conversation, so it knows
// what already exists and stops proposing colliding ids.
export async function exportLibraryForClaude() {
  const [foods, recipes] = await Promise.all([getAll('foods'), getAll('recipes')]);
  const lines = ['Foods already in my tracker (id — name):'];
  if (foods.length === 0) lines.push('(none yet)');
  for (const f of foods.slice().sort((a, b) => a.name.localeCompare(b.name))) {
    lines.push(`${f.id} — ${f.name}${f.unit === 'ml' ? ' (per 100 ml)' : ''}`);
  }
  lines.push('', 'Recipes already in my tracker (id — name):');
  if (recipes.length === 0) lines.push('(none yet)');
  for (const r of recipes.slice().sort((a, b) => a.name.localeCompare(b.name))) {
    lines.push(`${r.id} — ${r.name}`);
  }
  lines.push('', 'Please don’t reuse any of these ids for new items.');
  return lines.join('\n');
}
