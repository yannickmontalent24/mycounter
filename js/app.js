import * as db from './db.js';
import { seedSharedIfEmpty, seedUserIfEmpty } from './seed.js';
import {
  resolveTarget, weekdayOf, ringDash, entryMacros,
  foodPortionMacros, recipePerGram, recipePortionMacros, validateFood, validateRecipe, formatDateHeader,
  isDraftRecipe, findSimilarFoods, unitOf,
  MEALS, MEAL_LABELS, inferMeal, groupEntriesByMeal, sumMacros, resolveEntriesForDisplay,
  COOK_CATEGORIES, estimateCookedWeightG, splitFoodLibrary, sortFoods, FOOD_SORTS,
  weightSeries, averageWeight,
  bundleMacros, bundleItemMacros, validateBundle,
} from './logic.js';
import {
  exportDay, exportRange, prepareImport, commitImport, exportLibraryForClaude, ImportError,
} from './import-export.js';
import { login, logout, onUserChanged, accountLabel, friendlyAuthError } from './auth.js';
import { findLegacyData, uploadShared, uploadAccount, alreadyMigrated, markMigrated } from './migrate.js';
import { PHASES, activePhase, weekNumberFor, defaultDayIndex } from './workouts.js';
import { initPullToRefresh } from './pull-refresh.js';

// Safari (and standalone iOS webviews) still dispatch these non-standard gesture events for
// pinch even when touch-action forbids zooming, so they need their own preventDefault.
for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
  document.addEventListener(type, e => e.preventDefault());
}

const WEEKDAY_ROWS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const WEEKDAY_LABELS = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };
const SOURCE_GLYPH = { label: '■', reference: '□', estimate: '◇' };

// A single configured race date drives the Today countdown chip (redesign §State).
const RACE_DATE = '2026-10-25';
function daysToRace(fromISO = todayISO()) {
  const [ry, rm, rd] = RACE_DATE.split('-').map(Number);
  const [fy, fm, fd] = fromISO.split('-').map(Number);
  return Math.round((Date.UTC(ry, rm - 1, rd) - Date.UTC(fy, fm - 1, fd)) / 86400000);
}

// Thousands separator for the figures that get large (calories). Small numbers pass through.
function fmt(n) {
  return Math.round(n).toLocaleString('en-US');
}

// A consistent 1.8px-stroke icon set for the badges — replaces the placeholder Unicode glyphs
// from the handoff. currentColor so each badge's own colour flows through.
const BADGE_ICON_PATHS = {
  label: '<rect x="2.5" y="4" width="11" height="8" rx="1.5"/><path d="M2.5 8h11"/>',
  reference: '<path d="M3.5 3h6a2 2 0 012 2v8h-6a2 2 0 01-2-2z"/><path d="M6 6h4M6 9h3"/>',
  estimate: '<circle cx="8" cy="8" r="5" stroke-dasharray="2.2 2"/>',
  draft: '<path d="M4.5 3h7M4.5 13h7M5.5 3c0 3 2 4 2.5 5 .5-1 2.5-2 2.5-5M5.5 13c0-3 2-4 2.5-5 .5 1 2.5 2 2.5 5"/>',
  recipe: '<path d="M2.8 7h10.4a5.2 5.2 0 01-10.4 0z"/><path d="M6 4.3c0-1 .6-1.6 1-2.1M9 4.3c0-1 .6-1.6 1-2.1"/>',
  readonly: '<rect x="3.5" y="7" width="9" height="6.5" rx="1.3"/><path d="M5.6 7V5a2.4 2.4 0 014.8 0v2"/>',
  synced: '<path d="M12.7 4.6A5 5 0 003.4 6.2M3 3.6v2.8h2.8M3.3 11.4a5 5 0 009.3-1.6M13 12.4V9.6h-2.8"/>',
  offline: '<path d="M4.7 11.5a3 3 0 01-.4-6 4.3 4.3 0 018.1.6"/><path d="M2 2.5l12 11.5"/>',
};
function badgeIcon(name) {
  return `<svg class="badge-ic" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${BADGE_ICON_PATHS[name] || ''}</svg>`;
}

// Provenance / kind badge for a resolved log entry.
function entryBadge(e) {
  if (e.isRecipe) return `<span class="badge badge-recipe">${badgeIcon('recipe')} recipe</span>`;
  return sourceBadge(e.source);
}
function sourceBadge(source) {
  const map = {
    label: ['badge-label', 'label'],
    reference: ['badge-reference', 'reference'],
    estimate: ['badge-estimate', 'estimate'],
  };
  const [cls, name] = map[source] || map.estimate;
  return `<span class="badge ${cls}">${badgeIcon(name)} ${name}</span>`;
}

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function isoDaysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      return true;
    } catch {
      return false;
    }
  }
}

let toastTimer = null;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

// ---- In-memory cache, refreshed from Firestore after any mutation ----
const cache = { foods: [], recipes: [], bundles: [], dayTargets: [], overrides: [], weightLog: [], foodFrequency: new Map() };

// Last computed Today totals + target, so the Log screen's "kcal left" preview doesn't need
// its own fetch. Refreshed by renderToday.
let lastToday = { kcal: 0, protein: 0, target: { kcal: null, protein: null } };

// Split so boot can paint Today (which only needs the "essential" half) as soon as possible,
// then fill in weightLog/foodFrequency — needed only by Settings and the quick-log
// favourites — in the background rather than making the first screen wait on them too.
async function refreshEssentialCache() {
  const [foods, recipes, bundles, dayTargets, overrides] = await Promise.all([
    db.getAll('foods'), db.getAll('recipes'), db.getAll('bundles'), db.getAll('dayTargets'), db.getAll('dayTargetOverrides'),
  ]);
  cache.foods = foods;
  cache.recipes = recipes;
  cache.bundles = bundles;
  cache.dayTargets = dayTargets;
  cache.overrides = overrides;
}

async function refreshBackgroundCache() {
  const [weightLog, recent] = await Promise.all([
    db.getAll('weightLog'),
    // How often each food has been logged recently, so the Log screen can lead with the foods
    // actually eaten rather than whatever happens to sort first.
    db.entriesInRange(isoDaysAgo(60), todayISO()),
  ]);
  cache.weightLog = weightLog.sort((a, b) => b.date.localeCompare(a.date));
  const freq = new Map();
  for (const e of recent) {
    const key = e.foodId ? `food:${e.foodId}` : (e.recipeId ? `recipe:${e.recipeId}` : null);
    if (!key) continue;
    freq.set(key, (freq.get(key) ?? 0) + 1);
  }
  cache.foodFrequency = freq;
}

// Used after any mutation, where everything needs to be current — as opposed to boot, which
// calls the two halves above separately so it can paint before the background half lands.
async function refreshCache() {
  await Promise.all([refreshEssentialCache(), refreshBackgroundCache()]);
}

function foodsById() { return new Map(cache.foods.map(f => [f.id, f])); }
function recipesById() { return new Map(cache.recipes.map(r => [r.id, r])); }
function bundlesById() { return new Map(cache.bundles.map(b => [b.id, b])); }

// ---- Routing ----
const SCREENS = ['today', 'log', 'foods', 'workouts', 'history', 'weight', 'settings'];

function currentScreenFromHash() {
  const h = location.hash.replace('#', '');
  return SCREENS.includes(h) ? h : 'today';
}

function goTo(screen) {
  location.hash = screen;
}

let previousScreen = null;

function renderRoute() {
  const screen = currentScreenFromHash();
  // Leaving the Log tab mid-backdate shouldn't let a stale date silently carry into a later,
  // unrelated visit — logState is defined further down but this only ever runs after the
  // whole module has evaluated, so it's already initialized by the time this executes.
  if (previousScreen === 'log' && screen !== 'log') {
    logState.date = null;
  }
  previousScreen = screen;
  for (const s of SCREENS) {
    document.getElementById(`screen-${s}`).hidden = s !== screen;
  }
  // History and the body-weight log have no tab of their own — they sit under Settings, so
  // Settings stays lit while they're open rather than leaving no tab highlighted at all.
  const tabForScreen = (screen === 'history' || screen === 'weight') ? 'settings' : screen;
  document.querySelectorAll('.tab-btn').forEach(btn => {
    const active = btn.dataset.go === tabForScreen;
    btn.classList.toggle('active', active);
    btn.querySelector('.indicator').textContent = active ? '━' : '';
  });
  const renderers = {
    today: renderToday, log: renderLog, foods: renderLibrary,
    workouts: renderWorkouts, history: renderHistory, weight: renderWeight, settings: renderSettings,
  };
  renderers[screen]();
}

window.addEventListener('hashchange', renderRoute);
document.querySelectorAll('.tab-btn').forEach(btn => btn.addEventListener('click', () => goTo(btn.dataset.go)));

// ==================== TODAY ====================
// Small inline spinner for a section whose fetch is in flight — distinct from the full-screen
// splash, which only covers boot. Kept generic so Today, History, and the day-detail sheet
// (whose entries are always at least one Firestore round-trip away) all show the same thing.
function showSectionLoading(container) {
  container.innerHTML = '<div class="rd-skeleton" role="status" aria-label="Loading">'
    + '<div class="rd-skeleton-bar" style="width:60%"></div>'
    + '<div class="rd-skeleton-bar" style="width:85%"></div>'
    + '<div class="rd-skeleton-bar" style="width:40%"></div></div>';
}

async function renderToday({ scrollToMeal = null } = {}) {
  const dateStr = todayISO();
  document.getElementById('today-date-chip').textContent = formatDateHeader(dateStr);

  const dtr = daysToRace(dateStr);
  const raceChip = document.getElementById('today-race-chip');
  if (dtr > 0) {
    document.getElementById('today-race-n').textContent = dtr;
    raceChip.hidden = false;
  } else {
    raceChip.hidden = true;
  }

  showSectionLoading(document.getElementById('today-entry-list'));

  const entries = await db.entriesInRange(dateStr, dateStr);
  const resolved = resolveEntriesForDisplay(entries, foodsById(), recipesById());

  const kcalTotal = resolved.reduce((a, e) => a + e.kcal, 0);
  const protTotal = resolved.reduce((a, e) => a + e.protein, 0);
  const target = resolveTarget(cache.dayTargets, cache.overrides, dateStr, weekdayOf(dateStr));

  applyHero('kcal', kcalTotal, target.kcal);
  applyHero('protein', protTotal, target.protein);
  lastToday = { kcal: kcalTotal, protein: protTotal, target };

  document.getElementById('today-day-kcal').innerHTML = `${fmt(kcalTotal)} <span>kcal</span>`;
  document.getElementById('today-day-protein').innerHTML = `${fmt(protTotal)} <span>g</span>`;

  const list = document.getElementById('today-entry-list');
  list.innerHTML = '';

  const { groups, unsorted } = groupEntriesByMeal(resolved);
  for (const meal of MEALS) {
    list.appendChild(buildMealSection(meal, MEAL_LABELS[meal], groups.get(meal), { canAdd: true }));
  }
  if (unsorted.length) {
    list.appendChild(buildMealSection(null, 'Not assigned', unsorted, { canAdd: false }));
  }

  // Logging (or editing/deleting) something re-fetches and rebuilds this whole list, which
  // would otherwise always land the scroll position back at Breakfast — annoying when you're
  // three meals in. Callers that know which meal they just touched ask to be scrolled back to it.
  if (scrollToMeal) {
    document.getElementById(`meal-section-${scrollToMeal}`)?.scrollIntoView({ block: 'start' });
  }
}

// One section per meal. Empty sections still render, because their "+" is the way to log
// into that meal (feature brief §3) — but they stay compact so the day is still scannable.
// `interactive: false` (used by the read-only day-detail view for past dates) drops the add/
// delete/move controls and just shows what was eaten.
function buildMealSection(meal, label, entries, { canAdd, interactive = true } = {}) {
  entries = entries || [];
  const totals = sumMacros(entries);
  const section = el(`
    <section class="meal-card" id="meal-section-${meal ?? 'unassigned'}">
      <div class="meal-card-head">
        <div class="l">
          <span class="name">${escapeHtml(label)}</span>
          <span class="sub">${entries.length ? `${totals.kcal} · ${totals.protein} g` : ''}</span>
        </div>
        ${canAdd ? `<button type="button" class="meal-card-add" data-add-meal="${meal}" aria-label="Log food under ${escapeHtml(label)}"><span aria-hidden="true">+</span></button>` : ''}
      </div>
      <div class="meal-rows"></div>
    </section>
  `);

  const rows = section.querySelector('.meal-rows');
  if (!entries.length) {
    const well = el(`<div class="meal-empty-well">Nothing logged for ${escapeHtml(label)}</div>`);
    if (canAdd) {
      well.append(' · ');
      const b = el('<button type="button">add something</button>');
      b.addEventListener('click', () => openLogSheet(meal));
      well.append(b);
    }
    rows.appendChild(well);
  }
  for (const e of entries) {
    const row = el(`
      <div class="meal-entry">
        ${interactive
          ? `<button type="button" class="meal-entry-main" data-edit-entry="${e.id}" aria-label="Edit ${escapeHtml(e.name)}">
               <span class="meal-entry-name">${escapeHtml(e.name)}</span>
               <span class="meal-entry-meta"><span class="meal-entry-amt">${e.grams} ${e.unit}</span>${entryBadge(e)}</span>
             </button>`
          : `<div class="meal-entry-main">
               <span class="meal-entry-name">${escapeHtml(e.name)}</span>
               <span class="meal-entry-meta"><span class="meal-entry-amt">${e.grams} ${e.unit}</span>${entryBadge(e)}</span>
             </div>`}
        <span class="meal-entry-figs"><span class="k">${e.kcal}</span><span class="p">${e.protein} g P</span></span>
        ${interactive ? `
          <button type="button" class="meal-entry-act" data-move-entry="${e.id}" aria-label="Change meal for ${escapeHtml(e.name)}">⇄</button>
          <button type="button" class="meal-entry-act is-delete" data-del-entry="${e.id}" aria-label="Delete ${escapeHtml(e.name)}">×</button>
        ` : ''}
      </div>
    `);
    if (interactive) {
      row.querySelector('[data-edit-entry]').addEventListener('click', () => openEditEntryModal(e.id));
      row.querySelector('[data-del-entry]').addEventListener('click', async () => {
        await db.remove('logEntries', e.id);
        renderToday({ scrollToMeal: e.meal });
      });
      row.querySelector('[data-move-entry]').addEventListener('click', () => openMealPicker(e));
    }
    rows.appendChild(row);
  }

  const addBtn = section.querySelector('[data-add-meal]');
  if (addBtn) addBtn.addEventListener('click', () => openLogSheet(meal));
  return section;
}

// ==================== QUICK LOG SHEET ====================
// Logging happens where the day is being read, rather than sending the user to another tab
// and back. Same maths as the Log screen; the tab remains for anything more involved.
const sheetState = { meal: 'lunch', query: '', pickedId: null, pickedKind: null, grams: '' };

function loggableItems() {
  return [
    ...cache.foods.map(f => ({ kind: 'food', record: f })),
    ...cache.recipes.filter(r => !isDraftRecipe(r)).map(r => ({ kind: 'recipe', record: r })),
  ];
}

function frequencyOf(kind, id) {
  return cache.foodFrequency.get(`${kind}:${id}`) ?? 0;
}

// "Favourites" are earned, not curated — whatever actually gets logged most, so the common
// case needs no typing at all.
function favouriteItems(limit = 6) {
  return loggableItems()
    .map(c => ({ ...c, count: frequencyOf(c.kind, c.record.id) }))
    .filter(c => c.count > 0)
    .sort((a, b) => b.count - a.count || a.record.name.localeCompare(b.record.name))
    .slice(0, limit);
}

// Logging a bundle fans out into one ordinary logEntry per item rather than a new kind of
// entry — same date/meal/timestamp, so it reads in Today exactly like logging each item by
// hand, and stays individually editable afterwards.
function bundleToLogEntries(bundle, meal, date = todayISO()) {
  const loggedAt = new Date().toISOString();
  return bundle.items.map(item => ({
    id: crypto.randomUUID(),
    date,
    foodId: item.kind === 'food' ? item.id : null,
    recipeId: item.kind === 'recipe' ? item.id : null,
    grams: item.grams,
    meal,
    loggedAt,
  }));
}

