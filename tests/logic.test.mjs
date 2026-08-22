import assert from 'node:assert/strict';
import {
  resolveTarget, weekdayOf, recipePerGram, recipePortionMacros,
  foodPortionMacros, heroState, validateFood, validateRecipe, entryMacros,
  isDraftRecipe, findSimilarFoods, normalizeFoodName,
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

test('entryMacros: resolves a recipe-based logEntry via recipeId', () => {
  const foods = new Map([['chicken-raw', { id: 'chicken-raw', per100g: { kcal: 106, protein: 24, carbs: null, fat: null, fibre: null } }]]);
  const recipes = new Map([['batch-a', { id: 'batch-a', name: 'Batch A', ingredients: [{ foodId: 'chicken-raw', grams: 600 }], cookedWeightG: 1420, portions: 4 }]]);
  const entry = { id: '1', date: '2026-08-22', recipeId: 'batch-a', foodId: null, grams: 355 };
  const result = entryMacros(entry, foods, recipes);
  assert.equal(result.name, 'Batch A');
  assert.equal(result.kcal, Math.round((106 * 6 / 1420) * 355));
});

console.log(`\n${passed} passed`);
