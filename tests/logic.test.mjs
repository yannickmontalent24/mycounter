import assert from 'node:assert/strict';
import {
  resolveTarget, weekdayOf, recipePerGram, recipePortionMacros,
  foodPortionMacros, heroState, validateFood, validateRecipe, entryMacros,
  isDraftRecipe, findSimilarFoods, normalizeFoodName, unitOf, exportDayText,
  inferMeal, groupEntriesByMeal, sumMacros, MEALS, resolveEntriesForDisplay,
  estimateCookedWeightG, splitFoodLibrary, sortFoods,
} from '../js/logic.js';

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (err) {
    console.error(`FAIL - ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

// --- Cooked-weight rule (brief's worked example: 600g raw chicken -> 1420g cooked batch) ---
test('cooked-weight: per-gram macros derive from COOKED weight, not raw weight', () => {
  const foods = new Map([
    ['chicken-raw', { id: 'chicken-raw', per100g: { kcal: 106, protein: 24, carbs: null, fat: null, fibre: null } }],
  ]);
  const recipe = {
    id: 'batch-a',
    ingredients: [{ foodId: 'chicken-raw', grams: 600 }],
    cookedWeightG: 1420,
    portions: 4,
  };
  const perGram = recipePerGram(recipe, foods);

  const totalKcal = 106 * 6; // 636
  const totalProtein = 24 * 6; // 144
  const correctKcalPerGram = totalKcal / 1420;
  const wrongKcalPerGram = totalKcal / 600; // the bug this test guards against

  assert.ok(Math.abs(perGram.kcal - correctKcalPerGram) < 1e-9, 'kcal per gram must use cooked weight');
  assert.ok(Math.abs(perGram.protein - (totalProtein / 1420)) < 1e-9, 'protein per gram must use cooked weight');
  assert.notEqual(perGram.kcal.toFixed(4), wrongKcalPerGram.toFixed(4), 'must not equal the raw-weight-basis result');
});

test('cooked-weight: portion macros scale from cooked grams logged', () => {
  const foods = new Map([
    ['chicken-raw', { id: 'chicken-raw', per100g: { kcal: 106, protein: 24, carbs: null, fat: null, fibre: null } }],
  ]);
  const recipe = { id: 'batch-a', ingredients: [{ foodId: 'chicken-raw', grams: 600 }], cookedWeightG: 1420, portions: 4 };
  const portion = recipePortionMacros(recipe, foods, 355); // one of 4 portions, 1420/4
  // total batch kcal 636, protein 144; a quarter portion should be ~1/4 of batch
  assert.equal(portion.kcal, Math.round(636 / 4));
  assert.equal(portion.protein, Math.round(144 / 4));
});

test('cooked-weight: an arbitrary weighed amount scales per gram, not per equal share', () => {
  // 600 g raw chicken -> 1420 g cooked, nominally 4 portions of 355 g. Weighing out 500 g
  // must give 500/1420 of the batch, not one quarter of it.
  const foods = new Map([
    ['chicken-raw', { id: 'chicken-raw', per100g: { kcal: 106, protein: 24, carbs: null, fat: null, fibre: null } }],
  ]);
  const recipe = { id: 'batch-a', ingredients: [{ foodId: 'chicken-raw', grams: 600 }], cookedWeightG: 1420, portions: 4 };

  const weighed = recipePortionMacros(recipe, foods, 500);
  const batchKcal = 106 * 6;
  assert.equal(weighed.kcal, Math.round(batchKcal * (500 / 1420)));

  const onePortion = recipePortionMacros(recipe, foods, 355);
  assert.notEqual(weighed.kcal, onePortion.kcal, 'a 500 g plate is not one 355 g portion');

  // And two different weights must differ proportionally.
  const half = recipePortionMacros(recipe, foods, 250);
  assert.equal(half.kcal, Math.round(batchKcal * (250 / 1420)));
});

test('cooked-weight: multi-ingredient recipe sums raw macros before dividing by cooked weight', () => {
  const foods = new Map([
    ['rice-dry', { id: 'rice-dry', per100g: { kcal: 349, protein: 8.1, carbs: null, fat: null, fibre: null } }],
    ['chicken-raw', { id: 'chicken-raw', per100g: { kcal: 106, protein: 24, carbs: null, fat: null, fibre: null } }],
  ]);
  const recipe = {
    id: 'batch-b',
    ingredients: [{ foodId: 'rice-dry', grams: 300 }, { foodId: 'chicken-raw', grams: 600 }],
    cookedWeightG: 1900,
    portions: 4,
  };
  const perGram = recipePerGram(recipe, foods);
  const totalKcal = 349 * 3 + 106 * 6;
  assert.ok(Math.abs(perGram.kcal - totalKcal / 1900) < 1e-9);
});

test('cooked-weight: rejects a zero/missing cookedWeightG rather than dividing by it', () => {
  const foods = new Map([['f', { id: 'f', per100g: { kcal: 100, protein: 10, carbs: null, fat: null, fibre: null } }]]);
  const recipe = { id: 'bad', ingredients: [{ foodId: 'f', grams: 100 }], cookedWeightG: 0, portions: 1 };
  assert.throws(() => recipePerGram(recipe, foods));
});

// --- Target resolution (overrides must beat weekday defaults, e.g. the maintenance block) ---
test('target resolution: falls back to weekday default when no override exists', () => {
  const dayTargets = [{ weekday: 'wed', kcal: 1900, protein: 120 }];
  const overrides = [];
  const target = resolveTarget(dayTargets, overrides, '2026-08-26', 'wed');
  assert.deepEqual(target, { kcal: 1900, protein: 120 });
});

test('target resolution: date-specific override beats the weekday default (maintenance block)', () => {
  const dayTargets = [{ weekday: 'mon', kcal: 1900, protein: 120 }];
  const overrides = [{ date: '2026-09-28', kcal: null, protein: 120 }];
  const target = resolveTarget(dayTargets, overrides, '2026-09-28', weekdayOf('2026-09-28'));
  assert.deepEqual(target, { kcal: null, protein: 120 });
});

test('target resolution: override only affects its exact date, not the rest of that weekday', () => {
  const dayTargets = [{ weekday: 'mon', kcal: 1900, protein: 120 }];
  const overrides = [{ date: '2026-09-28', kcal: 1500, protein: 120 }];
  // 2026-09-28 is a Monday; the following Monday (10-05) should NOT inherit the override.
  const nextMonday = '2026-10-05';
  assert.equal(weekdayOf(nextMonday), 'mon');
  const target = resolveTarget(dayTargets, overrides, nextMonday, 'mon');
  assert.deepEqual(target, { kcal: 1900, protein: 120 });
});

test('weekdayOf: matches known calendar dates', () => {
  assert.equal(weekdayOf('2026-08-22'), 'sat');
  assert.equal(weekdayOf('2026-09-28'), 'mon');
});

// --- Macro math ---
test('foodPortionMacros: per-100g scaled by grams, rounded', () => {
  const food = { per100g: { kcal: 491, protein: 22 } };
  assert.deepEqual(foodPortionMacros(food, 50), { kcal: 246, protein: 11 });
});

test('heroState: signed remaining, over target uses ▲ and does not clamp negative', () => {
  const under = heroState(1500, 2200);
  assert.equal(under.remaining, 700);
  assert.equal(under.over, false);
  assert.equal(under.mark, '▼');

  const over = heroState(2300, 2200);
  assert.equal(over.remaining, -100);
  assert.equal(over.over, true);
  assert.equal(over.mark, '▲');
});

test('heroState: null target (not yet configured) does not throw or divide by zero', () => {
  const result = heroState(500, null);
  assert.equal(result.remaining, null);
  assert.equal(result.over, false);
});

// --- Import validation ---
test('validateFood: rejects a food missing source rather than defaulting it', () => {
  const errors = validateFood({ id: 'x', name: 'X', per100g: { kcal: 1, protein: 1 } });
  assert.ok(errors.some(e => e.includes('source')));
});

test('validateFood: accepts a fully specified food', () => {
  const errors = validateFood({ id: 'x', name: 'X', per100g: { kcal: 1, protein: 1 }, source: 'label' });
  assert.deepEqual(errors, []);
});

test('validateRecipe: rejects a recipe without cookedWeightG', () => {
  const errors = validateRecipe({ id: 'r', name: 'R', ingredients: [{ foodId: 'f', grams: 100 }], portions: 2 });
  assert.ok(errors.some(e => e.includes('cookedWeightG')));
});

// --- Draft recipes (saved before the batch has been weighed) ---
test('draft recipe: may be saved without cookedWeightG when drafts are allowed', () => {
  const draft = { id: 'r', name: 'R', ingredients: [{ foodId: 'f', grams: 100 }], portions: 4 };
  assert.deepEqual(validateRecipe(draft, { allowDraft: true }), []);
});

test('draft recipe: still rejected without cookedWeightG under normal (import) validation', () => {
  const draft = { id: 'r', name: 'R', ingredients: [{ foodId: 'f', grams: 100 }], portions: 4 };
  assert.ok(validateRecipe(draft).some(e => e.includes('cookedWeightG')));
});

test('draft recipe: allowDraft does not excuse a nonsensical cooked weight', () => {
  const bad = { id: 'r', name: 'R', ingredients: [{ foodId: 'f', grams: 100 }], cookedWeightG: 0, portions: 4 };
  assert.ok(validateRecipe(bad, { allowDraft: true }).some(e => e.includes('cookedWeightG')));
  const negative = { ...bad, cookedWeightG: -5 };
  assert.ok(validateRecipe(negative, { allowDraft: true }).some(e => e.includes('cookedWeightG')));
});

test('isDraftRecipe: identifies recipes that cannot yet be logged from', () => {
  assert.equal(isDraftRecipe({ cookedWeightG: null }), true);
  assert.equal(isDraftRecipe({ cookedWeightG: undefined }), true);
  assert.equal(isDraftRecipe({ cookedWeightG: 0 }), true);
  assert.equal(isDraftRecipe({ cookedWeightG: 1420 }), false);
});

// --- Near-duplicate detection ---
test('findSimilarFoods: catches case and punctuation variants', () => {
  const foods = [{ id: 'a', name: 'Chicken breast, raw' }];
  assert.equal(findSimilarFoods('chicken breast raw', foods).length, 1);
  assert.equal(findSimilarFoods('Chicken Breast', foods).length, 1);
});

test('findSimilarFoods: does not flag genuinely different foods', () => {
  const foods = [{ id: 'a', name: 'Chicken breast, raw' }, { id: 'b', name: 'Olive oil' }];
  assert.deepEqual(findSimilarFoods('Basmati rice, dry', foods), []);
});

test('findSimilarFoods: short names do not match by containment', () => {
  const foods = [{ id: 'a', name: 'Eggplant' }];
  assert.deepEqual(findSimilarFoods('Egg', foods), []);
});

test('findSimilarFoods: excludes the food being edited', () => {
  const foods = [{ id: 'a', name: 'Chicken breast, raw' }];
  assert.deepEqual(findSimilarFoods('Chicken breast, raw', foods, { excludeId: 'a' }), []);
});

test('normalizeFoodName: strips punctuation and collapses whitespace', () => {
  assert.equal(normalizeFoodName("Tia's Granola —  No Sugar"), 'tia s granola no sugar');
});

// --- Meal grouping ---
test('inferMeal: maps the clock onto breakfast/lunch/dinner', () => {
  const at = h => new Date(2026, 7, 22, h, 0, 0);
  assert.equal(inferMeal(at(7)), 'breakfast');
  assert.equal(inferMeal(at(10)), 'breakfast');
  assert.equal(inferMeal(at(11)), 'lunch');
  assert.equal(inferMeal(at(13)), 'lunch');
  assert.equal(inferMeal(at(16)), 'dinner');
  assert.equal(inferMeal(at(20)), 'dinner');
  assert.equal(inferMeal(at(22)), 'snacks');
  assert.equal(inferMeal(at(2)), 'snacks');
});

test('inferMeal: always returns one of the four valid categories', () => {
  for (let h = 0; h < 24; h++) {
    assert.ok(MEALS.includes(inferMeal(new Date(2026, 7, 22, h, 30))), `hour ${h}`);
  }
});

test('groupEntriesByMeal: files entries under their category, in fixed order', () => {
  const { groups, unsorted } = groupEntriesByMeal([
    { id: '1', meal: 'dinner' }, { id: '2', meal: 'breakfast' }, { id: '3', meal: 'dinner' },
  ]);
  assert.deepEqual([...groups.keys()], MEALS, 'sections keep a fixed order');
  assert.equal(groups.get('dinner').length, 2);
  assert.equal(groups.get('breakfast').length, 1);
  assert.equal(groups.get('lunch').length, 0);
  assert.deepEqual(unsorted, []);
});

test('groupEntriesByMeal: pre-meal entries are set aside, never guessed into a section', () => {
  const { groups, unsorted } = groupEntriesByMeal([
    { id: 'legacy' }, { id: 'bad', meal: 'brunch' }, { id: 'ok', meal: 'lunch' },
  ]);
  assert.equal(unsorted.length, 2, 'missing and unrecognised categories both go unsorted');
  assert.equal(groups.get('lunch').length, 1);
  for (const m of MEALS) {
    assert.ok(!groups.get(m).some(e => e.id === 'legacy'), `legacy entry must not appear in ${m}`);
  }
});

// Regression: the display step used to drop `meal`, so every entry rendered as unassigned
// however it was saved. Grouping was tested in isolation and never caught it.
test('resolveEntriesForDisplay: carries meal through to the rendered row', () => {
  const foods = new Map([['f', { id: 'f', name: 'Boiled egg', per100g: { kcal: 155, protein: 13 } }]]);
  const rows = resolveEntriesForDisplay(
    [{ id: '1', date: '2026-08-24', foodId: 'f', recipeId: null, grams: 60, meal: 'breakfast' }],
    foods, new Map(),
  );
  assert.equal(rows[0].meal, 'breakfast');
  assert.equal(rows[0].name, 'Boiled egg');
  assert.equal(rows[0].grams, 60);
});

test('resolveEntriesForDisplay: rows survive grouping into their real section', () => {
  const foods = new Map([['f', { id: 'f', name: 'Egg', per100g: { kcal: 155, protein: 13 } }]]);
  const entries = [
    { id: '1', foodId: 'f', grams: 60, meal: 'breakfast' },
    { id: '2', foodId: 'f', grams: 60, meal: 'dinner' },
    { id: '3', foodId: 'f', grams: 60 },
  ];
  const { groups, unsorted } = groupEntriesByMeal(resolveEntriesForDisplay(entries, foods, new Map()));
  assert.equal(groups.get('breakfast').length, 1, 'a breakfast entry must land in breakfast');
  assert.equal(groups.get('dinner').length, 1);
  assert.equal(unsorted.length, 1, 'only the entry with no meal is unassigned');
});

test('resolveEntriesForDisplay: a recipe entry keeps its meal too', () => {
  const foods = new Map([['c', { id: 'c', per100g: { kcal: 106, protein: 24, carbs: null, fat: null, fibre: null } }]]);
  const recipes = new Map([['r', { id: 'r', name: 'Batch A', ingredients: [{ foodId: 'c', grams: 600 }], cookedWeightG: 1420, portions: 4 }]]);
  const rows = resolveEntriesForDisplay(
    [{ id: '1', foodId: null, recipeId: 'r', grams: 355, meal: 'lunch' }], foods, recipes,
  );
  assert.equal(rows[0].meal, 'lunch');
  assert.equal(rows[0].name, 'Batch A');
});

test('sumMacros: totals a section', () => {
  assert.deepEqual(sumMacros([{ kcal: 100, protein: 5 }, { kcal: 250, protein: 30 }]), { kcal: 350, protein: 35 });
  assert.deepEqual(sumMacros([]), { kcal: 0, protein: 0 });
});

// --- Millilitre foods (drinks) ---
test('unitOf: defaults to grams, honours ml, ignores anything else', () => {
  assert.equal(unitOf({}), 'g');
  assert.equal(unitOf({ unit: 'g' }), 'g');
  assert.equal(unitOf({ unit: 'ml' }), 'ml');
  assert.equal(unitOf(undefined), 'g');
});

test('ml food: macros are NOT density-converted — 100 ml of a per-100ml label is 1x', () => {
  // Coca-Cola label: 42 kcal per 100 ml. A 330 ml can must be 139 kcal, not 139 x density.
  const coke = { per100g: { kcal: 42, protein: 0 }, unit: 'ml' };
  assert.deepEqual(foodPortionMacros(coke, 330), { kcal: 139, protein: 0 });
});

test('ml food: an espresso logged in ml resolves with the ml unit', () => {
  const foods = new Map([['espresso', { id: 'espresso', name: 'Espresso', unit: 'ml', per100g: { kcal: 2, protein: 0.1 } }]]);
  const entry = { id: '1', date: '2026-08-22', foodId: 'espresso', recipeId: null, grams: 30 };
  const result = entryMacros(entry, foods, new Map());
  assert.equal(result.unit, 'ml');
  assert.equal(result.name, 'Espresso');
});

test('gram food: entryMacros still reports grams for untouched existing foods', () => {
  const foods = new Map([['chicken', { id: 'chicken', name: 'Chicken', per100g: { kcal: 106, protein: 24 } }]]);
  const entry = { id: '1', date: '2026-08-22', foodId: 'chicken', recipeId: null, grams: 150 };
  assert.equal(entryMacros(entry, foods, new Map()).unit, 'g');
});

test('recipe portions stay in grams even when an ingredient is measured in ml', () => {
  const foods = new Map([
    ['oil', { id: 'oil', name: 'Olive oil', unit: 'ml', per100g: { kcal: 884, protein: 0, carbs: null, fat: null, fibre: null } }],
    ['chicken', { id: 'chicken', name: 'Chicken', per100g: { kcal: 106, protein: 24, carbs: null, fat: null, fibre: null } }],
  ]);
  const recipes = new Map([['b', {
    id: 'b', name: 'Batch', cookedWeightG: 900, portions: 4,
    ingredients: [{ foodId: 'chicken', grams: 600 }, { foodId: 'oil', grams: 20 }],
  }]]);
  const entry = { id: '1', date: '2026-08-22', recipeId: 'b', foodId: null, grams: 225 };
  const result = entryMacros(entry, foods, recipes);
  assert.equal(result.unit, 'g', 'a weighed batch is always grams');
  // 20 ml of oil contributes its macros directly, no conversion applied
  const expectedTotal = 106 * 6 + 884 * 0.2;
  assert.equal(result.kcal, Math.round((expectedTotal / 900) * 225));
});

test('validateFood: rejects an unrecognised unit but allows it to be omitted', () => {
  const base = { id: 'x', name: 'X', per100g: { kcal: 1, protein: 1 }, source: 'label' };
  assert.deepEqual(validateFood(base), []);
  assert.deepEqual(validateFood({ ...base, unit: 'ml' }), []);
  assert.ok(validateFood({ ...base, unit: 'oz' }).some(e => e.includes('unit')));
});

test('exportDayText: writes ml for drinks and g for solids', () => {
  const text = exportDayText('2026-08-22', [
    { name: 'Espresso', grams: 30, unit: 'ml', kcal: 1, protein: 0 },
    { name: 'Chicken', grams: 150, unit: 'g', kcal: 159, protein: 36 },
  ], { kcal: 2000, protein: 120 });
  assert.ok(text.includes('Espresso 30ml —'), text);
  assert.ok(text.includes('Chicken 150g —'), text);
});

test('entryMacros: resolves a recipe-based logEntry via recipeId', () => {
  const foods = new Map([['chicken-raw', { id: 'chicken-raw', per100g: { kcal: 106, protein: 24, carbs: null, fat: null, fibre: null } }]]);
  const recipes = new Map([['batch-a', { id: 'batch-a', name: 'Batch A', ingredients: [{ foodId: 'chicken-raw', grams: 600 }], cookedWeightG: 1420, portions: 4 }]]);
  const entry = { id: '1', date: '2026-08-22', recipeId: 'batch-a', foodId: null, grams: 355 };
  const result = entryMacros(entry, foods, recipes);
  assert.equal(result.name, 'Batch A');
  assert.equal(result.kcal, Math.round((106 * 6 / 1420) * 355));
});

// --- Cooked-weight estimate (recipes shouldn't require weighing the batch up front) ---
test('estimateCookedWeightG: applies each ingredient\'s category factor and sums the result', () => {
  const foods = new Map([
    ['chicken', { id: 'chicken', cookCategory: 'meat_poultry' }], // factor 0.75
    ['rice', { id: 'rice', cookCategory: 'grain_starch' }], // factor 2.2
  ]);
  const est = estimateCookedWeightG(
    [{ foodId: 'chicken', grams: 600 }, { foodId: 'rice', grams: 300 }],
    foods,
  );
  assert.equal(est, Math.round(600 * 0.75 + 300 * 2.2));
});

test('estimateCookedWeightG: ignores ingredients with no known cooking category', () => {
  const foods = new Map([
    ['chicken', { id: 'chicken', cookCategory: 'meat_poultry' }],
    ['mystery', { id: 'mystery' }], // no cookCategory set
  ]);
  const est = estimateCookedWeightG(
    [{ foodId: 'chicken', grams: 600 }, { foodId: 'mystery', grams: 400 }],
    foods,
  );
  assert.equal(est, Math.round(600 * 0.75), 'the uncategorised ingredient must not be assumed 1:1');
});

test('estimateCookedWeightG: returns null rather than 0 when nothing can be estimated', () => {
  const foods = new Map([['mystery', { id: 'mystery' }]]);
  assert.equal(estimateCookedWeightG([{ foodId: 'mystery', grams: 400 }], foods), null);
  assert.equal(estimateCookedWeightG([], foods), null);
});

// --- Foods list: separating recipe-only ingredients from what's actually logged ---
test('splitFoodLibrary: a food used only inside a recipe is filed as an ingredient', () => {
  const foods = [{ id: 'flour', name: 'Flour' }, { id: 'banana', name: 'Banana' }];
  const recipes = [{ id: 'r', ingredients: [{ foodId: 'flour', grams: 200 }] }];
  const { foods: main, ingredients } = splitFoodLibrary(foods, recipes, new Set());
  assert.deepEqual(main.map(f => f.id), ['banana']);
  assert.deepEqual(ingredients.map(f => f.id), ['flour']);
});

test('splitFoodLibrary: a food logged directly stays in the main list even if also a recipe ingredient', () => {
  const foods = [{ id: 'chicken', name: 'Chicken' }];
  const recipes = [{ id: 'r', ingredients: [{ foodId: 'chicken', grams: 600 }] }];
  const { foods: main, ingredients } = splitFoodLibrary(foods, recipes, new Set(['chicken']));
  assert.deepEqual(main.map(f => f.id), ['chicken']);
  assert.deepEqual(ingredients, []);
});

test('splitFoodLibrary: a food used in no recipe is always in the main list', () => {
  const foods = [{ id: 'banana', name: 'Banana' }];
  const { foods: main, ingredients } = splitFoodLibrary(foods, [], new Set());
  assert.deepEqual(main.map(f => f.id), ['banana']);
  assert.deepEqual(ingredients, []);
});

// --- Foods list sorting ---
test('sortFoods: sorts by name, calories, protein, or logged frequency', () => {
  const foods = [
    { id: 'a', name: 'Banana', per100g: { kcal: 89, protein: 1.1 } },
    { id: 'b', name: 'Almonds', per100g: { kcal: 579, protein: 21 } },
    { id: 'c', name: 'Chicken', per100g: { kcal: 106, protein: 24 } },
  ];
  assert.deepEqual(sortFoods(foods, 'name').map(f => f.id), ['b', 'a', 'c']);
  assert.deepEqual(sortFoods(foods, 'kcal').map(f => f.id), ['b', 'c', 'a']);
  assert.deepEqual(sortFoods(foods, 'protein').map(f => f.id), ['c', 'b', 'a']);
  const freq = { a: 10, b: 1, c: 5 };
  assert.deepEqual(sortFoods(foods, 'frequency', id => freq[id] ?? 0).map(f => f.id), ['a', 'c', 'b']);
});

console.log(`\n${passed} passed`);