async function logBundle(bundle, meal) {
  await db.putAll('logEntries', bundleToLogEntries(bundle, meal));
  // Logging touches only logEntries — nothing the essential cache holds. The one thing that
  // does drift is the quick-log frequency map, so refresh that in the background rather than
  // making the sheet sit there through a full re-fetch of foods/recipes/bundles/targets.
  refreshBackgroundCache().then(renderRoute).catch(() => {});
}

function sheetPicked() {
  if (!sheetState.pickedId) return null;
  return sheetState.pickedKind === 'recipe'
    ? recipesById().get(sheetState.pickedId)
    : foodsById().get(sheetState.pickedId);
}

function sheetUnit() {
  if (sheetState.pickedKind === 'recipe') return 'g';
  return unitOf(sheetPicked());
}

function openLogSheet(meal) {
  sheetState.meal = meal;
  sheetState.query = '';
  sheetState.pickedId = null;
  sheetState.pickedKind = null;
  sheetState.grams = '';

  openModal(`
    <div class="sheet-head">
      <h2 style="margin:0;">Add to ${escapeHtml(MEAL_LABELS[meal])}</h2>
      <button type="button" class="meal-chip" id="sheet-meal-chip">${escapeHtml(MEAL_LABELS[meal])}</button>
    </div>
    <input class="text-input" id="sheet-search" type="text" placeholder="Search foods and recipes" autocomplete="off" style="margin-bottom:6px;">
    <div class="section-label" id="sheet-bundles-label" style="margin:12px 0 0;" hidden>Bundles — tap to log all at once</div>
    <div class="search-results" id="sheet-bundles" hidden></div>
    <div class="section-label" id="sheet-list-label" style="margin:12px 0 0;">Favourites</div>
    <div class="search-results" id="sheet-results"></div>
    <div id="sheet-amount" hidden>
      <div class="section-label" id="sheet-amount-label" style="margin-top:16px;">Amount (g)</div>
      <div class="amount-row">
        <button type="button" class="stepper-btn" id="sheet-minus" aria-label="Decrease by 10">−</button>
        <div class="amount-field">
          <input id="sheet-grams" type="text" inputmode="numeric" maxlength="4" aria-label="Amount">
          <span class="unit" id="sheet-unit">g</span>
        </div>
        <button type="button" class="stepper-btn" id="sheet-plus" aria-label="Increase by 10">+</button>
      </div>
      <div class="draft-summary">
        <span class="name" id="sheet-draft-name">Nothing selected</span>
        <span class="macros" id="sheet-draft-macros">—</span>
      </div>
    </div>
    <div class="modal-actions">
      <button type="button" class="secondary-btn" id="sheet-cancel">Cancel</button>
      <button type="button" class="primary-btn" id="sheet-add" disabled>Add</button>
    </div>
  `);

  document.getElementById('sheet-cancel').addEventListener('click', closeModal);
  document.getElementById('sheet-search').addEventListener('input', e => {
    sheetState.query = e.target.value;
    renderSheetResults();
    renderSheetBundles();
  });
  document.getElementById('sheet-meal-chip').addEventListener('click', () => {
    sheetState.meal = MEALS[(MEALS.indexOf(sheetState.meal) + 1) % MEALS.length];
    document.getElementById('sheet-meal-chip').textContent = MEAL_LABELS[sheetState.meal];
    document.querySelector('#modal-sheet h2').textContent = `Add to ${MEAL_LABELS[sheetState.meal]}`;
  });
  document.getElementById('sheet-minus').addEventListener('click', () => adjustSheetGrams(-10));
  document.getElementById('sheet-plus').addEventListener('click', () => adjustSheetGrams(10));
  document.getElementById('sheet-grams').addEventListener('input', e => {
    sheetState.grams = e.target.value.replace(/[^0-9]/g, '').slice(0, 4);
    e.target.value = sheetState.grams;
    renderSheetDraft();
  });
  document.getElementById('sheet-add').addEventListener('click', confirmSheetLog);

  renderSheetResults();
  renderSheetBundles();
}

// Bundles only surface unfiltered, above Favourites — they're already named and curated, so
// they don't need to earn their place the way food favourites do, and searching them alongside
// individual foods would blur "log one thing" with "log everything I usually have".
function renderSheetBundles() {
  const label = document.getElementById('sheet-bundles-label');
  const container = document.getElementById('sheet-bundles');
  const show = !sheetState.query.trim() && cache.bundles.length > 0;
  label.hidden = !show;
  container.hidden = !show;
  if (!show) return;

  container.innerHTML = '';
  const fMap = foodsById(), rMap = recipesById();
  for (const b of cache.bundles) {
    const macros = bundleMacros(b, fMap, rMap);
    const btn = el(`
      <button type="button" class="search-result-btn">
        <span class="name">${escapeHtml(b.name)}</span>
        <span class="per100">${b.items.length} item${b.items.length === 1 ? '' : 's'} · ${macros.kcal} kcal · ${macros.protein} g</span>
        <span class="check">➜</span>
      </button>
    `);
    btn.addEventListener('click', async () => {
      await logBundle(b, sheetState.meal);
      closeModal();
      renderToday({ scrollToMeal: sheetState.meal });
      toast(`Logged ${b.name}`);
    });
    container.appendChild(btn);
  }
}

function adjustSheetGrams(delta) {
  const next = Math.max(10, (parseInt(sheetState.grams, 10) || 0) + delta);
  sheetState.grams = String(next);
  document.getElementById('sheet-grams').value = sheetState.grams;
  renderSheetDraft();
}

function renderSheetResults() {
  const q = sheetState.query.trim().toLowerCase();
  const label = document.getElementById('sheet-list-label');
  let results;

  if (q) {
    results = loggableItems()
      .filter(c => c.record.name.toLowerCase().includes(q))
      .sort((a, b) => frequencyOf(b.kind, b.record.id) - frequencyOf(a.kind, a.record.id)
        || a.record.name.localeCompare(b.record.name))
      .slice(0, 6);
    label.textContent = 'Results';
  } else {
    results = favouriteItems();
    label.textContent = results.length ? 'Favourites — most logged' : 'Start typing to find a food';
  }

  const container = document.getElementById('sheet-results');
  container.innerHTML = '';
  for (const { kind, record, count } of results) {
    const selected = sheetState.pickedId === record.id && sheetState.pickedKind === kind;
    const meta = kind === 'recipe'
      ? 'recipe'
      : `${record.per100g.kcal} kcal /100${unitOf(record)}`;
    const btn = el(`
      <button type="button" class="search-result-btn">
        <span class="name">${escapeHtml(record.name)}</span>
        <span class="per100">${escapeHtml(meta)}${count ? ` · ×${count}` : ''}</span>
        <span class="check">${selected ? '●' : '○'}</span>
      </button>
    `);
    btn.addEventListener('click', () => {
      sheetState.pickedId = record.id;
      sheetState.pickedKind = kind;
      sheetState.grams = String(kind === 'recipe' ? onePortionGrams(record) : (record.defaultPortionG ?? 100));
      document.getElementById('sheet-grams').value = sheetState.grams;
      document.getElementById('sheet-amount').hidden = false;
      const unit = sheetUnit();
      document.getElementById('sheet-unit').textContent = unit;
      document.getElementById('sheet-amount-label').textContent = unit === 'ml' ? 'Amount (ml)' : 'Amount (g)';
      renderSheetResults();
      renderSheetDraft();
    });
    container.appendChild(btn);
  }

  if (q && results.length === 0) {
    container.appendChild(el(`<div class="meal-empty">No match. Use the Log tab to add a new food.</div>`));
  }
}

function renderSheetDraft() {
  const picked = sheetPicked();
  const nameEl = document.getElementById('sheet-draft-name');
  const macrosEl = document.getElementById('sheet-draft-macros');
  const addBtn = document.getElementById('sheet-add');
  const grams = parseInt(sheetState.grams, 10) || 0;

  if (!picked || !grams) {
    nameEl.textContent = picked ? picked.name : 'Nothing selected';
    macrosEl.textContent = '—';
    addBtn.disabled = true;
    return;
  }
  try {
    const m = sheetState.pickedKind === 'recipe'
      ? recipePortionMacros(picked, foodsById(), grams)
      : foodPortionMacros(picked, grams);
    nameEl.textContent = picked.name;
    macrosEl.textContent = `${m.kcal} kcal · ${m.protein} g`;
    addBtn.disabled = false;
  } catch {
    macrosEl.textContent = 'missing ingredient';
    addBtn.disabled = true;
  }
}

async function confirmSheetLog() {
  const grams = parseInt(sheetState.grams, 10) || 0;
  if (!sheetState.pickedId || !grams) return;
  const isRecipe = sheetState.pickedKind === 'recipe';
  const addBtn = document.getElementById('sheet-add');
  addBtn.disabled = true;
  await db.put('logEntries', {
    id: crypto.randomUUID(),
    date: todayISO(),
    foodId: isRecipe ? null : sheetState.pickedId,
    recipeId: isRecipe ? sheetState.pickedId : null,
    grams,
    meal: sheetState.meal,
    loggedAt: new Date().toISOString(),
  });
  closeModal();
  renderToday({ scrollToMeal: sheetState.meal });
  // Only the quick-log frequency map can be stale now; refresh it without blocking the sheet.
  refreshBackgroundCache().catch(() => {});
}

async function openMealPicker(entry) {
  const stored = await db.get('logEntries', entry.id);
  if (!stored) return;
  const origMeal = stored.meal ?? null;
  const origDate = stored.date;
  const state = { meal: origMeal, date: origDate };

  // Per-meal subtotals for that day, so each row shows what it already holds.
  const dayEntries = await db.entriesInRange(origDate, origDate);
  const resolved = resolveEntriesForDisplay(dayEntries, foodsById(), recipesById());
  const subOf = meal => {
    const s = resolved.filter(e => e.meal === meal).reduce((a, e) => ({ kcal: a.kcal + e.kcal, protein: a.protein + e.protein }), { kcal: 0, protein: 0 });
    return `${s.kcal} kcal · ${s.protein} g`;
  };

  openModal(`
    <div class="sheet">
      <div class="sheet-titleblock">
        <div class="sheet-title-row">
          <h2>Move to</h2>
          <button type="button" class="sheet-cancel" id="mp-cancel">Cancel</button>
        </div>
        <div class="sub">${escapeHtml(entry.name)} · ${entry.grams} ${entry.unit}</div>
      </div>

      <div class="sheet-card" id="mp-list">
        ${MEALS.map(m => `
          <button type="button" class="sheet-select-row" data-meal="${m}">
            <span style="flex:1; display:flex; flex-direction:column; gap:2px;">
              <span style="font-size:15px;">${MEAL_LABELS[m]}</span>
              <span class="u-figure" style="font-size:12px; color:var(--text-secondary);">${subOf(m)}</span>
            </span>
            ${m === origMeal ? '<span class="eyebrow" style="letter-spacing:0.08em;">now here</span>' : ''}
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" hidden><path d="M5 12.5l4.5 4.5L19 7.5"></path></svg>
          </button>`).join('')}
      </div>

      <div class="sheet-row">
        <span>Day</span>
        <input type="date" class="sheet-date-chip" id="mp-date" max="${todayISO()}" value="${origDate}" aria-label="Day">
      </div>

      <button type="button" class="sheet-primary" id="mp-save" disabled>Move entry</button>
    </div>
  `);

  const rows = [...document.querySelectorAll('#mp-list .sheet-select-row')];
  const saveBtn = document.getElementById('mp-save');
  const paint = () => {
    rows.forEach(r => {
      const on = r.dataset.meal === state.meal;
      r.classList.toggle('active', on);
      r.querySelector('svg').hidden = !on;
    });
    saveBtn.disabled = (state.meal === origMeal && state.date === origDate);
  };
  paint();

  rows.forEach(r => r.addEventListener('click', () => { state.meal = r.dataset.meal; paint(); }));
  document.getElementById('mp-date').addEventListener('change', e => { state.date = e.target.value || origDate; paint(); });
  document.getElementById('mp-cancel').addEventListener('click', closeModal);
  saveBtn.addEventListener('click', async () => {
    await db.put('logEntries', { ...stored, meal: state.meal, date: state.date });
    closeModal();
    renderToday({ scrollToMeal: state.date === todayISO() ? state.meal : null });
  });
}

// Tapping an entry's name/amount opens this to change how much was logged — the quick
// delete (×) and move-meal (⇄) buttons on the row stay for the fast path, this is for
// "actually I had more/less than that".
async function openEditEntryModal(entryId) {
  const entry = await db.get('logEntries', entryId);
  if (!entry) return;
  const isRecipe = entry.recipeId != null;
  const record = isRecipe ? recipesById().get(entry.recipeId) : foodsById().get(entry.foodId);
  if (!record) { toast('That item no longer exists in your library'); return; }
  const unit = isRecipe ? 'g' : unitOf(record);

  openModal(`
    <h2>Edit entry</h2>
    <p style="font-size:0.8125rem; color:var(--text-secondary); margin-top:0;">${escapeHtml(record.name)}</p>
    <div class="section-label" style="margin-top:6px;">Amount (${unit})</div>
    <div class="amount-row">
      <button type="button" class="stepper-btn" id="ee-minus" aria-label="Decrease by 10">−</button>
      <div class="amount-field">
        <input id="ee-grams" type="text" inputmode="numeric" maxlength="4" aria-label="Amount" value="${entry.grams}">
        <span class="unit">${unit}</span>
      </div>
      <button type="button" class="stepper-btn" id="ee-plus" aria-label="Increase by 10">+</button>
    </div>
    <div class="draft-summary">
      <span class="name">${escapeHtml(record.name)}</span>
      <span class="macros" id="ee-macros">—</span>
    </div>
    <div class="modal-actions">
      <button type="button" class="secondary-btn" id="ee-delete">Delete</button>
      <button type="button" class="primary-btn" id="ee-save">Save</button>
    </div>
  `);

  function currentGrams() {
    return parseInt(document.getElementById('ee-grams').value, 10) || 0;
  }
  function updatePreview() {
    const g = currentGrams();
    const macrosEl = document.getElementById('ee-macros');
    if (!g) { macrosEl.textContent = '—'; return; }
    try {
      const m = isRecipe ? recipePortionMacros(record, foodsById(), g) : foodPortionMacros(record, g);
      macrosEl.textContent = `${m.kcal} kcal · ${m.protein} g`;
    } catch {
      macrosEl.textContent = 'missing ingredient';
    }
  }
  updatePreview();

  document.getElementById('ee-grams').addEventListener('input', e => {
    e.target.value = e.target.value.replace(/[^0-9]/g, '').slice(0, 4);
    updatePreview();
  });
  document.getElementById('ee-minus').addEventListener('click', () => {
    document.getElementById('ee-grams').value = Math.max(1, currentGrams() - 10);
    updatePreview();
  });
  document.getElementById('ee-plus').addEventListener('click', () => {
    document.getElementById('ee-grams').value = currentGrams() + 10;
    updatePreview();
  });
  document.getElementById('ee-delete').addEventListener('click', async () => {
    await db.remove('logEntries', entry.id);
    closeModal();
    renderToday({ scrollToMeal: entry.meal });
  });
  document.getElementById('ee-save').addEventListener('click', async () => {
    const grams = currentGrams();
    if (!grams) return;
    await db.put('logEntries', { ...entry, grams });
    closeModal();
    renderToday({ scrollToMeal: entry.meal });
  });
}

// kind: 'kcal' | 'protein'. For protein, reaching or passing the target is a *win*
// (navy, "target met"); for calories, passing it is a *warning* (crimson, "over").
function applyHero(kind, consumed, target) {
  const numEl = document.getElementById(`hero-${kind}-num`);
  const stateEl = document.getElementById(`hero-${kind}-state`);
  const subEl = document.getElementById(`hero-${kind}-sub`);
  const ringEl = document.getElementById(`ring-${kind}`);
  const trackEl = ringEl.previousElementSibling;
  const C = '276.5';
  const unit = kind === 'kcal' ? 'kcal' : 'g';

  const setState = (text, over) => {
    if (!text) { stateEl.hidden = true; return; }
    stateEl.hidden = false;
    stateEl.textContent = text;
    stateEl.classList.toggle('is-over', !!over);
  };

  if (target == null) {
    numEl.textContent = '—';
    numEl.classList.remove('is-over');
    setState(null);
    subEl.textContent = `${fmt(consumed)} ${unit} logged · no target set`;
    subEl.classList.add('plain');
    ringEl.setAttribute('stroke-dasharray', `0 ${C}`);
    trackEl.setAttribute('stroke-dasharray', '6 10');
    return;
  }

  subEl.classList.remove('plain');
  trackEl.removeAttribute('stroke-dasharray');
  ringEl.setAttribute('stroke-dasharray', ringDash(consumed, target));

  const remaining = target - consumed;
  const ofTarget = `${fmt(consumed)} / ${fmt(target)} ${unit}`;

  if (consumed === 0) {
    numEl.textContent = fmt(target);
    numEl.classList.remove('is-over');
    setState(null);
    subEl.textContent = kind === 'kcal' ? 'the whole day ahead' : `${fmt(target)} g to go`;
    return;
  }

  if (kind === 'protein' && remaining <= 0) {
    numEl.textContent = `+${fmt(-remaining)}`;
    numEl.classList.remove('is-over');
    setState('✓ target met', false);
    subEl.textContent = ofTarget;
    return;
  }

  if (kind === 'kcal' && remaining < 0) {
    numEl.textContent = `+${fmt(-remaining)}`;
    numEl.classList.add('is-over');
    setState('▲ over', true);
    subEl.textContent = ofTarget;
    return;
  }

  numEl.textContent = fmt(remaining);
  numEl.classList.remove('is-over');
  setState(null);
  subEl.textContent = ofTarget;
}

