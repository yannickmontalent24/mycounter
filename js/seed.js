import { count, putAll, getMeta, setMeta } from './db.js';
import { WEEKDAYS } from './logic.js';

// Only fully-known facts get seeded (main brief §11: undetermined inputs must not be
// invented). Weekday kcal/protein targets are left null — the user enters them in Settings.
const SEED_FOODS = [
  {
    id: 'granola-tias-gold',
    name: "Tia's Granola — No Sugar Added Raisin Free",
    per100g: { kcal: 491, protein: 22, carbs: null, fat: null, fibre: 10 },
    defaultPortionG: 50,
    source: 'label',
    tags: ['breakfast'],
  },
];

const SEED_WEIGHT = [
  { date: '2026-08-22', kg: 68.2 },
];

export async function seedIfEmpty() {
  const already = await getMeta('seeded');
  if (already) return;

  if ((await count('foods')) === 0) {
    await putAll('foods', SEED_FOODS);
  }
  if ((await count('weightLog')) === 0) {
    await putAll('weightLog', SEED_WEIGHT);
  }
  if ((await count('dayTargets')) === 0) {
    await putAll('dayTargets', WEEKDAYS.map(weekday => ({ weekday, kcal: null, protein: null })));
  }
  await setMeta('seeded', true);
}
