import { countFromServer, putAll } from './db.js';
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
    unit: 'g',
    tags: ['breakfast'],
  },
];

// Every seed check asks the server, never the local cache. A cold cache on a new device reads
// as empty, which would otherwise re-seed data that already exists and create duplicates.
// A null count means the server was unreachable — in that case seed nothing.
export async function seedSharedIfEmpty() {
  const foods = await countFromServer('foods');
  if (foods === null || foods > 0) return;
  await putAll('foods', SEED_FOODS);
}

export async function seedUserIfEmpty() {
  const targets = await countFromServer('dayTargets');
  if (targets === null || targets > 0) return;
  await putAll('dayTargets', WEEKDAYS.map(weekday => ({ weekday, kcal: null, protein: null })));
}