document.getElementById('export-day-btn').addEventListener('click', async () => {
  const text = await exportDay(todayISO());
  const ok = await copyText(text);
  toast(ok ? 'Copied today’s log' : 'Could not copy — check clipboard permission');
});

// ==================== LOG ENTRY ====================
// `meal` is null until the user logs, at which point it's inferred from the clock — unless
// they arrived via a section's "+", which sets it explicitly. `date` is null until the date
// chip is changed away from today, so logging normally needs no date handling at all.
const logState = { query: '', pickedId: null, pickedKind: null, grams: '', meal: null, date: null };

function pickedRecord() {
  if (!logState.pickedId) return null;
  return logState.pickedKind === 'recipe'
    ? recipesById().get(logState.pickedId)
    : foodsById().get(logState.pickedId);
}

function currentLogUnit() {
  // A batch is weighed, so recipe amounts are always grams.
  if (logState.pickedKind === 'recipe') return 'g';
  return unitOf(pickedRecord());
}

// Per-100 g figures for a recipe, so a weighed plateful can be sanity-checked.
// Returns null when an ingredient food is missing or the batch isn't weighed yet.
function recipePer100(recipe) {
  if (isDraftRecipe(recipe)) return null;
  try {
    const perGram = recipePerGram(recipe, foodsById());
    return { kcal: Math.round(perGram.kcal * 100), protein: Math.round(perGram.protein * 100) };
  } catch {
    return null;
  }
}

function onePortionGrams(recipe) {
  return Math.round(recipe.cookedWeightG / recipe.portions);
}

function renderLog() {
  const input = document.getElementById('foodsearch');
  input.value = logState.query;
  renderLogResults();
  renderLogDraft();
  document.getElementById('gramsfield').value = logState.grams;

  // The amount field speaks the selected food's unit: drinks are logged in ml, never converted.
  const unit = currentLogUnit();
  document.getElementById('amount-unit').textContent = unit;
  document.getElementById('gramsfield').setAttribute('aria-label', `Amount in ${unit === 'ml' ? 'millilitres' : 'grams'}`);
  document.getElementById('grams-down').setAttribute('aria-label', `Decrease by 10 ${unit === 'ml' ? 'millilitres' : 'grams'}`);
  document.getElementById('grams-up').setAttribute('aria-label', `Increase by 10 ${unit === 'ml' ? 'millilitres' : 'grams'}`);

  const effectiveMeal = logState.meal ?? inferMeal();
  const chip = document.getElementById('log-meal-chip');
  chip.innerHTML = `${escapeHtml(MEAL_LABELS[effectiveMeal])} <span aria-hidden="true">▾</span>`;
  chip.setAttribute('aria-label', `Meal: ${MEAL_LABELS[effectiveMeal]}. Tap to change.`);

  // Backdating a missed day: defaults to today, capped so it can never be set to the future.
  const today = todayISO();
  const effectiveDate = logState.date ?? today;
  const dateInput = document.getElementById('log-date-input');
  dateInput.value = effectiveDate;
  dateInput.max = today;
  dateInput.setAttribute('aria-label', effectiveDate === today ? 'Change date — currently today' : `Change date — currently ${formatDateHeader(effectiveDate)}`);
  document.getElementById('confirm-log-btn').textContent = effectiveDate === today ? 'Add to today' : `Add to ${formatDateHeader(effectiveDate)}`;
}

document.getElementById('log-date-input').addEventListener('change', e => {
  const today = todayISO();
  const value = e.target.value;
  // An empty or (somehow) future value falls back to today rather than logging nothing.
  logState.date = (!value || value > today) ? null : value;
  renderLog();
});

// Tapping the chip cycles through the four meals — quicker than a picker for a one-off
// correction, and the current choice is always readable on the chip itself.
document.getElementById('log-meal-chip').addEventListener('click', () => {
  const current = logState.meal ?? inferMeal();
  logState.meal = MEALS[(MEALS.indexOf(current) + 1) % MEALS.length];
  renderLog();
});

function renderLogResults() {
  const q = logState.query.trim().toLowerCase();

  // Recipes are logged from here too, so a weighed plateful can be entered in grams rather
  // than assuming you ate exactly one equal share of the batch. Drafts are excluded — their
  // macros can't be resolved until the batch has been weighed.
  const candidates = [
    ...cache.foods.map(f => ({ kind: 'food', record: f })),
    ...cache.recipes.filter(r => !isDraftRecipe(r)).map(r => ({ kind: 'recipe', record: r })),
  ].filter(c => !q || c.record.name.toLowerCase().includes(q));

  // With no search term, lead with what actually gets eaten most — usually this means logging
  // needs no typing at all. Within a search, keep frequent items first too.
  const freq = cache.foodFrequency;
  const freqOf = c => freq.get(`${c.kind}:${c.record.id}`) ?? 0;
  candidates.sort((a, b) => {
    const diff = freqOf(b) - freqOf(a);
    return diff !== 0 ? diff : a.record.name.localeCompare(b.record.name);
  });
  const results = candidates.slice(0, 4);

  const hintEl = document.getElementById('log-results-hint');
  const showHint = !q && results.length > 0 && [...freq.values()].some(v => v > 0);
  hintEl.hidden = !showHint;

  const container = document.getElementById('log-search-results');
  container.innerHTML = '';
  for (const { kind, record } of results) {
    let per100Text;
    if (kind === 'recipe') {
      const per100 = recipePer100(record);
      per100Text = per100 ? `${per100.kcal} kcal · ${per100.protein} g P / 100 g` : 'unavailable';
    } else {
      per100Text = `${record.per100g.kcal} kcal · ${record.per100g.protein} g P / 100 ${unitOf(record)}`;
    }
    const selected = logState.pickedId === record.id && logState.pickedKind === kind;
    const badge = kind === 'recipe'
      ? '<span class="badge badge-recipe">▤ recipe</span>'
      : sourceBadge(record.source);
    const btn = el(`
      <button type="button" class="log-result${selected ? ' is-selected' : ''}" aria-pressed="${selected}">
        <span class="log-result-main">
          <span class="log-result-name">${escapeHtml(record.name)}</span>
          <span class="log-result-meta"><span class="log-result-per">${per100Text}</span>${badge}</span>
        </span>
        ${selected ? '<svg class="log-result-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"></path></svg>' : ''}
      </button>
    `);
    btn.addEventListener('click', () => {
      logState.pickedId = record.id;
      logState.pickedKind = kind;
      logState.grams = String(kind === 'recipe' ? onePortionGrams(record) : (record.defaultPortionG ?? 100));
      renderLog();
    });
    container.appendChild(btn);
  }

  // Nothing matched: offer to create it right here, rather than sending the user off to the
  // Library tab and back mid-log. This is the moment most likely to end a logging habit.
  if (q && results.length === 0) {
    const raw = logState.query.trim();
    const addBtn = el(`
      <button type="button" class="log-result log-result-add">
        <span class="plus" aria-hidden="true">+</span>
        <span class="txt">Add &ldquo;${escapeHtml(raw)}&rdquo; as a new food</span>
      </button>
    `);
    addBtn.addEventListener('click', () => openFoodModal(null, {
      prefillName: raw,
      onSaved: obj => {
        logState.query = '';
        logState.pickedId = obj.id;
        logState.pickedKind = 'food';
        logState.grams = String(obj.defaultPortionG);
        renderLog();
        toast(`Added ${obj.name}`);
      },
    }));
    container.appendChild(addBtn);
  }
}


function renderLogDraft() {
  const picked = pickedRecord();
  const kcalEl = document.getElementById('log-preview-kcal');
  const protEl = document.getElementById('log-preview-protein');
  const leftEl = document.getElementById('log-preview-left');
  const grams = parseInt(logState.grams, 10) || 0;

  let m = null;
  if (picked && grams) {
    try {
      m = logState.pickedKind === 'recipe'
        ? recipePortionMacros(picked, foodsById(), grams)
        : foodPortionMacros(picked, grams);
    } catch { m = null; }
  }

  if (!m) {
    kcalEl.textContent = '—';
    protEl.textContent = '—';
    leftEl.textContent = '—';
    return;
  }

  kcalEl.textContent = m.kcal;
  protEl.textContent = `${m.protein} g`;

  // "kcal left" = today's calorie target minus what's already logged today minus this draft.
  // Only meaningful when a target exists and we're logging for today, not backdating.
  const backdating = (logState.date ?? todayISO()) !== todayISO();
  const targetKcal = lastToday.target && lastToday.target.kcal;
  leftEl.textContent = (targetKcal && !backdating)
    ? fmt(targetKcal - lastToday.kcal - m.kcal)
    : '—';
}

document.getElementById('foodsearch').addEventListener('input', e => {
  logState.query = e.target.value;
  renderLogResults();
});

document.getElementById('grams-down').addEventListener('click', () => {
  const g = Math.max(10, (parseInt(logState.grams, 10) || 0) - 10);
  logState.grams = String(g);
  document.getElementById('gramsfield').value = logState.grams;
  renderLogDraft();
});
document.getElementById('grams-up').addEventListener('click', () => {
  const g = (parseInt(logState.grams, 10) || 0) + 10;
  logState.grams = String(g);
  document.getElementById('gramsfield').value = logState.grams;
  renderLogDraft();
});
document.getElementById('gramsfield').addEventListener('input', e => {
  logState.grams = e.target.value.replace(/[^0-9]/g, '').slice(0, 4);
  e.target.value = logState.grams;
  renderLogDraft();
});

document.getElementById('confirm-log-btn').addEventListener('click', async () => {
  const grams = parseInt(logState.grams, 10) || 0;
  if (!logState.pickedId || !grams) return;
  const isRecipe = logState.pickedKind === 'recipe';
  const today = todayISO();
  const date = logState.date ?? today;
  const loggedName = pickedRecord()?.name;
  await db.put('logEntries', {
    id: crypto.randomUUID(),
    date,
    foodId: isRecipe ? null : logState.pickedId,
    recipeId: isRecipe ? logState.pickedId : null,
    grams,
    meal: logState.meal ?? inferMeal(),
    loggedAt: new Date().toISOString(),
  });
  logState.query = ''; logState.pickedId = null; logState.pickedKind = null;
  logState.grams = ''; logState.meal = null;
  if (date === today) {
    logState.date = null;
    goTo('today');
  } else {
    // Backdating a missed day usually means several items at once — stay put with the same
    // date selected instead of sending them back to Today, which wouldn't show it anyway.
    toast(`Logged ${loggedName} to ${formatDateHeader(date)}`);
    renderLog();
  }
});

// ==================== FOODS ====================
let foodsTagFilter = 'All';
let foodsSources = new Set(); // empty = every source
let foodsQuery = '';
let foodsSort = 'name';
let foodsIngredientsExpanded = false;
let foodsListExpanded = false;

// The library is browsed far less than it's searched — a long wall of every food on open buries
// the search box and the paste/copy actions. Show a handful, with a button to see the rest.
const FOODS_COLLAPSED_COUNT = 6;

const FOOD_SORT_LABELS = {
  name: 'Name A–Z', frequency: 'Most logged', kcal: 'Most calories', protein: 'Most protein',
};

function foodMatchesFilters(f) {
  return (foodsTagFilter === 'All' || (f.tags ?? []).includes(foodsTagFilter))
    && (foodsSources.size === 0 || foodsSources.has(f.source));
}

// Non-default filter/sort state — drives both the toolbar badge count and the summary chips.
function activeFoodFilters() {
  const out = [];
  if (foodsSort !== 'name') out.push({ label: FOOD_SORT_LABELS[foodsSort], clear: () => { foodsSort = 'name'; } });
  for (const s of foodsSources) out.push({ label: s, clear: () => { foodsSources.delete(s); } });
  if (foodsTagFilter !== 'All') out.push({ label: foodsTagFilter, clear: () => { foodsTagFilter = 'All'; } });
  return out;
}

function allTagsFromFoods() {
  const set = new Set();
  for (const f of cache.foods) for (const t of f.tags ?? []) set.add(t);
  return ['All', ...Array.from(set).sort()];
}

// Foods logged directly (in the frequency window used elsewhere for favourites) never count as
// ingredient-only, however many recipes also use them — this only hides foods that are purely
// recipe components.
function directlyLoggedFoodIds() {
  const set = new Set();
  for (const key of cache.foodFrequency.keys()) {
    if (key.startsWith('food:')) set.add(key.slice(5));
  }
  return set;
}

function renderFoodRow(f) {
  const per = `${f.per100g.kcal} kcal · ${f.per100g.protein} g / 100 ${unitOf(f)}`;
  const row = el(`
    <div class="food-row">
      <div class="main">
        <div class="name">${escapeHtml(f.name)}</div>
        <div class="meta"><span class="per">${per}</span>${sourceBadge(f.source)}</div>
      </div>
      <button type="button" class="food-row-act" aria-label="Edit ${escapeHtml(f.name)}">✎</button>
      <button type="button" class="food-row-act is-delete" aria-label="Delete ${escapeHtml(f.name)}">×</button>
    </div>
  `);
  row.querySelector('[aria-label^="Edit"]').addEventListener('click', () => openFoodModal(f));
  row.querySelector('[aria-label^="Delete"]').addEventListener('click', async () => {
    if (!confirm(`Delete "${f.name}"? This can't be undone.`)) return;
    await db.remove('foods', f.id);
    await refreshCache();
    renderFoods();
  });
  return row;
}

function renderFoodRows(list, rows, emptyMsg) {
  list.innerHTML = '';
  if (rows.length === 0) list.appendChild(el(`<div class="empty-state">${escapeHtml(emptyMsg)}</div>`));
  for (const f of rows) list.appendChild(renderFoodRow(f));
}

// ==================== LIBRARY (Foods / Recipes / Bundles) ====================
let libraryMode = 'foods';

function renderLibrary() {
  document.querySelectorAll('#library-mode-chips .rd-chip').forEach(b => b.classList.toggle('active', b.dataset.mode === libraryMode));
  document.getElementById('library-foods-panel').hidden = libraryMode !== 'foods';
  document.getElementById('library-recipes-panel').hidden = libraryMode !== 'recipes';
  document.getElementById('library-bundles-panel').hidden = libraryMode !== 'bundles';
  document.getElementById('library-foods-claude').hidden = libraryMode !== 'foods';
  renderSyncStatus();

  if (libraryMode === 'foods') renderFoods();
  else if (libraryMode === 'recipes') renderRecipes();
  else renderBundles();
}

document.getElementById('library-mode-chips').addEventListener('click', e => {
  const btn = e.target.closest('button[data-mode]');
  if (!btn) return;
  libraryMode = btn.dataset.mode;
  renderLibrary();
});

document.querySelectorAll('.library-add-btn').forEach(btn => btn.addEventListener('click', () => {
  if (btn.dataset.add === 'foods') openFoodModal(null);
  else if (btn.dataset.add === 'recipes') openRecipeModal(null);
  else openBundleModal(null);
}));

