import { count, putAll, getMeta, setMeta } from './db.js';
import { WEEKDAYS } from './logic.js';

// Only fully-known facts get seeded (main brief §11: undetermined inputs must not be
// invented). Weekday kcal/protein targets are left null — the user enters them in Settings.
// The food library is shared across accounts, seeded once regardless of who logs in first.
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

// This 68.2kg entry is a fact about yannick specifically (main brief §2) — it must not be
// seeded into manshini's separate weight log, which has no established starting facts.
const YANNICK_SEED_WEIGHT = [
  { date: '2026-08-22', kg: 68.2 },
];

export async function seedSharedIfEmpty() {
  const already = await getMeta('shared-seeded');
  if (already) return;
  if ((await count('foods')) === 0) {
    await putAll('foods', SEED_FOODS);
  }
  await setMeta('shared-seeded', true);
}

export async function seedUserIfEmpty(user) {
  const key = `user-seeded-${user}`;
  const already = await getMeta(key);
  if (already) return;

  if ((await count('dayTargets')) === 0) {
    await putAll('dayTargets', WEEKDAYS.map(weekday => ({ weekday, kcal: null, protein: null })));
  }
  if (user === 'yannick' && (await count('weightLog')) === 0) {
    await putAll('weightLog', YANNICK_SEED_WEIGHT);
  }
  await setMeta(key, true);
}
