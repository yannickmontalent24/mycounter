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

// Every seed check asks the server, never the local Firestore cache. A cold cache on a new
// device reads as empty, which would otherwise re-seed data that already exists and create
// duplicates. A null count means the server was unreachable — in that case seed nothing.
//
// That server round trip is wasted work on every boot after the first, though — once a check
// has passed on this device it can never become false again, so the fact itself (not the data)
// is cached in localStorage and the network call is skipped from then on. A fresh device has no
// flag, so it still runs the real check exactly once, which is what keeps this safe.
function seeded(scope) {
  try { return localStorage.getItem(`calorie-tracker:seeded:${scope}`) === '1'; } catch { return false; }
}
function markSeeded(scope) {
  try { localStorage.setItem(`calorie-tracker:seeded:${scope}`, '1'); } catch { /* best effort */ }
}

export async function seedSharedIfEmpty() {
  if (seeded('shared')) return;
  const foods = await countFromServer('foods');
  if (foods === null) return;
  if (foods === 0) await putAll('foods', SEED_FOODS);
  markSeeded('shared');
}

export async function seedUserIfEmpty(uid) {
  const scope = `user:${uid}`;
  if (seeded(scope)) return;
  const targets = await countFromServer('dayTargets');
  if (targets === null) return;
  if (targets === 0) await putAll('dayTargets', WEEKDAYS.map(weekday => ({ weekday, kcal: null, protein: null })));
  markSeeded(scope);
}