function renderFoods() {
  const filters = activeFoodFilters();
  const filterBtn = document.getElementById('foods-filter-btn');
  document.getElementById('foods-filter-label').textContent = filters.length ? `Sort · ${filters.length}` : 'Sort';
  filterBtn.classList.toggle('active', filters.length > 0);

  const summary = document.getElementById('foods-active-filters');
  summary.innerHTML = '';
  summary.hidden = filters.length === 0;
  for (const f of filters) {
    const chip = el(`<button type="button" class="active-filter-chip">${escapeHtml(f.label)} <span aria-hidden="true">✕</span></button>`);
    chip.setAttribute('aria-label', `Clear filter: ${f.label}`);
    chip.addEventListener('click', () => { f.clear(); renderFoods(); });
    summary.appendChild(chip);
  }

  const q = foodsQuery.trim().toLowerCase();
  const filtered = cache.foods.filter(f => foodMatchesFilters(f) && (!q || f.name.toLowerCase().includes(q)));
  const sorted = sortFoods(filtered, foodsSort, id => frequencyOf('food', id));
  const { foods: mainRows, ingredients: ingredientRows } = splitFoodLibrary(sorted, cache.recipes, directlyLoggedFoodIds());

  // A search or an active filter means the user is after something specific — show every match
  // rather than hiding some behind the button. Otherwise cap the list until they ask for all.
  const narrowed = q !== '' || filters.length > 0;
  const canCollapse = !narrowed && mainRows.length > FOODS_COLLAPSED_COUNT;
  const visibleRows = (canCollapse && !foodsListExpanded) ? mainRows.slice(0, FOODS_COLLAPSED_COUNT) : mainRows;

  renderFoodRows(document.getElementById('foods-list'), visibleRows, 'No foods yet. Add one, or paste from Claude.');

  const listToggle = document.getElementById('foods-list-toggle');
  listToggle.hidden = !canCollapse;
  listToggle.innerHTML = foodsListExpanded
    ? 'Show fewer <span aria-hidden="true">▴</span>'
    : `Show all foods (${mainRows.length}) <span aria-hidden="true">▾</span>`;

  const toggleBtn = document.getElementById('foods-ingredients-toggle');
  const ingList = document.getElementById('foods-ingredients-list');
  toggleBtn.hidden = ingredientRows.length === 0;
  toggleBtn.innerHTML = `Recipe ingredients (${ingredientRows.length}) <span aria-hidden="true">${foodsIngredientsExpanded ? '▴' : '▾'}</span>`;
  ingList.hidden = !foodsIngredientsExpanded;
  if (foodsIngredientsExpanded) renderFoodRows(ingList, ingredientRows, 'No ingredient-only foods.');
}

document.getElementById('foods-search').addEventListener('input', e => { foodsQuery = e.target.value; renderFoods(); });
document.getElementById('foods-filter-btn').addEventListener('click', openFoodsFilterSheet);
document.getElementById('foods-ingredients-toggle').addEventListener('click', () => {
  foodsIngredientsExpanded = !foodsIngredientsExpanded;
  renderFoods();
});
document.getElementById('foods-list-toggle').addEventListener('click', () => {
  foodsListExpanded = !foodsListExpanded;
  renderFoods();
});

// Sort is single-select; source is multi-select. Nothing changes behind the sheet until the
// primary is tapped — "Show N foods" previews the result count live.
function openFoodsFilterSheet() {
  const SORTS = ['frequency', 'name', 'kcal', 'protein'];
  const SOURCES = ['label', 'reference', 'estimate'];
  const draft = { sort: foodsSort, sources: new Set(foodsSources), tag: foodsTagFilter };
  const tags = allTagsFromFoods();

  openModal(`
    <div class="sheet">
      <div class="sheet-title-row">
        <h2>Filter &amp; sort</h2>
        <button type="button" class="sheet-cancel" id="ff-reset">Reset</button>
      </div>

      <div class="sheet-field">
        <span class="eyebrow">Sort by</span>
        <div class="sheet-card" id="ff-sort">
          ${SORTS.map(s => `
            <button type="button" class="sheet-select-row${s === draft.sort ? ' active' : ''}" data-sort="${s}">
              <span>${FOOD_SORT_LABELS[s]}</span>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"${s === draft.sort ? '' : ' hidden'}><path d="M5 12.5l4.5 4.5L19 7.5"></path></svg>
            </button>`).join('')}
        </div>
      </div>

      <div class="sheet-field">
        <span class="eyebrow">Show only</span>
        <div class="sheet-chips" id="ff-src">
          ${SOURCES.map(s => `<button type="button" class="sheet-chip${s === 'estimate' ? ' est' : ''}${draft.sources.has(s) ? ' active' : ''}" data-src="${s}">${badgeIcon(s)} ${s}</button>`).join('')}
        </div>
      </div>

      ${tags.length > 1 ? `
        <div class="sheet-field">
          <span class="eyebrow">Tag</span>
          <div class="sheet-chips" id="ff-tag">
            ${tags.map(t => `<button type="button" class="sheet-chip${t === draft.tag ? ' active' : ''}" data-tag="${escapeHtml(t)}">${escapeHtml(t)}</button>`).join('')}
          </div>
        </div>` : ''}

      <button type="button" class="sheet-primary" id="ff-apply"></button>
    </div>
  `);

  const previewCount = () => cache.foods.filter(f =>
    (draft.tag === 'All' || (f.tags ?? []).includes(draft.tag))
    && (draft.sources.size === 0 || draft.sources.has(f.source))).length;
  const refreshApply = () => { document.getElementById('ff-apply').textContent = `Show ${previewCount()} foods`; };
  refreshApply();

  document.getElementById('ff-sort').addEventListener('click', e => {
    const b = e.target.closest('[data-sort]'); if (!b) return;
    draft.sort = b.dataset.sort;
    document.querySelectorAll('#ff-sort .sheet-select-row').forEach(r => {
      const on = r === b;
      r.classList.toggle('active', on);
      r.querySelector('svg').hidden = !on;
    });
  });
  document.getElementById('ff-src').addEventListener('click', e => {
    const b = e.target.closest('[data-src]'); if (!b) return;
    const s = b.dataset.src;
    draft.sources.has(s) ? draft.sources.delete(s) : draft.sources.add(s);
    b.classList.toggle('active');
    refreshApply();
  });
  const tagRow = document.getElementById('ff-tag');
  if (tagRow) tagRow.addEventListener('click', e => {
    const b = e.target.closest('[data-tag]'); if (!b) return;
    draft.tag = b.dataset.tag;
    tagRow.querySelectorAll('.sheet-chip').forEach(c => c.classList.toggle('active', c === b));
    refreshApply();
  });

  document.getElementById('ff-reset').addEventListener('click', () => {
    draft.sort = 'name'; draft.sources.clear(); draft.tag = 'All';
    document.querySelectorAll('#ff-sort .sheet-select-row').forEach(r => {
      const on = r.dataset.sort === 'name';
      r.classList.toggle('active', on);
      r.querySelector('svg').hidden = !on;
    });
    document.querySelectorAll('#ff-src .sheet-chip, #ff-tag .sheet-chip').forEach(c => c.classList.remove('active'));
    if (tagRow) tagRow.querySelector('[data-tag="All"]')?.classList.add('active');
    refreshApply();
  });

  document.getElementById('ff-apply').addEventListener('click', () => {
    foodsSort = draft.sort;
    foodsSources = draft.sources;
    foodsTagFilter = draft.tag;
    closeModal();
    renderFoods();
  });
}

// One sheet for add / edit / quick-add (from the Log tab's "add as new food" row and the recipe
// builder's "new food"). `onSaved` diverts the result instead of re-rendering the Foods list.
function openFoodModal(food, { prefillName = '', onSaved = null } = {}) {
  const isEdit = !!food;
  const st = {
    unit: isEdit ? unitOf(food) : 'g',
    source: isEdit ? food.source : 'label',
  };
  const v = x => (x == null ? '' : x);

  openModal(`
    <div class="sheet">
      <div class="sheet-title-row">
        <h2>${isEdit ? 'Edit food' : 'Add a food'}</h2>
        <button type="button" class="sheet-cancel" id="f-cancel">Cancel</button>
      </div>

      <div class="sheet-field">
        <span class="eyebrow">Name</span>
        <input class="sheet-well" id="f-name" autocomplete="off" value="${isEdit ? escapeHtml(food.name) : escapeHtml(prefillName)}">
      </div>

      <div class="sheet-field">
        <span class="eyebrow">Per 100</span>
        <div class="sheet-well-pair">
          <label class="sheet-well-unit"><input id="f-kcal" type="text" inputmode="numeric" aria-label="Calories per 100" value="${isEdit ? v(food.per100g.kcal) : ''}"><span class="u">kcal</span></label>
          <label class="sheet-well-unit"><input id="f-protein" type="text" inputmode="decimal" aria-label="Protein per 100" value="${isEdit ? v(food.per100g.protein) : ''}"><span class="u">g protein</span></label>
        </div>
      </div>

      <div class="sheet-field">
        <span class="eyebrow">Default portion</span>
        <label class="sheet-well-unit" style="max-width:150px;"><input id="f-portion" type="text" inputmode="numeric" aria-label="Default portion" value="${isEdit ? v(food.defaultPortionG) : '100'}"><span class="u" id="f-portion-u">g</span></label>
      </div>

      <div class="sheet-chips" id="f-unit-chips">
        <button type="button" class="sheet-chip${st.unit === 'g' ? ' active' : ''}" data-unit="g">grams</button>
        <button type="button" class="sheet-chip${st.unit === 'ml' ? ' active' : ''}" data-unit="ml">millilitres</button>
      </div>

      <div class="sheet-field">
        <span class="eyebrow">Where the numbers came from</span>
        <div class="sheet-chips" id="f-source-chips">
          <button type="button" class="sheet-chip${st.source === 'label' ? ' active' : ''}" data-source="label">${badgeIcon('label')} label</button>
          <button type="button" class="sheet-chip${st.source === 'reference' ? ' active' : ''}" data-source="reference">${badgeIcon('reference')} reference</button>
          <button type="button" class="sheet-chip est${st.source === 'estimate' ? ' active' : ''}" data-source="estimate">${badgeIcon('estimate')} estimate</button>
        </div>
        <div class="sheet-help">Read off the packet. Estimates are marked everywhere they appear.</div>
      </div>

      <button type="button" class="sheet-more" id="f-more-toggle">More — carbs, fat, fibre, tags, cooking</button>
      <div class="sheet-more-body" id="f-more" hidden>
        <div class="sheet-well-pair">
          <label class="sheet-well-unit"><input id="f-carbs" type="text" inputmode="decimal" aria-label="Carbs per 100" value="${isEdit ? v(food.per100g.carbs) : ''}"><span class="u">g carbs</span></label>
          <label class="sheet-well-unit"><input id="f-fat" type="text" inputmode="decimal" aria-label="Fat per 100" value="${isEdit ? v(food.per100g.fat) : ''}"><span class="u">g fat</span></label>
        </div>
        <label class="sheet-well-unit"><input id="f-fibre" type="text" inputmode="decimal" aria-label="Fibre per 100" value="${isEdit ? v(food.per100g.fibre) : ''}"><span class="u">g fibre</span></label>
        <input class="sheet-well" id="f-tags" placeholder="Tags, comma separated" value="${isEdit ? escapeHtml((food.tags ?? []).join(', ')) : ''}">
        <select class="sheet-well" id="f-cook" style="font-weight:600;">
          <option value="">No cooking estimate</option>
          ${COOK_CATEGORIES.map(c => `<option value="${c.id}" ${isEdit && food.cookCategory === c.id ? 'selected' : ''}>${escapeHtml(c.label)}</option>`).join('')}
        </select>
      </div>

      <div class="form-msg error" id="f-error" hidden></div>
      <div class="form-msg" id="f-warn" hidden style="color:var(--accent);"></div>
      <button type="button" class="sheet-primary" id="f-save">${isEdit ? 'Save changes' : 'Save food'}</button>
    </div>
  `);

  document.getElementById('f-cancel').addEventListener('click', closeModal);
  document.getElementById('f-more-toggle').addEventListener('click', () => {
    const m = document.getElementById('f-more');
    m.hidden = !m.hidden;
    document.getElementById('f-more-toggle').textContent = m.hidden
      ? 'More — carbs, fat, fibre, tags, cooking'
      : 'Fewer fields';
  });

  document.getElementById('f-unit-chips').addEventListener('click', e => {
    const b = e.target.closest('[data-unit]'); if (!b) return;
    st.unit = b.dataset.unit;
    document.querySelectorAll('#f-unit-chips .sheet-chip').forEach(c => c.classList.toggle('active', c === b));
    document.getElementById('f-portion-u').textContent = st.unit;
  });
  document.getElementById('f-source-chips').addEventListener('click', e => {
    const b = e.target.closest('[data-source]'); if (!b) return;
    st.source = b.dataset.source;
    document.querySelectorAll('#f-source-chips .sheet-chip').forEach(c => c.classList.toggle('active', c === b));
  });

  if (!isEdit && !prefillName) document.getElementById('f-name').focus();

  let dupAck = false;
  document.getElementById('f-save').addEventListener('click', async () => {
    const num = x => { const s = String(x).trim().replace(',', '.'); return s === '' ? null : Number(s); };
    const name = document.getElementById('f-name').value.trim();

    const similar = findSimilarFoods(name, cache.foods, { excludeId: isEdit ? food.id : null });
    if (similar.length && !dupAck) {
      const w = document.getElementById('f-warn');
      w.innerHTML = `You already have <strong>${escapeHtml(similar[0].name)}</strong>. Tap Save again to add anyway.`;
      w.hidden = false;
      dupAck = true;
      return;
    }

    const obj = {
      id: isEdit ? food.id : slugify(name),
      name,
      per100g: {
        kcal: num(document.getElementById('f-kcal').value),
        protein: num(document.getElementById('f-protein').value),
        carbs: num(document.getElementById('f-carbs').value),
        fat: num(document.getElementById('f-fat').value),
        fibre: num(document.getElementById('f-fibre').value),
      },
      defaultPortionG: num(document.getElementById('f-portion').value) ?? 100,
      source: st.source,
      unit: st.unit,
      tags: document.getElementById('f-tags').value.split(',').map(t => t.trim()).filter(Boolean),
      cookCategory: document.getElementById('f-cook').value || null,
    };
    const errors = validateFood(obj);
    const errEl = document.getElementById('f-error');
    if (errors.length) { errEl.textContent = errors.join(' '); errEl.hidden = false; return; }

    await db.put('foods', obj);
    await refreshCache();
    closeModal();
    if (onSaved) onSaved(obj);
    else renderFoods();
  });
}

function slugify(name) {
  const base = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'food';
  return `${base}-${Date.now().toString(36)}`;
}

document.getElementById('copy-library-btn').addEventListener('click', async () => {
  const text = await exportLibraryForClaude();
  const ok = await copyText(text);
  toast(ok ? 'Copied your food list' : 'Could not copy — check clipboard permission');
});

document.getElementById('paste-import-btn').addEventListener('click', openPasteImportSheet);

// Paste and review in one sheet: the review list rebuilds as the box changes. A collision is
// never fatal — each clashing item gets a Replace toggle; everything else is a check.
function openPasteImportSheet() {
  let items = [];
  const CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"></path></svg>';
  const WARN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="8.5"></circle><path d="M12 7.5v5.5M12 16v.5"></path></svg>';

  openModal(`
    <div class="sheet">
      <div class="sheet-title-row">
        <h2>Paste from Claude</h2>
        <button type="button" class="sheet-cancel" id="pi-cancel">Cancel</button>
      </div>
      <textarea class="rd-field" id="pi-text" style="min-height:96px;" placeholder="Paste the JSON block Claude gave you"></textarea>
      <button type="button" class="sheet-more" id="pi-clip">Paste from clipboard</button>
      <div id="pi-review"></div>
      <button type="button" class="sheet-primary" id="pi-import" disabled>Import</button>
    </div>
  `);

  const reviewEl = document.getElementById('pi-review');
  const importBtn = document.getElementById('pi-import');

  const perText = it => it.kind === 'food'
    ? `${it.obj.per100g.kcal} kcal · ${it.obj.per100g.protein} g / 100 ${unitOf(it.obj)}`
    : `${it.obj.ingredients.length} ingredient${it.obj.ingredients.length === 1 ? '' : 's'} · ${it.obj.portions} portions`;

  const refreshCount = () => {
    const n = items.filter(it => it.action !== 'skip').length;
    importBtn.textContent = n ? `Import ${n} item${n === 1 ? '' : 's'}` : 'Import';
    importBtn.disabled = n === 0;
  };

  const renderReview = () => {
    if (!items.length) { reviewEl.innerHTML = ''; refreshCount(); return; }
    reviewEl.innerHTML = `
      <div class="sheet-field">
        <div class="sheet-title-row">
          <span class="eyebrow">Ready to import</span>
          <button type="button" class="sheet-cancel" id="pi-deselect">Deselect all</button>
        </div>
        <div class="sheet-card">
          ${items.map((it, i) => it.conflict ? `
            <div class="sheet-review-row conflict">
              <span style="color:var(--accent); width:20px; height:20px; flex:none;">${WARN}</span>
              <span class="rv-main"><span class="rv-name">${escapeHtml(it.obj.name)}</span><span class="rv-clash">Already in your library</span></span>
              <button type="button" class="rv-act" data-toggle="${i}">${it.action === 'replace' ? 'Replacing' : 'Replace'}</button>
            </div>` : `
            <div class="sheet-review-row">
              <span data-toggle="${i}" style="width:20px; height:20px; flex:none; color:${it.action === 'skip' ? 'var(--text-tertiary)' : 'var(--accent)'}; cursor:pointer;">${it.action === 'skip' ? '' : CHECK}</span>
              <span class="rv-main"><span class="rv-name">${escapeHtml(it.obj.name)}</span><span class="rv-per">${perText(it)}</span></span>
              ${it.kind === 'recipe' ? '<span class="badge badge-recipe">' + badgeIcon('recipe') + ' recipe</span>' : sourceBadge(it.obj.source)}
            </div>`).join('')}
        </div>
      </div>`;
    reviewEl.querySelectorAll('[data-toggle]').forEach(elm => elm.addEventListener('click', () => {
      const it = items[Number(elm.dataset.toggle)];
      it.action = it.conflict
        ? (it.action === 'replace' ? 'skip' : 'replace')
        : (it.action === 'skip' ? 'add' : 'skip');
      renderReview();
    }));
    const de = document.getElementById('pi-deselect');
    if (de) de.addEventListener('click', () => { items.forEach(it => { it.action = 'skip'; }); renderReview(); });
    refreshCount();
  };

  let timer = null;
  const parse = async () => {
    const text = document.getElementById('pi-text').value.trim();
    if (!text) { items = []; renderReview(); return; }
    try {
      const plan = await prepareImport(text);
      items = plan.items; // each: { kind, obj, conflict, action }
    } catch (err) {
      items = [];
      reviewEl.innerHTML = `<div class="sheet-help" style="color:var(--accent);">${escapeHtml(err instanceof ImportError ? err.message : 'Could not read that paste.')}</div>`;
      refreshCount();
      return;
    }
    renderReview();
  };
  document.getElementById('pi-text').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(parse, 250); });

  document.getElementById('pi-clip').addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text && text.trim()) { document.getElementById('pi-text').value = text; parse(); }
    } catch { /* Safari can refuse without a fresh gesture — the box still works */ }
  });

  document.getElementById('pi-cancel').addEventListener('click', closeModal);
  importBtn.addEventListener('click', async () => {
    const result = await commitImport(items);
    await refreshCache();
    closeModal();
    const parts = [];
    if (result.added) parts.push(`${result.added} added`);
    if (result.replaced) parts.push(`${result.replaced} replaced`);
    if (result.skipped) parts.push(`${result.skipped} skipped`);
    toast(parts.join(', ') || 'Nothing imported');
    renderFoods();
    renderRecipes();
  });
}

// ==================== RECIPES ====================
function renderRecipes() {
  const list = document.getElementById('recipes-list');
  list.innerHTML = '';
  if (cache.recipes.length === 0) {
    list.appendChild(el(`<div class="empty-state">No recipes yet. Build one from foods you already have.</div>`));
    return;
  }
  const fMap = foodsById();
  for (const r of cache.recipes) {
    const draft = isDraftRecipe(r);
    let perGram = null;
    let broken = false;
    if (!draft) {
      try { perGram = recipePerGram(r, fMap); } catch { broken = true; }
    }

    if (broken) {
      const missing = (r.ingredients || []).map(i => i.foodId).filter(id => !fMap.has(id));
      const card = el(`
        <div class="lib-card is-broken">
          <div class="lib-card-fix">
            <div>
              <div class="lib-card-title">${escapeHtml(r.name)}</div>
              <div class="lib-card-warn">⚠ ingredient ${missing.length ? `"${escapeHtml(missing[0])}"` : ''} is missing</div>
            </div>
            <button type="button" class="rd-link" data-edit-recipe="${r.id}">Fix</button>
          </div>
        </div>
      `);
      list.appendChild(card);
      continue;
    }

    const portionG = draft ? null : onePortionGrams(r);
    const portionKcal = perGram ? Math.round(perGram.kcal * (r.cookedWeightG / r.portions)) : null;
    const portionProt = perGram ? Math.round(perGram.protein * (r.cookedWeightG / r.portions)) : null;

    const card = el(`
      <div class="lib-card">
        <div class="lib-card-body">
          <div class="lib-card-top">
            <div>
              <div class="lib-card-title">${escapeHtml(r.name)}</div>
              <div class="lib-card-sub">${draft
                ? `${(r.ingredients || []).length} ingredients · cooked weight not entered`
                : `cooked ${fmt(r.cookedWeightG)} g · ${r.portions} portions of ${portionG} g`}</div>
            </div>
            <span class="badge ${draft ? 'badge-draft' : 'badge-recipe'}">${draft ? badgeIcon('draft') + ' draft' : badgeIcon('recipe') + ' recipe'}</span>
          </div>
          ${draft
            ? '<div class="lib-card-note">Weigh the batch to unlock per-portion macros. Logging is locked until then.</div>'
            : `<div class="lib-card-figs">
                 <div><div>${fmt(portionKcal)}</div><div>kcal / portion</div></div>
                 <div><div>${portionProt} g</div><div>protein</div></div>
               </div>`}
        </div>
        <div class="lib-card-actions">
          <button type="button" class="rd-btn-primary" data-log-recipe="${r.id}" ${draft ? 'disabled' : ''}>Log a portion</button>
          ${draft
            ? `<button type="button" class="rd-btn-secondary" data-edit-recipe="${r.id}">Add weight</button>`
            : `<button type="button" class="rd-btn-secondary" data-cook-again="${r.id}">Cook again</button>
               <button type="button" class="rd-icon-btn" data-edit-recipe="${r.id}" aria-label="Edit ${escapeHtml(r.name)}">✎</button>
               <button type="button" class="rd-icon-btn is-danger" data-delete-recipe="${r.id}" aria-label="Delete ${escapeHtml(r.name)}">×</button>`}
        </div>
      </div>
    `);
    list.appendChild(card);
  }
  list.querySelectorAll('[data-log-recipe]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const recipe = recipesById().get(btn.dataset.logRecipe);
      if (!recipe || isDraftRecipe(recipe)) return;
      const grams = Math.round(recipe.cookedWeightG / recipe.portions);
      await db.put('logEntries', {
        id: crypto.randomUUID(), date: todayISO(), foodId: null, recipeId: recipe.id, grams,
        meal: inferMeal(), loggedAt: new Date().toISOString(),
      });
      goTo('today');
    });
  });
  list.querySelectorAll('[data-cook-again]').forEach(btn => {
    btn.addEventListener('click', () => {
      const recipe = recipesById().get(btn.dataset.cookAgain);
      if (recipe) openRecipeModal(null, { copyFrom: recipe });
    });
  });
  list.querySelectorAll('[data-edit-recipe]').forEach(btn => {
    btn.addEventListener('click', () => {
      const r = recipesById().get(btn.dataset.editRecipe);
      if (r) openRecipeModal(r);
    });
  });
  list.querySelectorAll('[data-delete-recipe]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const r = recipesById().get(btn.dataset.deleteRecipe);
      if (!r) return;
      if (!confirm(`Delete "${r.name}"? This can't be undone.`)) return;
      await db.remove('recipes', r.id);
      await refreshCache();
      renderRecipes();
    });
  });
}

async function openRecipeModal(recipe, { copyFrom = null, restore = null } = {}) {
  const isEdit = !!recipe;
  const template = recipe ?? copyFrom;
  const ingredients = restore
    ? restore.rows.map(i => ({ ...i }))
    : (template ? template.ingredients.map(i => ({ ...i })) : [{ foodId: '', grams: '' }]);

  // Editing a recipe recomputes every portion ever logged from it, so a Sunday batch cooked
  // with different weights must not be recorded by editing last week's recipe.
  let loggedCount = 0;
  if (isEdit) {
    const allEntries = await db.getAll('logEntries');
    loggedCount = allEntries.filter(e => e.recipeId === recipe.id).length;
  }

  function ingredientRowHtml(ing, i) {
    const options = cache.foods.map(f => `<option value="${f.id}" ${ing.foodId === f.id ? 'selected' : ''}>${escapeHtml(f.name)}</option>`).join('');
    const chosen = ing.foodId ? cache.foods.find(f => f.id === ing.foodId) : null;
    const unit = chosen && unitOf(chosen) === 'ml' ? 'ml' : 'g';
    return `
      <div class="sheet-ing-row" data-ing-row="${i}">
        <select class="sheet-well" data-ing-food style="flex:1; min-width:0; height:44px; font-size:14px; font-weight:600;"><option value="">Select food…</option>${options}</select>
        <label class="sheet-well" style="width:92px; height:44px; padding:0 10px; display:flex; align-items:center; gap:5px;">
          <input data-ing-grams type="text" inputmode="numeric" aria-label="Raw amount of ingredient ${i + 1}" value="${ing.grams || ''}" style="flex:1; min-width:0; border:none; background:none; outline:none; text-align:right; font-family:var(--font-figure); font-variant-numeric:tabular-nums; font-size:14px; font-weight:700; color:var(--text-primary);">
          <span style="font-size:12px; color:var(--text-secondary);">${unit}</span>
        </label>
        <button type="button" class="x" data-remove-ing aria-label="Remove ingredient">×</button>
      </div>
    `;
  }

  const titleText = isEdit ? 'Edit recipe' : (copyFrom ? 'Cook this again' : 'Build a recipe');
  const defaultName = restore
    ? restore.name
    : (copyFrom
      ? `${copyFrom.name} — ${formatDateHeader(todayISO()).replace(/^\w+\s/, '')}`
      : (isEdit ? recipe.name : ''));

  const editWarning = isEdit && loggedCount > 0
    ? `<div class="sheet-notice">${loggedCount} portion${loggedCount === 1 ? '' : 's'} already logged from this recipe. Changing the weights also changes what those past meals say you ate — for a new batch, use "Cook again" instead.</div>`
    : '';

  const copyNote = copyFrom
    ? `<div class="sheet-help">Copied from "${escapeHtml(copyFrom.name)}". Adjust the weights for this batch — past meals stay untouched.</div>`
    : '';

  // A saved, actually-weighed cooked weight is never silently overwritten by the estimate —
  // only a draft, or a weight that was itself only ever an estimate, keeps auto-updating as
  // ingredients change. This is what lets a recipe be built (and logged from) without ever
  // having to weigh the batch first — see "Shrinkage-factor estimate" in COOK_CATEGORIES.
  let cookedManuallyEdited = restore
    ? !!restore.cookedManuallyEdited
    : (isEdit && recipe.cookedWeightG != null && recipe.cookedWeightEstimated !== true);
  let initialCooked = restore ? restore.cooked : (isEdit && recipe.cookedWeightG != null ? recipe.cookedWeightG : '');
  if (!cookedManuallyEdited && initialCooked === '') {
    const est = estimateCookedWeightG(
      ingredients.filter(r => r.foodId && r.grams).map(r => ({ foodId: r.foodId, grams: Number(r.grams) })),
      foodsById(),
    );
    if (est != null) initialCooked = est;
  }

  const initialPortions = restore ? restore.portions : (template ? template.portions : 5);

  openModal(`
    <div class="sheet sheet--dense">
      <div class="sheet-title-row">
        <h2>${titleText}</h2>
        <button type="button" class="sheet-cancel" id="r-cancel">Cancel</button>
      </div>
      ${editWarning}${copyNote}

      <input class="sheet-well" id="r-name" placeholder="Recipe name" value="${escapeHtml(defaultName)}">

      <div class="sheet-field">
        <span class="eyebrow">Ingredients — raw weights</span>
        <div class="sheet-card">
          <div id="r-ingredients">${ingredients.map(ingredientRowHtml).join('')}</div>
          <button type="button" class="sheet-ing-add" id="r-add-ing"><span class="plus" aria-hidden="true">+</span><span>Add an ingredient</span></button>
          <button type="button" class="sheet-ing-add" id="r-new-food"><span class="plus" aria-hidden="true">+</span><span>Create a new food first</span></button>
        </div>
      </div>

      <div style="display:flex; gap:10px;">
        <div class="sheet-field" style="flex:1;">
          <span class="eyebrow">Cooked weight</span>
          <label class="sheet-well-unit"><input id="r-cooked" type="text" inputmode="numeric" aria-label="Cooked batch weight" placeholder="—" value="${escapeHtml(String(initialCooked))}"><span class="u">g</span></label>
        </div>
        <div class="sheet-field" style="width:140px;">
          <span class="eyebrow">Portions</span>
          <div class="sheet-stepper">
            <button type="button" id="r-portions-minus" aria-label="Fewer portions">−</button>
            <span class="val" id="r-portions-val">${Number(initialPortions) || 5}</span>
            <button type="button" id="r-portions-plus" aria-label="More portions">+</button>
          </div>
        </div>
      </div>

      <div id="r-state"></div>

      <div class="form-msg error" id="r-error" hidden></div>
      <button type="button" class="sheet-primary" id="r-save">Save recipe</button>
    </div>
  `);
  let portions = Number(initialPortions) || 5;

  let rows = ingredients.slice();

  // While cooked weight is empty this saves as a draft (no per-portion macros, can't be logged);
  // once a weight is in, the notice is replaced by the live per-portion figures.
  function updateState() {
    const cookedRaw = document.getElementById('r-cooked').value.trim();
    const stateEl = document.getElementById('r-state');
    const saveBtn = document.getElementById('r-save');
    if (cookedRaw === '') {
      saveBtn.textContent = 'Save as draft';
      stateEl.innerHTML = `<div class="sheet-notice">${badgeIcon('draft')}<span>Saves as a draft. Weigh the cooked batch to unlock per-portion macros and logging.</span></div>`;
      return;
    }
    saveBtn.textContent = 'Save recipe';
    const provisional = {
      ingredients: rows.filter(r => r.foodId && r.grams).map(r => ({ foodId: r.foodId, grams: Number(r.grams) })),
      cookedWeightG: Number(cookedRaw),
      portions: portions,
    };
    let strip = '';
    try {
      const pg = recipePerGram(provisional, foodsById());
      const g = provisional.cookedWeightG / provisional.portions;
      strip = `<div class="sheet-fig-strip">
        <div><div>${Math.round(pg.kcal * g)}</div><div>kcal / portion</div></div>
        <div><div>${Math.round(pg.protein * g)} g</div><div>protein</div></div>
      </div>`;
    } catch { strip = '<div class="sheet-help">Add ingredient weights to see per-portion macros.</div>'; }
    stateEl.innerHTML = strip;
  }

  function maybeAutoEstimateCooked() {
    if (!cookedManuallyEdited) {
      const estimate = estimateCookedWeightG(
        rows.filter(r => r.foodId && r.grams).map(r => ({ foodId: r.foodId, grams: Number(r.grams) })),
        foodsById(),
      );
      if (estimate != null) document.getElementById('r-cooked').value = estimate;
    }
    updateState();
  }

  document.getElementById('r-cooked').addEventListener('input', () => {
    cookedManuallyEdited = true;
    updateState();
  });

  const portionsVal = document.getElementById('r-portions-val');
  const stepPortions = d => { portions = Math.max(1, portions + d); portionsVal.textContent = portions; updateState(); };
  document.getElementById('r-portions-minus').addEventListener('click', () => stepPortions(-1));
  document.getElementById('r-portions-plus').addEventListener('click', () => stepPortions(1));

  updateState();

  function rerenderIngredients() {
    document.getElementById('r-ingredients').innerHTML = rows.map(ingredientRowHtml).join('');
    wireIngredientRows();
    maybeAutoEstimateCooked();
  }

  function wireIngredientRows() {
    document.querySelectorAll('[data-ing-food]').forEach((sel, i) => sel.addEventListener('change', () => {
      rows[i].foodId = sel.value;
      // Re-render so the amount placeholder switches to ml when a drink is chosen.
      rerenderIngredients();
    }));
    document.querySelectorAll('[data-ing-grams]').forEach((inp, i) => inp.addEventListener('input', () => {
      rows[i].grams = inp.value;
      maybeAutoEstimateCooked();
    }));
    document.querySelectorAll('[data-remove-ing]').forEach((btn, i) => btn.addEventListener('click', () => {
      rows.splice(i, 1);
      if (rows.length === 0) rows.push({ foodId: '', grams: '' });
      rerenderIngredients();
    }));
  }
  wireIngredientRows();

  document.getElementById('r-add-ing').addEventListener('click', () => {
    rows.push({ foodId: '', grams: '' });
    rerenderIngredients();
  });

  // Adding a missing ingredient shouldn't cost you the recipe you're halfway through typing:
  // snapshot the form, create the food, then rebuild this sheet exactly as it was.
  document.getElementById('r-new-food').addEventListener('click', () => {
    const snapshot = {
      name: document.getElementById('r-name').value,
      cooked: document.getElementById('r-cooked').value,
      cookedManuallyEdited,
      portions: portions,
      rows: rows.map(r => ({ ...r })),
    };
    openFoodModal(null, {
      onSaved: async food => {
        const emptyRow = snapshot.rows.find(r => !r.foodId);
        if (emptyRow) emptyRow.foodId = food.id;
        else snapshot.rows.push({ foodId: food.id, grams: '' });
        await openRecipeModal(recipe, { copyFrom, restore: snapshot });
        toast(`Added ${food.name}`);
      },
    });
  });

  document.getElementById('r-cancel').addEventListener('click', closeModal);
  document.getElementById('r-save').addEventListener('click', async () => {
    const cookedRaw = document.getElementById('r-cooked').value.trim();
    const obj = {
      id: isEdit ? recipe.id : slugify(document.getElementById('r-name').value),
      name: document.getElementById('r-name').value.trim(),
      ingredients: rows.filter(r => r.foodId).map(r => ({ foodId: r.foodId, grams: Number(r.grams) })),
      cookedWeightG: cookedRaw === '' ? null : Number(cookedRaw),
      cookedWeightEstimated: cookedRaw !== '' && !cookedManuallyEdited,
      portions: portions,
    };
    const errors = validateRecipe(obj, { allowDraft: true });
    const errEl = document.getElementById('r-error');
    if (errors.length) { errEl.textContent = errors.join(' '); errEl.hidden = false; return; }
    await db.put('recipes', obj);
    await refreshCache();
    closeModal();
    renderRecipes();
    if (isDraftRecipe(obj)) toast('Saved as draft — add the cooked weight when you weigh it');
  });
}

// ==================== BUNDLES ====================
// A bundle groups foods/recipes you always log together (a usual breakfast) so the whole group
// can be added in one tap. See bundleToLogEntries/logBundle — logging one just writes several
// ordinary logEntries, so nothing downstream needs to know bundles exist.
function renderBundles() {
  const list = document.getElementById('bundles-list');
  list.innerHTML = '';
  if (cache.bundles.length === 0) {
    list.appendChild(el(`<div class="empty-state">No bundles yet. Group foods you always have together — like a usual breakfast — to log them all in one tap.</div>`));
    return;
  }
  const fMap = foodsById(), rMap = recipesById();
  const mealLabel = MEAL_LABELS[inferMeal()];
  for (const b of cache.bundles) {
    const macros = bundleMacros(b, fMap, rMap);
    const itemRows = b.items.map(item => {
      const m = bundleItemMacros(item, fMap, rMap);
      const name = m ? `${escapeHtml(m.name)} · ${item.grams} ${m.unit}` : 'missing item';
      return `<div><div>${name}</div><div class="k">${m ? m.kcal : '—'}</div></div>`;
    }).join('');
    const card = el(`
      <div class="lib-card">
        <div class="lib-card-body">
          <div class="lib-card-top" style="align-items:baseline;">
            <div class="lib-card-title">${escapeHtml(b.name)}</div>
            <div class="lib-card-sub" style="margin:0;">${b.items.length} item${b.items.length === 1 ? '' : 's'}</div>
          </div>
          ${b.items.length <= 4 ? `<div class="lib-card-items">${itemRows}</div>` : ''}
          <div class="lib-card-figs">
            <div><div>${fmt(macros.kcal)}</div><div>kcal total</div></div>
            <div><div>${macros.protein} g</div><div>protein</div></div>
          </div>
        </div>
        <div class="lib-card-actions">
          <button type="button" class="rd-btn-primary" data-log-bundle="${b.id}">Log all to ${escapeHtml(mealLabel)}</button>
          <button type="button" class="rd-icon-btn" data-edit-bundle="${b.id}" aria-label="Edit ${escapeHtml(b.name)}">✎</button>
          <button type="button" class="rd-icon-btn is-danger" data-delete-bundle="${b.id}" aria-label="Delete ${escapeHtml(b.name)}">×</button>
        </div>
      </div>
    `);
    list.appendChild(card);
  }
  list.querySelectorAll('[data-log-bundle]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const b = bundlesById().get(btn.dataset.logBundle);
      if (!b) return;
      await logBundle(b, inferMeal());
      toast(`Logged ${b.name}`);
      goTo('today');
    });
  });
  list.querySelectorAll('[data-edit-bundle]').forEach(btn => {
    btn.addEventListener('click', () => {
      const b = bundlesById().get(btn.dataset.editBundle);
      if (b) openBundleModal(b);
    });
  });
  list.querySelectorAll('[data-delete-bundle]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const b = bundlesById().get(btn.dataset.deleteBundle);
      if (!b) return;
      if (!confirm(`Delete "${b.name}"? This can't be undone.`)) return;
      await db.remove('bundles', b.id);
      await refreshCache();
      renderBundles();
    });
  });
}

// A full-screen-ish search sheet for picking one food or recipe — the library can run into
// the hundreds, so a plain <select> doesn't scale, and this reuses the same search-result
// list the Today quick-log sheet already uses. Calls back with { kind, id } on a pick, or
// null on Cancel.
function openBundleItemPicker(onPicked) {
  let query = '';

  function renderResults() {
    const q = query.trim().toLowerCase();
    const items = loggableItems()
      .filter(c => !q || c.record.name.toLowerCase().includes(q))
      .sort((a, b) => a.record.name.localeCompare(b.record.name))
      .slice(0, 50);
    const container = document.getElementById('bip-results');
    container.innerHTML = '';
    if (items.length === 0) {
      container.appendChild(el(`<div class="meal-empty">No match.</div>`));
      return;
    }
    for (const { kind, record } of items) {
      const meta = kind === 'recipe' ? 'recipe' : `${record.per100g.kcal} kcal /100${unitOf(record)}`;
      const btn = el(`
        <button type="button" class="search-result-btn">
          <span class="name">${escapeHtml(record.name)}</span>
          <span class="per100">${escapeHtml(meta)}</span>
        </button>
      `);
      // Picking bypasses closeModal (the next sheet opens straight over this one), so the
      // pending "resume on close" below must be cleared here or it would misfire later.
      btn.addEventListener('click', () => { pendingModalCancel = null; onPicked({ kind, id: record.id }); });
      container.appendChild(btn);
    }
  }

  openModal(`
    <h2>Choose a food or recipe</h2>
    <input class="text-input" id="bip-search" type="text" placeholder="Search foods and recipes" autocomplete="off" style="margin-bottom:6px;">
    <div class="search-results" id="bip-results"></div>
    <div class="modal-actions">
      <button type="button" class="secondary-btn" id="bip-cancel">Cancel</button>
    </div>
  `);
  // Cancelling this sheet by any route (the button, a backdrop tap, or dragging it shut)
  // should resume the bundle builder rather than exit to the app underneath.
  pendingModalCancel = () => onPicked(null);
  document.getElementById('bip-search').addEventListener('input', e => { query = e.target.value; renderResults(); });
  document.getElementById('bip-cancel').addEventListener('click', closeModal);
  renderResults();
}

function openBundleModal(bundle, { restore = null } = {}) {
  const isEdit = !!bundle;
  let rows = restore ? restore.rows.map(r => ({ ...r }))
    : (isEdit ? bundle.items.map(i => ({ ...i })) : [{ kind: '', id: '', grams: '' }]);
  const initialName = restore ? restore.name : (isEdit ? bundle.name : '');

  function itemLabel(row) {
    const record = row.kind === 'food' ? foodsById().get(row.id) : (row.kind === 'recipe' ? recipesById().get(row.id) : null);
    return record ? record.name : 'Select food or recipe…';
  }

  function rowHtml(row, i) {
    const record = row.kind === 'food' ? foodsById().get(row.id) : (row.kind === 'recipe' ? recipesById().get(row.id) : null);
    const unit = record ? (row.kind === 'recipe' ? 'g' : unitOf(record)) : 'g';
    return `
      <div style="display:flex; gap:8px; margin-bottom:8px;" data-item-row="${i}">
        <button type="button" class="text-input item-picker-btn" data-item-picker="${i}" style="flex:2;">${escapeHtml(itemLabel(row))}</button>
        <input class="text-input" data-item-grams type="number" placeholder="${unit}" aria-label="Amount of item ${i + 1}" style="flex:1;" value="${row.grams || ''}">
        <button type="button" class="icon-btn-small" data-remove-item aria-label="Remove item">×</button>
      </div>
    `;
  }

  const body = `
    <h2>${isEdit ? 'Edit bundle' : 'New bundle'}</h2>
    <label class="field-label" for="bnd-name">Name</label>
    <input class="text-input" id="bnd-name" style="margin-bottom:12px;" value="${escapeHtml(initialName)}">
    <div class="field-label" style="margin-bottom:8px;">Items</div>
    <div id="bnd-items">${rows.map(rowHtml).join('')}</div>
    <button type="button" class="secondary-btn" id="bnd-add-item" style="text-align:center; margin-bottom:14px;">Add item</button>
    <div class="form-msg error" id="bnd-error" hidden></div>
    <div class="modal-actions">
      <button type="button" class="secondary-btn" id="bnd-cancel">Cancel</button>
      <button type="button" class="primary-btn" id="bnd-save">Save</button>
    </div>
  `;
  openModal(body);

  function rerenderItems() {
    document.getElementById('bnd-items').innerHTML = rows.map(rowHtml).join('');
    wireItemRows();
  }

  // Picking an item replaces the whole sheet with the full-screen picker, then rebuilds this
  // one from a snapshot once it returns — same restore pattern the recipe builder uses for
  // "New food", since only one sheet can be on screen at a time.
  function wireItemRows() {
    document.querySelectorAll('[data-item-picker]').forEach((btn, i) => btn.addEventListener('click', () => {
      const snapshot = { name: document.getElementById('bnd-name').value, rows: rows.map(r => ({ ...r })) };
      openBundleItemPicker(picked => {
        if (picked) {
          snapshot.rows[i].kind = picked.kind;
          snapshot.rows[i].id = picked.id;
          snapshot.rows[i].grams = picked.kind === 'food'
            ? (foodsById().get(picked.id)?.defaultPortionG ?? 100)
            : onePortionGrams(recipesById().get(picked.id));
        }
        openBundleModal(bundle, { restore: snapshot });
      });
    }));
    document.querySelectorAll('[data-item-grams]').forEach((inp, i) => inp.addEventListener('input', () => {
      rows[i].grams = inp.value;
    }));
    document.querySelectorAll('[data-remove-item]').forEach((btn, i) => btn.addEventListener('click', () => {
      rows.splice(i, 1);
      if (rows.length === 0) rows.push({ kind: '', id: '', grams: '' });
      rerenderItems();
    }));
  }
  wireItemRows();

  document.getElementById('bnd-add-item').addEventListener('click', () => {
    rows.push({ kind: '', id: '', grams: '' });
    rerenderItems();
  });
  document.getElementById('bnd-cancel').addEventListener('click', closeModal);

  document.getElementById('bnd-save').addEventListener('click', async () => {
    const obj = {
      id: isEdit ? bundle.id : slugify(document.getElementById('bnd-name').value.trim() || 'bundle'),
      name: document.getElementById('bnd-name').value.trim(),
      items: rows.filter(r => r.kind && r.id && r.grams).map(r => ({ kind: r.kind, id: r.id, grams: Number(r.grams) })),
    };
    const errors = validateBundle(obj);
    const errEl = document.getElementById('bnd-error');
    if (errors.length) { errEl.textContent = errors.join(' '); errEl.hidden = false; return; }
    await db.put('bundles', obj);
    await refreshCache();
    closeModal();
    renderBundles();
  });
}

// ==================== WORKOUTS ====================
// Week and session default to where the calendar actually is, so opening this at the gym
// shows today's numbers without touching anything. Both stay overridable.
const workoutState = { weekOverride: null, dayOverride: null, expanded: 0 };

function renderWorkouts() {
  const today = todayISO();
  const phase = activePhase(PHASES, today);
  if (!phase) return;

  const currentWeek = weekNumberFor(phase, today);
  const week = workoutState.weekOverride ?? currentWeek;
  const dayIndex = workoutState.dayOverride ?? defaultDayIndex(phase, today);
  const day = phase.days[dayIndex];

  document.getElementById('workout-phase-chip').textContent = phase.name;
  document.getElementById('workout-phase-note').textContent = `${phase.weeks}-week phase`;

  const weekChips = document.getElementById('workout-week-chips');
  weekChips.innerHTML = '';
  for (let w = 1; w <= phase.weeks; w++) {
    const isNow = w === currentWeek;
    const active = w === week;
    const chip = el(`<button type="button" class="week-chip${isNow ? ' is-now' : ''}${active ? ' active' : ''}" aria-label="Week ${w}${isNow ? ', current' : ''}">${w}${isNow ? '<span class="now">NOW</span>' : ''}</button>`);
    chip.addEventListener('click', () => { workoutState.weekOverride = w; workoutState.expanded = 0; renderWorkouts(); });
    weekChips.appendChild(chip);
  }

  const dayChips = document.getElementById('workout-day-chips');
  dayChips.innerHTML = '';
  phase.days.forEach((d, i) => {
    const chip = el(`<button type="button" class="rd-chip${i === dayIndex ? ' active' : ''}">${escapeHtml(d.dayLabel)} — ${escapeHtml(d.label)}</button>`);
    chip.addEventListener('click', () => { workoutState.dayOverride = i; workoutState.expanded = 0; renderWorkouts(); });
    dayChips.appendChild(chip);
  });

  const list = document.getElementById('workout-exercises');
  list.innerHTML = '';

  day.exercises.forEach((ex, i) => {
    const idx = String(i + 1).padStart(2, '0');
    const sets = String(ex.weeks[week] ?? '—');
    if (i !== workoutState.expanded) {
      const row = el(`
        <button type="button" class="ex-row">
          <span class="idx">${idx}</span>
          <span class="main"><span class="name">${escapeHtml(ex.name)}</span><span class="cue">${escapeHtml(ex.instructions)}</span></span>
          <span class="sets">${escapeHtml(sets)}</span>
        </button>
      `);
      row.style.overflow = 'hidden';
      row.querySelector('.cue').style.cssText = 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
      row.addEventListener('click', () => { workoutState.expanded = i; renderWorkouts(); });
      list.appendChild(row);
      return;
    }

    const otherWeeks = Object.keys(ex.weeks)
      .map(Number)
      .filter(w => w !== week && w <= phase.weeks)
      .map(w => `<span class="ex-week">W${w} ${escapeHtml(String(ex.weeks[w]))}</span>`)
      .join('');
    const media = ex.image
      ? `<img class="ex-card-img" src="${escapeHtml(ex.image)}" alt="" loading="lazy">`
      : '<div class="ex-card-img-ph">DEMO — MACHINE SETUP</div>';

    const card = el(`
      <div class="ex-card">
        <div class="ex-card-head">
          <span class="l"><span class="idx">${idx}</span><span class="name">${escapeHtml(ex.name)}</span></span>
        </div>
        <div class="ex-card-body">
          <div class="ex-card-sets">${escapeHtml(sets)}</div>
          ${media}
          <p class="ex-card-cue" style="margin:0;">${escapeHtml(ex.instructions)}</p>
          ${otherWeeks ? `<div class="ex-card-weeks">${otherWeeks}</div>` : ''}
          ${ex.link ? `<a class="rd-link" href="${escapeHtml(ex.link)}" target="_blank" rel="noopener noreferrer">How to do it — video guide ↗</a>` : ''}
        </div>
      </div>
    `);
    card.querySelector('.ex-card-head').addEventListener('click', () => { workoutState.expanded = -1; renderWorkouts(); });
    card.querySelector('.ex-card-head').style.cursor = 'pointer';
    list.appendChild(card);
  });
}

// ==================== HISTORY ====================
function renderHistory() {
  document.getElementById('history-jump-date').max = todayISO();
  renderHistoryList();
}

async function renderHistoryList() {
  const to = isoDaysAgo(1); // yesterday — today lives on the Today screen
  const from = isoDaysAgo(14);
  const list = document.getElementById('history-list');
  showSectionLoading(list);
  const entries = await db.entriesInRange(from, to);
  const byDate = new Map();
  for (const e of entries) {
    if (!byDate.has(e.date)) byDate.set(e.date, []);
    byDate.get(e.date).push(e);
  }
  const fMap = foodsById(), rMap = recipesById();
  const dates = Array.from(byDate.keys()).sort((a, b) => b.localeCompare(a));
  list.innerHTML = '';
  if (dates.length === 0) list.appendChild(el(`<div class="empty-state">No previous days logged yet.</div>`));
  for (const dateStr of dates) {
    const resolved = byDate.get(dateStr).map(e => entryMacros(e, fMap, rMap)).filter(Boolean);
    const kcalTotal = resolved.reduce((a, e) => a + e.kcal, 0);
    const protTotal = resolved.reduce((a, e) => a + e.protein, 0);
    const target = resolveTarget(cache.dayTargets, cache.overrides, dateStr, weekdayOf(dateStr));
    const kOver = target.kcal != null && kcalTotal > target.kcal;
    const pOver = target.protein != null && protTotal > target.protein;
    const over = kOver || pOver;
    const hasTarget = target.kcal != null || target.protein != null;

    let statusLabel = 'no target set';
    let diff = '';
    if (hasTarget) {
      statusLabel = over ? '▲ over target' : 'under target';
      if (target.kcal != null) {
        const d = kcalTotal - target.kcal;
        diff = `${d > 0 ? '+' : d < 0 ? '−' : ''}${Math.abs(d)}`;
      }
    }

    const card = el(`
      <button type="button" class="history-card${over ? ' is-over' : ''}">
        <div class="history-card-top">
          <span class="date">${formatDateHeader(dateStr)}</span>
          <span class="status${over ? ' is-over' : ''}">${statusLabel}</span>
        </div>
        <div class="history-card-figs">
          <span class="figs">
            <span><span class="v">${fmt(kcalTotal)}</span><span class="u">kcal</span></span>
            <span><span class="v">${protTotal} g</span><span class="u">protein</span></span>
          </span>
          ${diff ? `<span class="diff${over ? ' is-over' : ''}">${diff}</span>` : ''}
        </div>
      </button>
    `);
    card.addEventListener('click', () => openDayDetailModal(dateStr));
    list.appendChild(card);
  }
}

document.getElementById('history-jump-date').addEventListener('change', e => {
  if (e.target.value) openDayDetailModal(e.target.value);
});

// Itemised, read-only breakdown of a single date — reachable from a History card or by picking
// a date directly, since the 14-day History list and Today's own screen otherwise leave no way
// to see what was actually logged on an arbitrary day.
async function openDayDetailModal(dateStr) {
  openModal(`<h2 style="margin-bottom:14px;">${escapeHtml(formatDateHeader(dateStr))}</h2><div id="dd-body"></div>`);
  const body = document.getElementById('dd-body');
  showSectionLoading(body);

  const entries = await db.entriesInRange(dateStr, dateStr);
  const resolved = resolveEntriesForDisplay(entries, foodsById(), recipesById());
  const kcalTotal = resolved.reduce((a, e) => a + e.kcal, 0);
  const protTotal = resolved.reduce((a, e) => a + e.protein, 0);
  const target = resolveTarget(cache.dayTargets, cache.overrides, dateStr, weekdayOf(dateStr));
  const targetText = target.kcal != null || target.protein != null
    ? ` · target ${target.kcal ?? '—'} kcal / ${target.protein ?? '—'} g`
    : '';

  // Bail out silently if the modal was closed while this was in flight.
  if (!document.getElementById('dd-body')) return;

  body.innerHTML = '';
  body.appendChild(el(`<div class="u-figure" style="font-size:0.8125rem; color:var(--text-secondary); margin-bottom:12px;">${fmt(kcalTotal)} kcal · ${protTotal} g${targetText}</div>`));
  const list = el(`<div style="display:flex; flex-direction:column; gap:12px;"></div>`);
  body.appendChild(list);

  const { groups, unsorted } = groupEntriesByMeal(resolved);
  for (const meal of MEALS) {
    const entriesForMeal = groups.get(meal);
    if (entriesForMeal.length) list.appendChild(buildMealSection(meal, MEAL_LABELS[meal], entriesForMeal, { canAdd: false, interactive: false }));
  }
  if (unsorted.length) list.appendChild(buildMealSection(null, 'Not assigned', unsorted, { canAdd: false, interactive: false }));
  if (!resolved.length) list.appendChild(el(`<div class="empty-state">Nothing logged this day.</div>`));

  const actions = el(`
    <div class="modal-actions" style="margin-top:16px;">
      <button type="button" class="secondary-btn" id="dd-copy">Copy this day for Claude</button>
      <button type="button" class="primary-btn" id="dd-close">Close</button>
    </div>
  `);
  body.appendChild(actions);
  document.getElementById('dd-close').addEventListener('click', closeModal);
  document.getElementById('dd-copy').addEventListener('click', async () => {
    const text = await exportDay(dateStr);
    const ok = await copyText(text);
    toast(ok ? 'Copied that day' : 'Could not copy — check clipboard permission');
  });
}

document.getElementById('export-range-btn').addEventListener('click', () => {
  const body = `
    <h2>Copy a date range</h2>
    <label class="field-label" for="er-from">From</label>
    <input class="text-input" id="er-from" type="date" style="margin-bottom:12px;" value="${isoDaysAgo(7)}">
    <label class="field-label" for="er-to">To</label>
    <input class="text-input" id="er-to" type="date" style="margin-bottom:12px;" value="${isoDaysAgo(1)}">
    <div class="modal-actions">
      <button type="button" class="secondary-btn" id="er-cancel">Cancel</button>
      <button type="button" class="primary-btn" id="er-confirm">Copy</button>
    </div>
  `;
  openModal(body);
  document.getElementById('er-cancel').addEventListener('click', closeModal);
  document.getElementById('er-confirm').addEventListener('click', async () => {
    const from = document.getElementById('er-from').value;
    const to = document.getElementById('er-to').value;
    if (!from || !to) return;
    const text = await exportRange(from, to);
    const ok = await copyText(text);
    closeModal();
    toast(ok ? 'Copied range' : 'Could not copy — check clipboard permission');
  });
});

// ==================== SETTINGS ====================
function renderSettings() {
  document.getElementById('account-current-user').textContent = `Signed in as ${accountLabel(sessionUser)}`;
  renderSyncStatus();
  const list = document.getElementById('weekday-targets-list');
  list.innerHTML = '';
  for (const wd of WEEKDAY_ROWS) {
    const row = cache.dayTargets.find(d => d.weekday === wd) ?? { weekday: wd, kcal: null, protein: null };
    const rowEl = el(`
      <div class="weekday-row">
        <span class="day">${WEEKDAY_LABELS[wd].slice(0, 3)}</span>
        <div class="inputs">
          <input type="number" inputmode="numeric" aria-label="${WEEKDAY_LABELS[wd]} calorie target" placeholder="—" value="${row.kcal ?? ''}">
          <input type="number" inputmode="numeric" aria-label="${WEEKDAY_LABELS[wd]} protein target" placeholder="—" value="${row.protein ?? ''}">
        </div>
      </div>
    `);
    const [kcalInput, protInput] = rowEl.querySelectorAll('input');
    const save = async () => {
      await db.put('dayTargets', {
        weekday: wd,
        kcal: kcalInput.value === '' ? null : Number(kcalInput.value),
        protein: protInput.value === '' ? null : Number(protInput.value),
      });
      await refreshCache();
    };
    kcalInput.addEventListener('change', save);
    protInput.addEventListener('change', save);
    list.appendChild(rowEl);
  }

  renderOverrides();
  updateSettingsWeightAvg();
}

function renderOverrides() {
  const container = document.getElementById('overrides-list');
  container.innerHTML = '';
  const sorted = cache.overrides.slice().sort((a, b) => a.date.localeCompare(b.date));
  for (const o of sorted) {
    const row = el(`
      <div class="override-row">
        <div class="o-main">
          <div class="o-date">${escapeHtml(formatDateHeader(o.date))}</div>
        </div>
        <div class="o-vals">
          <input type="number" inputmode="numeric" placeholder="kcal" value="${o.kcal ?? ''}" aria-label="Override calorie target for ${o.date}">
          <input type="number" inputmode="numeric" placeholder="g" value="${o.protein ?? ''}" aria-label="Override protein target for ${o.date}">
          <button type="button" class="o-del" aria-label="Remove override for ${o.date}">×</button>
        </div>
      </div>
    `);
    const [kcalInput, protInput] = row.querySelectorAll('input[type="number"]');
    const save = async () => {
      await db.put('dayTargetOverrides', {
        date: o.date,
        kcal: kcalInput.value === '' ? null : Number(kcalInput.value),
        protein: protInput.value === '' ? null : Number(protInput.value),
      });
      await refreshCache();
    };
    kcalInput.addEventListener('change', save);
    protInput.addEventListener('change', save);
    row.querySelector('button').addEventListener('click', async () => {
      await db.remove('dayTargetOverrides', o.date);
      await refreshCache();
      renderOverrides();
    });
    container.appendChild(row);
  }
}

document.getElementById('add-override-btn').addEventListener('click', () => {
  const body = `
    <h2>Add a date override</h2>
    <label class="field-label" for="ov-date">Date</label>
    <input class="text-input" id="ov-date" type="date" style="margin-bottom:12px;">
    <label class="field-label" for="ov-kcal">Calorie target (optional)</label>
    <input class="text-input" id="ov-kcal" type="number" style="margin-bottom:12px;">
    <label class="field-label" for="ov-protein">Protein target (optional)</label>
    <input class="text-input" id="ov-protein" type="number" style="margin-bottom:12px;">
    <div class="form-msg error" id="ov-error" hidden></div>
    <div class="modal-actions">
      <button type="button" class="secondary-btn" id="ov-cancel">Cancel</button>
      <button type="button" class="primary-btn" id="ov-save">Save</button>
    </div>
  `;
  openModal(body);
  document.getElementById('ov-cancel').addEventListener('click', closeModal);
  document.getElementById('ov-save').addEventListener('click', async () => {
    const date = document.getElementById('ov-date').value;
    const errEl = document.getElementById('ov-error');
    if (!date) { errEl.textContent = 'Pick a date.'; errEl.hidden = false; return; }
    const kcalVal = document.getElementById('ov-kcal').value;
    const protVal = document.getElementById('ov-protein').value;
    await db.put('dayTargetOverrides', {
      date,
      kcal: kcalVal === '' ? null : Number(kcalVal),
      protein: protVal === '' ? null : Number(protVal),
    });
    await refreshCache();
    closeModal();
    renderSettings();
  });
});

function updateSettingsWeightAvg() {
  const avg = averageWeight(cache.weightLog);
  document.getElementById('settings-weight-avg').textContent = avg == null ? 'no data' : `${avg.toFixed(1)} avg`;
}

// ==================== BODY WEIGHT ====================
function renderWeight() {
  const series = weightSeries(cache.weightLog); // ascending by date
  const avg = averageWeight(cache.weightLog);

  document.getElementById('weight-avg').textContent = avg == null ? '—' : avg.toFixed(1);
  document.getElementById('weight-latest').textContent =
    series.length ? series[series.length - 1].kg.toFixed(1) : '—';

  const changeEl = document.getElementById('weight-change');
  const changeLabel = document.getElementById('weight-change-label');
  if (series.length < 2) {
    changeEl.textContent = '—';
    changeLabel.textContent = 'change';
  } else {
    const delta = series[series.length - 1].kg - series[0].kg;
    changeEl.textContent = `${delta > 0 ? '+' : ''}${delta.toFixed(1)}`;
    const weeks = Math.max(1, Math.round((Date.parse(series[series.length - 1].date) - Date.parse(series[0].date)) / (7 * 86400000)));
    changeLabel.textContent = `${weeks} week${weeks === 1 ? '' : 's'}`;
  }

  const chart = document.getElementById('weight-chart');
  chart.innerHTML = '';
  chart.appendChild(buildWeightChart(series));

  const list = document.getElementById('weight-entries');
  list.innerHTML = '';
  if (!series.length) {
    list.appendChild(el(`<div class="empty-state">No weight entries yet.</div>`));
    return;
  }
  for (const w of series.slice().reverse()) { // newest first in the list
    const row = el(`
      <button type="button" class="weight-entry">
        <span class="d">${escapeHtml(formatDateHeader(w.date))}</span>
        <span class="k">${w.kg.toFixed(1)} kg</span>
      </button>
    `);
    row.addEventListener('click', () => openWeightModal(w));
    list.appendChild(row);
  }
}

// The "route profile" — an inline SVG line graph of the weigh-ins. X is spaced by actual date
// gaps (not entry index) so an irregular cadence reads honestly. Colours are CSS vars so it
// tracks the theme; the latest reading gets a solid dot.
function buildWeightChart(series) {
  if (series.length < 2) {
    return el(`<div class="empty-state">Not enough data yet. Two weigh-ins draw a trend.</div>`);
  }
  const W = 320, H = 150, padX = 12, padT = 16, padB = 30;
  const first = Date.parse(series[0].date);
  const last = Date.parse(series[series.length - 1].date);
  const span = Math.max(1, last - first);
  const kgs = series.map(w => w.kg);
  let lo = Math.min(...kgs), hi = Math.max(...kgs);
  if (lo === hi) { lo -= 1; hi += 1; }
  const margin = (hi - lo) * 0.22;
  lo -= margin; hi += margin;

  const xOf = d => padX + ((Date.parse(d) - first) / span) * (W - padX * 2);
  const yOf = kg => padT + (1 - (kg - lo) / (hi - lo)) * (H - padT - padB);

  const path = series.map((w, i) => `${i ? 'L' : 'M'}${xOf(w.date).toFixed(1)} ${yOf(w.kg).toFixed(1)}`).join(' ');
  const gridY = [0, 1, 2].map(i => padT + (i / 2) * (H - padT - padB));
  const grid = gridY.map(y => `<line x1="0" y1="${y.toFixed(1)}" x2="${W}" y2="${y.toFixed(1)}" stroke="var(--line-soft)" stroke-width="1"></line>`).join('');
  const dots = series.map((w, i) => {
    const last = i === series.length - 1;
    return last
      ? `<circle cx="${xOf(w.date).toFixed(1)}" cy="${yOf(w.kg).toFixed(1)}" r="5" fill="var(--accent)"></circle>`
      : `<circle cx="${xOf(w.date).toFixed(1)}" cy="${yOf(w.kg).toFixed(1)}" r="3.5" fill="var(--raised)" stroke="var(--accent)" stroke-width="2.5"></circle>`;
  }).join('');
  const fmtX = d => { const dt = new Date(Date.parse(d)); return `${dt.getDate()} ${dt.toLocaleDateString('en-GB', { month: 'short' })}`; };

  return el(`
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Body weight trend">
      ${grid}
      <path d="${path}" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"></path>
      ${dots}
      <text x="${padX}" y="${H - 8}" font-family="var(--font-figure)" font-size="11" fill="var(--text-secondary)">${fmtX(series[0].date)}</text>
      <text x="${W - padX}" y="${H - 8}" text-anchor="end" font-family="var(--font-figure)" font-size="11" fill="var(--text-secondary)">${fmtX(series[series.length - 1].date)}</text>
    </svg>
  `);
}

// Add (no arg) or edit (pass the existing { date, kg }) a weigh-in. The date is the record's
// key, so changing it on an edit deletes the old-dated record rather than leaving a duplicate.
function openWeightModal(existing) {
  const isEdit = !!existing;
  const state = {
    date: isEdit ? existing.date : todayISO(),
    kg: isEdit ? existing.kg : (weightSeries(cache.weightLog).at(-1)?.kg ?? 70),
  };

  openModal(`
    <div class="sheet">
      <div class="sheet-title-row">
        <h2>${isEdit ? 'Edit weight' : 'Log a weight'}</h2>
        <button type="button" class="sheet-cancel" id="w-cancel">Cancel</button>
      </div>

      <div class="sheet-big-stepper">
        <button type="button" id="w-minus" aria-label="Down 0.1 kg">−</button>
        <div class="sheet-big-value">
          <input id="w-kg" type="text" inputmode="decimal" aria-label="Weight in kilograms">
          <span class="u">kg</span>
        </div>
        <button type="button" id="w-plus" aria-label="Up 0.1 kg">+</button>
      </div>

      <div class="sheet-row">
        <span>Date</span>
        <input type="date" class="sheet-date-chip" id="w-date" max="${todayISO()}" value="${state.date}" aria-label="Date">
      </div>

      <div class="sheet-fig-strip">
        <div><div id="w-eff-avg">—</div><div>new average</div></div>
        <div><div id="w-eff-delta">—</div><div id="w-eff-span">trend</div></div>
      </div>

      <div class="sheet-help">Weighed first thing, before breakfast, gives the steadiest trend.</div>
      <div class="form-msg error" id="w-error" hidden></div>
      ${isEdit ? '<button type="button" class="sheet-more" id="w-delete" style="color:var(--accent);">Delete this entry</button>' : ''}
      <button type="button" class="sheet-primary" id="w-save">Save weight</button>
    </div>
  `);

  const kgInput = document.getElementById('w-kg');
  const round1 = n => Math.round(n * 10) / 10;

  const syncEffect = () => {
    // Recompute the average and the first→now delta as if this entry were saved.
    const others = weightSeries(cache.weightLog).filter(w => w.date !== state.date);
    const merged = [...others, { date: state.date, kg: state.kg }].sort((a, b) => a.date.localeCompare(b.date));
    const avg = merged.reduce((s, w) => s + w.kg, 0) / merged.length;
    document.getElementById('w-eff-avg').textContent = avg.toFixed(1);
    if (merged.length >= 2 && merged[0].date !== state.date) {
      const d = state.kg - merged[0].kg;
      document.getElementById('w-eff-delta').textContent = `${d > 0 ? '+' : d < 0 ? '−' : ''}${Math.abs(round1(d)).toFixed(1)}`;
      const weeks = Math.max(1, Math.round((Date.parse(state.date) - Date.parse(merged[0].date)) / (7 * 86400000)));
      document.getElementById('w-eff-span').textContent = `${weeks} week${weeks === 1 ? '' : 's'}`;
    } else {
      document.getElementById('w-eff-delta').textContent = '—';
      document.getElementById('w-eff-span').textContent = 'trend';
    }
  };
  const showKg = () => { kgInput.value = state.kg.toFixed(1); };
  const step = delta => { state.kg = round1(Math.max(0.1, state.kg + delta)); showKg(); syncEffect(); };

  showKg();
  syncEffect();
  document.getElementById('w-minus').addEventListener('click', () => step(-0.1));
  document.getElementById('w-plus').addEventListener('click', () => step(0.1));
  kgInput.addEventListener('input', () => {
    const n = Number(kgInput.value.replace(',', '.'));
    if (n > 0) { state.kg = n; syncEffect(); }
  });
  kgInput.addEventListener('blur', showKg);
  document.getElementById('w-date').addEventListener('change', e => {
    state.date = e.target.value || todayISO();
    syncEffect();
  });
  document.getElementById('w-cancel').addEventListener('click', closeModal);

  const deleteBtn = document.getElementById('w-delete');
  if (deleteBtn) deleteBtn.addEventListener('click', async () => {
    await db.remove('weightLog', existing.date);
    await refreshCache();
    closeModal();
    afterWeightChange('Weight entry deleted');
  });

  document.getElementById('w-save').addEventListener('click', async () => {
    const kg = round1(Number(kgInput.value.replace(',', '.')));
    const errEl = document.getElementById('w-error');
    if (!state.date || !(kg > 0)) {
      errEl.textContent = 'Enter a date and a weight above zero.';
      errEl.hidden = false;
      return;
    }
    if (isEdit && existing.date !== state.date) await db.remove('weightLog', existing.date);
    await db.put('weightLog', { date: state.date, kg });
    await refreshCache();
    closeModal();
    afterWeightChange('Weight saved');
  });
}

function afterWeightChange(msg) {
  renderWeight();
  updateSettingsWeightAvg();
  toast(msg);
}

document.getElementById('weight-add-btn').addEventListener('click', () => openWeightModal());
document.getElementById('open-weight-btn').addEventListener('click', () => goTo('weight'));
document.getElementById('weight-back').addEventListener('click', () => goTo('settings'));

document.getElementById('open-history-btn').addEventListener('click', () => goTo('history'));
document.getElementById('history-back').addEventListener('click', () => goTo('settings'));

document.getElementById('logout-btn').addEventListener('click', async () => {
  await logout();
  // onUserChanged puts the login screen back up.
});

document.getElementById('export-all-btn').addEventListener('click', async () => {
  const [foods, recipes, bundles, logEntries, dayTargets, overrides, weightLog] = await Promise.all([
    db.getAll('foods'), db.getAll('recipes'), db.getAll('bundles'), db.getAll('logEntries'), db.getAll('dayTargets'), db.getAll('dayTargetOverrides'), db.getAll('weightLog'),
  ]);
  const text = JSON.stringify({ foods, recipes, bundles, logEntries, dayTargets, dayTargetOverrides: overrides, weightLog }, null, 2);
  const ok = await copyText(text);
  toast(ok ? 'Copied full data export' : 'Could not copy — check clipboard permission');
});

// ==================== MODAL ====================
// Lock the modal backdrop to the visual viewport (the area *above* the on-screen
// keyboard) so the bottom-anchored sheet is never hidden behind the keyboard.
// Without this, position:fixed on iOS is relative to the full layout viewport,
// which extends behind the keyboard.
function syncModalViewport() {
  const backdrop = document.getElementById('modal-backdrop');
  const vv = window.visualViewport;
  if (backdrop.hidden || !vv) return;
  const s = backdrop.style;
  s.setProperty('--vv-top', vv.offsetTop + 'px');
  s.setProperty('--vv-left', vv.offsetLeft + 'px');
  s.setProperty('--vv-width', vv.width + 'px');
  s.setProperty('--vv-height', vv.height + 'px');
}
function clearModalViewport() {
  const s = document.getElementById('modal-backdrop').style;
  s.removeProperty('--vv-top');
  s.removeProperty('--vv-left');
  s.removeProperty('--vv-width');
  s.removeProperty('--vv-height');
}
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', syncModalViewport);
  window.visualViewport.addEventListener('scroll', syncModalViewport);
}

// Set by a sub-flow (e.g. the bundle item picker) that isn't a dead end — closing it, by
// whatever means (Cancel, backdrop tap, drag-to-close), should resume the sheet it was opened
// from rather than just exit. Cleared by closeModal() itself, and by anything that leaves the
// sub-flow without going through closeModal() (picking a result opens the next sheet directly).
let pendingModalCancel = null;

function openModal(bodyHtml) {
  const backdrop = document.getElementById('modal-backdrop');
  const sheet = document.getElementById('modal-sheet');
  document.getElementById('modal-sheet-body').innerHTML = bodyHtml;
  backdrop.hidden = false;
  // The page behind must stay put while a sheet is up. The scrolling element is .screen, not
  // body, so locking body alone would do nothing here.
  document.body.classList.add('modal-open');
  document.getElementById('modal-sheet-body').scrollTop = 0;
  // A previous sheet may have been left mid-drag (closeModal always resets this, but belt
  // and braces so a fresh sheet never opens already offset).
  sheet.style.transform = '';
  syncModalViewport();
}
function closeModal() {
  const resume = pendingModalCancel;
  pendingModalCancel = null;
  document.getElementById('modal-backdrop').hidden = true;
  document.getElementById('modal-sheet-body').innerHTML = '';
  const sheet = document.getElementById('modal-sheet');
  sheet.style.transform = '';
  sheet.style.transition = '';
  clearModalViewport();
  document.body.classList.remove('modal-open');
  if (resume) resume();
}
// When a field inside the sheet gets focus, wait for the keyboard/viewport to
// settle, then bring it into view within the (now shorter) scrollable sheet.
document.getElementById('modal-sheet').addEventListener('focusin', e => {
  setTimeout(() => {
    syncModalViewport();
    e.target.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, 300);
});
document.getElementById('modal-backdrop').addEventListener('click', e => {
  if (e.target.id === 'modal-backdrop') closeModal();
});

// Dragging the handle down closes the sheet — the handle sits outside the scrollable body
// (see .modal-sheet-handle), so this never fights normal scrolling inside a long form.
(function setupSheetDragToClose() {
  const sheet = document.getElementById('modal-sheet');
  const handle = document.getElementById('modal-sheet-handle');
  const CLOSE_THRESHOLD = 90;
  let dragging = false;
  let startY = 0;
  let deltaY = 0;

  handle.addEventListener('pointerdown', e => {
    dragging = true;
    startY = e.clientY;
    deltaY = 0;
    sheet.style.transition = 'none';
    handle.setPointerCapture(e.pointerId);
  });
  handle.addEventListener('pointermove', e => {
    if (!dragging) return;
    deltaY = Math.max(0, e.clientY - startY);
    sheet.style.transform = `translateY(${deltaY}px)`;
  });
  function endDrag() {
    if (!dragging) return;
    dragging = false;
    sheet.style.transition = '';
    if (deltaY > CLOSE_THRESHOLD) closeModal();
    else sheet.style.transform = '';
  }
  handle.addEventListener('pointerup', endDrag);
  handle.addEventListener('pointercancel', endDrag);
})();

// ==================== LOGIN GATE ====================
let sessionUser = null;

const emailInput = document.getElementById('login-email');
const passwordInput = document.getElementById('login-password');
const submitBtn = document.getElementById('login-submit');

function updateLoginSubmitEnabled() {
  submitBtn.disabled = !emailInput.value.trim() || !passwordInput.value;
}
emailInput.addEventListener('input', updateLoginSubmitEnabled);
passwordInput.addEventListener('input', updateLoginSubmitEnabled);
for (const field of [emailInput, passwordInput]) {
  field.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !submitBtn.disabled) submitLogin();
  });
}
submitBtn.addEventListener('click', submitLogin);

async function submitLogin() {
  const errorEl = document.getElementById('login-error');
  errorEl.hidden = true;
  submitBtn.disabled = true;
  submitBtn.textContent = 'Signing in…';
  try {
    await login(emailInput.value, passwordInput.value);
    // onUserChanged drives the unlock, so nothing more to do here.
  } catch (err) {
    errorEl.textContent = friendlyAuthError(err);
    errorEl.hidden = false;
    submitBtn.textContent = 'Sign in';
    updateLoginSubmitEnabled();
  }
}

// The splash stays up across both the "app loading" phase (this module executing) and the
// "data loading" phase (auth resolving, seed, first cache fill) below, so it only needs
// hiding once boot lands on either the unlocked app or the login screen.
function hideSplash() {
  const splash = document.getElementById('splash-screen');
  if (!splash || splash.hidden) return;
  splash.classList.add('splash-hide');
  setTimeout(() => { splash.hidden = true; }, 220);
}

async function unlockApp(user) {
  sessionUser = user;
  db.setCurrentUser(user.uid);
  document.getElementById('login-screen').hidden = true;
  document.getElementById('app').hidden = false;
  passwordInput.value = '';

  // These two are independent — no reason to wait for one before starting the other.
  await Promise.all([seedSharedIfEmpty(), seedUserIfEmpty(user.uid)]);
  await maybeOfferMigration();
  await refreshEssentialCache();
  if (!location.hash) location.hash = 'today';
  renderRoute();
  hideSplash();

  // Weight log and quick-log favourites aren't needed for this first paint. Fetch them after,
  // and only pay for a second render if the screen actually on-screen turns out to use them.
  refreshBackgroundCache().then(renderRoute).catch(() => {});
}

function showLoginScreen() {
  sessionUser = null;
  db.setCurrentUser(null);
  document.getElementById('app').hidden = true;
  document.getElementById('login-screen').hidden = false;
  submitBtn.textContent = 'Sign in';
  updateLoginSubmitEnabled();
  hideSplash();
}

// ==================== MIGRATION FROM THE LOCAL-ONLY BUILD ====================
// Offered once per account, and only ever additive — the old local data is never deleted, so
// a failed or declined upload leaves the previous build's copy intact on the device.
async function maybeOfferMigration() {
  try {
    if (await alreadyMigrated()) return;
    const legacy = await findLegacyData();
    if (!legacy.hasAnything) { await markMigrated(); return; }

    const accountRows = legacy.accounts.map(a => `
      <label style="display:flex; align-items:center; gap:10px; padding:10px 0; border-bottom:1px solid var(--hairline);">
        <input type="checkbox" data-legacy-account="${escapeHtml(a.name)}" ${legacy.accounts.length === 1 ? 'checked' : ''}>
        <span style="flex:1;">
          <span style="font-size:0.9375rem; font-weight:500;">${escapeHtml(a.name)}</span>
          <span style="display:block; font-family:var(--font-mono); font-size:0.6875rem; color:var(--text-secondary);">
            ${a.logEntries.length} entries · ${a.weightLog.length} weights
          </span>
        </span>
      </label>
    `).join('');

    openModal(`
      <h2>Bring your existing data across</h2>
      <p style="font-size:0.8125rem; color:var(--text-secondary); margin-top:0;">
        Found data saved on this device by the previous version. Upload it to your account so it
        syncs to your other devices? Nothing on this device is deleted either way.
      </p>
      <div class="weight-row" style="border-bottom:1px solid var(--hairline);">
        <span>Foods &amp; recipes</span>
        <span>${legacy.foods.length} + ${legacy.recipes.length}</span>
      </div>
      ${accountRows ? `<div style="margin-top:6px;">${accountRows}</div>` : ''}
      <p style="font-size:0.75rem; color:var(--text-secondary);">
        Tick only the daily log that belongs to <strong>${escapeHtml(accountLabel(sessionUser))}</strong>.
        Anything else should be uploaded by that person from their own account.
      </p>
      <div class="form-msg error" id="mig-error" hidden></div>
      <div class="modal-actions">
        <button type="button" class="secondary-btn" id="mig-skip">Not now</button>
        <button type="button" class="primary-btn" id="mig-go">Upload</button>
      </div>
    `);

    await new Promise(resolve => {
      document.getElementById('mig-skip').addEventListener('click', () => { closeModal(); resolve(); });
      document.getElementById('mig-go').addEventListener('click', async () => {
        const btn = document.getElementById('mig-go');
        btn.disabled = true;
        btn.textContent = 'Uploading…';
        try {
          const chosen = [...document.querySelectorAll('[data-legacy-account]')]
            .filter(cb => cb.checked)
            .map(cb => legacy.accounts.find(a => a.name === cb.dataset.legacyAccount));
          const sharedResult = await uploadShared(legacy);
          let entries = 0;
          for (const account of chosen) {
            const r = await uploadAccount(account);
            entries += r.logEntries;
          }
          await markMigrated();
          closeModal();
          toast(`Uploaded ${sharedResult.foods} foods, ${entries} entries`);
          resolve();
        } catch (err) {
          const errEl = document.getElementById('mig-error');
          errEl.textContent = 'Upload failed — your local data is untouched. Try again later from Settings.';
          errEl.hidden = false;
          btn.disabled = false;
          btn.textContent = 'Upload';
        }
      });
    });
  } catch {
    // Migration is a convenience; never let it block getting into the app.
  }
}

// ==================== CONNECTION STATUS ====================
function renderSyncStatus() {
  const online = navigator.onLine;
  for (const id of ['sync-badge', 'library-sync-badge']) {
    const badge = document.getElementById(id);
    if (!badge) continue;
    badge.className = `badge ${online ? 'badge-synced' : 'badge-offline'}`;
    badge.innerHTML = `${badgeIcon(online ? 'synced' : 'offline')} ${online ? 'synced' : 'offline'}`;
  }
}
window.addEventListener('online', renderSyncStatus);
window.addEventListener('offline', renderSyncStatus);

// ==================== BOOT ====================
function boot() {
  renderSyncStatus();
  initPullToRefresh();

  // Firebase restores the previous session asynchronously, so the app unlocks from here
  // rather than from the sign-in button.
  onUserChanged(async user => {
    if (user) {
      try {
        await unlockApp(user);
      } catch (err) {
        const errorEl = document.getElementById('login-error');
        showLoginScreen();
        errorEl.textContent = 'Signed in, but could not load your data. Check your connection and try again.';
        errorEl.hidden = false;
      }
    } else {
      showLoginScreen();
    }
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline install will retry next online visit */ });
  }
}

boot();
