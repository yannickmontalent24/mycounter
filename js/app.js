import * as db from './db.js';
import { seedSharedIfEmpty, seedUserIfEmpty } from './seed.js';
import {
  resolveTarget, weekdayOf, heroState, ringDash, entryMacros,
  foodPortionMacros, recipePerGram, validateFood, validateRecipe, formatDateHeader,
  isDraftRecipe, findSimilarFoods, unitOf,
  MEALS, MEAL_LABELS, inferMeal, groupEntriesByMeal, sumMacros, resolveEntriesForDisplay,
} from './logic.js';
import {
  exportDay, exportRange, prepareImport, commitImport, exportLibraryForClaude, ImportError,
} from './import-export.js';
import { login, logout, onUserChanged, accountLabel, friendlyAuthError } from './auth.js';
import { findLegacyData, uploadShared, uploadAccount, alreadyMigrated, markMigrated } from './migrate.js';

const WEEKDAY_ROWS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const WEEKDAY_LABELS = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };
const SOURCE_GLYPH = { label: '■', reference: '□', estimate: '◇' };

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

// ---- In-memory cache, refreshed from IndexedDB after any mutation ----
const cache = { foods: [], recipes: [], dayTargets: [], overrides: [], weightLog: [], foodFrequency: new Map() };

async function refreshCache() {
  const [foods, recipes, dayTargets, overrides, weightLog] = await Promise.all([
    db.getAll('foods'), db.getAll('recipes'), db.getAll('dayTargets'), db.getAll('dayTargetOverrides'), db.getAll('weightLog'),
  ]);
  cache.foods = foods;
  cache.recipes = recipes;
  cache.dayTargets = dayTargets;
  cache.overrides = overrides;
  cache.weightLog = weightLog.sort((a, b) => b.date.localeCompare(a.date));

  // How often each food has been logged recently, so the Log screen can lead with the foods
  // actually eaten rather than whatever happens to sort first.
  const recent = await db.entriesInRange(isoDaysAgo(60), todayISO());
  const freq = new Map();
  for (const e of recent) {
    const key = e.foodId ? `food:${e.foodId}` : (e.recipeId ? `recipe:${e.recipeId}` : null);
    if (!key) continue;
    freq.set(key, (freq.get(key) ?? 0) + 1);
  }
  cache.foodFrequency = freq;
}

function foodsById() { return new Map(cache.foods.map(f => [f.id, f])); }
function recipesById() { return new Map(cache.recipes.map(r => [r.id, r])); }

// ---- Routing ----
const SCREENS = ['today', 'log', 'foods', 'recipes', 'history', 'settings'];

function currentScreenFromHash() {
  const h = location.hash.replace('#', '');
  return SCREENS.includes(h) ? h : 'today';
}

function goTo(screen) {
  location.hash = screen;
}

function renderRoute() {
  const screen = currentScreenFromHash();
  for (const s of SCREENS) {
    document.getElementById(`screen-${s}`).hidden = s !== screen;
  }
  document.querySelectorAll('.tab-btn').forEach(btn => {
    const active = btn.dataset.go === screen;
    btn.classList.toggle('active', active);
    btn.querySelector('.indicator').textContent = active ? '━' : '';
  });
  const renderers = { today: renderToday, log: renderLog, foods: renderFoods, recipes: renderRecipes, history: renderHistory, settings: renderSettings };
  renderers[screen]();
}

window.addEventListener('hashchange', renderRoute);
document.querySelectorAll('.tab-btn').forEach(btn => btn.addEventListener('click', () => goTo(btn.dataset.go)));

// ==================== TODAY ====================
async function renderToday() {
  const dateStr = todayISO();
  document.getElementById('today-date-chip').textContent = formatDateHeader(dateStr);

  const entries = await db.entriesInRange(dateStr, dateStr);
  const resolved = resolveEntriesForDisplay(entries, foodsById(), recipesById());

  const kcalTotal = resolved.reduce((a, e) => a + e.kcal, 0);
  const protTotal = resolved.reduce((a, e) => a + e.protein, 0);
  const target = resolveTarget(cache.dayTargets, cache.overrides, dateStr, weekdayOf(dateStr));

  const k = heroState(kcalTotal, target.kcal);
  const p = heroState(protTotal, target.protein);

  applyHero('kcal', k, kcalTotal, target.kcal);
  applyHero('protein', p, protTotal, target.protein);

  document.getElementById('today-totals-line').textContent = `${kcalTotal} kcal · ${protTotal} g`;
  document.getElementById('today-day-total').textContent = `${kcalTotal} kcal · ${protTotal} g`;

  const list = document.getElementById('today-entry-list');
  list.innerHTML = '';

  const { groups, unsorted } = groupEntriesByMeal(resolved);
  for (const meal of MEALS) {
    list.appendChild(buildMealSection(meal, MEAL_LABELS[meal], groups.get(meal), { canAdd: true }));
  }
  if (unsorted.length) {
    list.appendChild(buildMealSection(null, 'Not assigned', unsorted, { canAdd: false }));
  }
}

// One section per meal. Empty sections still render, because their "+" is the way to log
// into that meal (feature brief §3) — but they stay compact so the day is still scannable.
function buildMealSection(meal, label, entries, { canAdd }) {
  const totals = sumMacros(entries);
  const section = el(`
    <section class="meal-section">
      <div class="meal-header">
        <span class="meal-title">${escapeHtml(label)}</span>
        <span class="meal-subtotal">${entries.length ? `${totals.kcal} kcal · ${totals.protein} g` : ''}</span>
        ${canAdd ? `<button type="button" class="meal-add" data-add-meal="${meal}" aria-label="Log food under ${escapeHtml(label)}">+</button>` : ''}
      </div>
      <div class="meal-rows"></div>
    </section>
  `);

  const rows = section.querySelector('.meal-rows');
  if (!entries.length) {
    rows.appendChild(el(`<div class="meal-empty">—</div>`));
  }
  for (const e of entries) {
    const row = el(`
      <div class="entry-row">
        <div class="entry-main">
          <div class="entry-name">${escapeHtml(e.name)}</div>
          <div class="entry-detail">${e.grams} ${e.unit}</div>
        </div>
        <div class="entry-values">
          <div>${e.kcal} kcal</div>
          <div class="protein">${e.protein} g protein</div>
        </div>
        <button type="button" class="icon-btn-small" data-move-entry="${e.id}" aria-label="Change meal for ${escapeHtml(e.name)}">⇄</button>
        <button type="button" class="delete-btn" aria-label="Delete ${escapeHtml(e.name)}">×</button>
      </div>
    `);
    row.querySelector('.delete-btn').addEventListener('click', async () => {
      await db.remove('logEntries', e.id);
      renderToday();
    });
    row.querySelector('[data-move-entry]').addEventListener('click', () => openMealPicker(e));
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
  await refreshCache();
  closeModal();
  renderToday();
}

function openMealPicker(entry) {
  const buttons = MEALS.map(m => `
    <button type="button" class="secondary-btn" data-pick-meal="${m}" style="margin-bottom:8px; text-align:center;">${MEAL_LABELS[m]}</button>
  `).join('');
  openModal(`
    <h2>Move to which meal?</h2>
    <p style="font-size:0.8125rem; color:var(--text-secondary); margin-top:0;">${escapeHtml(entry.name)}</p>
    ${buttons}
    <div class="modal-actions">
      <button type="button" class="secondary-btn" id="meal-cancel" style="text-align:center;">Cancel</button>
    </div>
  `);
  document.getElementById('meal-cancel').addEventListener('click', closeModal);
  document.querySelectorAll('[data-pick-meal]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const stored = await db.get('logEntries', entry.id);
      if (stored) await db.put('logEntries', { ...stored, meal: btn.dataset.pickMeal });
      closeModal();
      renderToday();
    });
  });
}

function applyHero(kind, state, consumed, target) {
  const heroEl = document.getElementById(`${kind}-hero`);
  const stateEl = document.getElementById(`${kind}-state`);
  const ofTargetEl = document.getElementById(`${kind}-of-target`);
  const ringEl = document.getElementById(`${kind}-ring`);
  const unitWord = kind === 'kcal' ? 'kcal' : 'g';

  if (state.remaining == null) {
    heroEl.textContent = '—';
    stateEl.querySelector('.mark').textContent = '·';
    stateEl.querySelector('.text').textContent = 'no target set';
    stateEl.style.color = 'var(--text-secondary)';
    ofTargetEl.textContent = `${consumed} logged`;
    ringEl.setAttribute('stroke-dasharray', '0 339.3');
    ringEl.setAttribute('stroke', 'var(--text-secondary)');
    return;
  }
  const overColor = 'var(--red)';
  const baseColor = kind === 'kcal' ? 'var(--navy)' : 'var(--teal)';
  const color = state.over ? overColor : baseColor;
  heroEl.textContent = (state.over ? '+' : '') + Math.abs(state.remaining);
  heroEl.style.color = color;
  stateEl.querySelector('.mark').textContent = state.mark;
  stateEl.querySelector('.text').textContent = state.stateText;
  stateEl.style.color = color;
  ofTargetEl.textContent = `${consumed} / ${target} ${unitWord}`;
  ringEl.setAttribute('stroke-dasharray', ringDash(consumed, target));
  ringEl.setAttribute('stroke', color);
}

document.getElementById('export-day-btn').addEventListener('click', async () => {
  const text = await exportDay(todayISO());
  const ok = await copyText(text);
  toast(ok ? 'Copied today’s log' : 'Could not copy — check clipboard permission');
});

// ==================== LOG ENTRY ====================
// `meal` is null until the user logs, at which point it's inferred from the clock — unless
// they arrived via a section's "+", which sets it explicitly.
const logState = { query: '', pickedId: null, pickedKind: null, grams: '', meal: null };

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
  document.getElementById('amount-label').textContent = unit === 'ml' ? 'Amount (ml)' : 'Amount (g)';

  const effectiveMeal = logState.meal ?? inferMeal();
  const chip = document.getElementById('log-meal-chip');
  chip.textContent = MEAL_LABELS[effectiveMeal];
  chip.setAttribute('aria-label', `Meal: ${MEAL_LABELS[effectiveMeal]}. Tap to change.`);
}

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
      per100Text = per100 ? `${per100.kcal} kcal · ${per100.protein} g /100g` : 'unavailable';
    } else {
      per100Text = `${record.per100g.kcal} kcal · ${record.per100g.protein} g /100${unitOf(record)}`;
    }
    const selected = logState.pickedId === record.id && logState.pickedKind === kind;
    const btn = el(`
      <button type="button" class="search-result-btn">
        <span class="name">${escapeHtml(record.name)}${kind === 'recipe' ? ' <span class="recipe-tag">recipe</span>' : ''}</span>
        <span class="per100">${per100Text}</span>
        <span class="check">${selected ? '●' : '○'}</span>
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
  // Foods tab and back mid-log. This is the moment most likely to end a logging habit.
  if (q && results.length === 0) {
    const raw = logState.query.trim();
    const addBtn = el(`
      <button type="button" class="search-result-btn quick-add-row">
        <span class="name">+ Add “${escapeHtml(raw)}” as a new food</span>
      </button>
    `);
    addBtn.addEventListener('click', () => openQuickAddFoodModal(raw));
    container.appendChild(addBtn);
  }
}

// Deliberately fewer fields than the full Add food form: name, the two numbers that matter,
// portion, source. Everything else can be filled in later from the Foods tab.
function openQuickAddFoodModal(prefillName, { onSaved = null } = {}) {
  const body = `
    <h2>Quick add food</h2>
    <label class="field-label" for="q-name">Name</label>
    <input class="text-input" id="q-name" style="margin-bottom:12px;" value="${escapeHtml(prefillName)}">
    <label class="field-label" for="q-unit">Measured in</label>
    <select class="text-input" id="q-unit" style="margin-bottom:12px;">
      <option value="g">grams — solid food</option>
      <option value="ml">millilitres — drinks</option>
    </select>
    <label class="field-label" for="q-kcal"><span data-unit-word>Calories per 100 g</span></label>
    <input class="text-input" id="q-kcal" type="number" inputmode="numeric" style="margin-bottom:12px;">
    <label class="field-label" for="q-protein"><span data-unit-word>Protein per 100 g</span></label>
    <input class="text-input" id="q-protein" type="number" inputmode="decimal" style="margin-bottom:12px;">
    <label class="field-label" for="q-portion"><span data-unit-word>Usual portion (g)</span></label>
    <input class="text-input" id="q-portion" type="number" inputmode="numeric" style="margin-bottom:12px;" value="100">
    <label class="field-label" for="q-source">Source</label>
    <select class="text-input" id="q-source" style="margin-bottom:12px;">
      <option value="label">label — from packaging</option>
      <option value="reference">reference — published table</option>
      <option value="estimate">estimate — entered by hand</option>
    </select>
    <div class="form-msg error" id="q-error" hidden></div>
    <div class="form-msg" id="q-warn" hidden style="color:var(--amber);"></div>
    <div class="modal-actions">
      <button type="button" class="secondary-btn" id="q-cancel">Cancel</button>
      <button type="button" class="primary-btn" id="q-save">Save &amp; select</button>
    </div>
  `;
  openModal(body);
  document.getElementById('q-cancel').addEventListener('click', closeModal);

  const qUnitSelect = document.getElementById('q-unit');
  const applyQuickUnitLabels = () => {
    const u = qUnitSelect.value;
    const words = [`Calories per 100 ${u}`, `Protein per 100 ${u}`, `Usual portion (${u})`];
    document.querySelectorAll('#modal-sheet [data-unit-word]').forEach((span, i) => { span.textContent = words[i]; });
  };
  qUnitSelect.addEventListener('change', applyQuickUnitLabels);

  let duplicateAcknowledged = false;
  document.getElementById('q-save').addEventListener('click', async () => {
    const num = v => (v === '' ? null : Number(v));
    const name = document.getElementById('q-name').value.trim();
    const errEl = document.getElementById('q-error');
    const warnEl = document.getElementById('q-warn');

    const similar = findSimilarFoods(name, cache.foods);
    if (similar.length && !duplicateAcknowledged) {
      warnEl.innerHTML = `You already have <strong>${escapeHtml(similar[0].name)}</strong>. Tap Save again to add this anyway.`;
      warnEl.hidden = false;
      duplicateAcknowledged = true;
      return;
    }

    const obj = {
      id: slugify(name),
      name,
      per100g: {
        kcal: num(document.getElementById('q-kcal').value),
        protein: num(document.getElementById('q-protein').value),
        carbs: null, fat: null, fibre: null,
      },
      defaultPortionG: num(document.getElementById('q-portion').value) ?? 100,
      source: document.getElementById('q-source').value,
      unit: qUnitSelect.value,
      tags: [],
    };
    const errors = validateFood(obj);
    if (errors.length) { errEl.textContent = errors.join(' '); errEl.hidden = false; return; }

    await db.put('foods', obj);
    await refreshCache();
    closeModal();
    if (onSaved) { onSaved(obj); return; }
    // Straight back into the log flow with the new food already selected.
    logState.query = '';
    logState.pickedId = obj.id;
    logState.grams = String(obj.defaultPortionG);
    renderLog();
    toast(`Added ${obj.name}`);
  });
}

function renderLogDraft() {
  const picked = pickedRecord();
  const nameEl = document.getElementById('log-draft-name');
  const macrosEl = document.getElementById('log-draft-macros');
  if (!picked) {
    nameEl.textContent = 'Nothing selected';
    macrosEl.textContent = '—';
    return;
  }
  const grams = parseInt(logState.grams, 10) || 0;
  if (logState.pickedKind === 'recipe') {
    const portion = onePortionGrams(picked);
    // Name the batch's own share so an odd weight is obviously deliberate, not a mistake.
    nameEl.textContent = `${picked.name} (1 portion = ${portion} g)`;
    try {
      const m = recipePortionMacros(picked, foodsById(), grams);
      macrosEl.textContent = `${m.kcal} kcal · ${m.protein} g`;
    } catch {
      macrosEl.textContent = 'missing ingredient';
    }
    return;
  }
  nameEl.textContent = picked.name;
  const m = foodPortionMacros(picked, grams);
  macrosEl.textContent = `${m.kcal} kcal · ${m.protein} g`;
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
  await db.put('logEntries', {
    id: crypto.randomUUID(),
    date: todayISO(),
    foodId: isRecipe ? null : logState.pickedId,
    recipeId: isRecipe ? logState.pickedId : null,
    grams,
    meal: logState.meal ?? inferMeal(),
    loggedAt: new Date().toISOString(),
  });
  logState.query = ''; logState.pickedId = null; logState.pickedKind = null;
  logState.grams = ''; logState.meal = null;
  goTo('today');
});

// ==================== FOODS ====================
let foodsTagFilter = 'All';

function allTagsFromFoods() {
  const set = new Set();
  for (const f of cache.foods) for (const t of f.tags ?? []) set.add(t);
  return ['All', ...Array.from(set).sort()];
}

function renderFoods() {
  const chipContainer = document.getElementById('foods-tag-chips');
  chipContainer.innerHTML = '';
  for (const tag of allTagsFromFoods()) {
    const chip = el(`<button type="button" class="tag-chip">${escapeHtml(tag)}</button>`);
    const active = foodsTagFilter === tag;
    chip.style.background = active ? 'var(--navy)' : 'var(--surface-raised)';
    chip.style.color = active ? 'var(--surface)' : 'var(--navy)';
    chip.style.borderColor = active ? 'var(--navy)' : 'var(--control-border)';
    chip.addEventListener('click', () => { foodsTagFilter = tag; renderFoods(); });
    chipContainer.appendChild(chip);
  }

  const rows = cache.foods.filter(f => foodsTagFilter === 'All' || (f.tags ?? []).includes(foodsTagFilter));
  const list = document.getElementById('foods-list');
  list.innerHTML = '';
  if (rows.length === 0) list.appendChild(el(`<div class="empty-state">No foods yet. Add one, or paste from Claude.</div>`));
  for (const f of rows) {
    const badgeBg = f.source === 'estimate' ? 'var(--red-tint-bg)' : (f.source === 'reference' ? 'var(--teal-badge-bg)' : 'var(--navy-tint-bg)');
    const badgeColor = f.source === 'estimate' ? 'var(--red)' : (f.source === 'reference' ? 'var(--teal)' : 'var(--navy)');
    const badgeBorder = f.source === 'estimate' ? 'var(--red-tint-border)' : (f.source === 'reference' ? 'var(--teal-tint-border)' : 'var(--navy-tint-border)');
    const row = el(`
      <div class="food-row">
        <div class="main">
          <div class="name">${escapeHtml(f.name)}</div>
          <div class="per100">${f.per100g.kcal} kcal · ${f.per100g.protein} g /100${unitOf(f)}</div>
        </div>
        <div class="source-badge" style="border:1px solid ${badgeBorder}; background:${badgeBg};">
          <span class="glyph" style="color:${badgeColor};">${SOURCE_GLYPH[f.source] ?? '?'}</span>
          <span class="word" style="color:${badgeColor};">${escapeHtml(f.source)}</span>
        </div>
        <div class="actions">
          <button type="button" class="icon-btn-small" aria-label="Edit ${escapeHtml(f.name)}">✎</button>
          <button type="button" class="icon-btn-small" aria-label="Delete ${escapeHtml(f.name)}">×</button>
        </div>
      </div>
    `);
    row.querySelector('[aria-label^="Edit"]').addEventListener('click', () => openFoodModal(f));
    row.querySelector('[aria-label^="Delete"]').addEventListener('click', async () => {
      if (!confirm(`Delete "${f.name}"? This can't be undone.`)) return;
      await db.remove('foods', f.id);
      await refreshCache();
      renderFoods();
    });
    list.appendChild(row);
  }
}

document.getElementById('add-food-btn').addEventListener('click', () => openFoodModal(null));

function openFoodModal(food) {
  const isEdit = !!food;
  const body = `
    <h2>${isEdit ? 'Edit food' : 'Add food'}</h2>
    <label class="field-label" for="f-name">Name</label>
    <input class="text-input" id="f-name" style="margin-bottom:12px;" value="${isEdit ? escapeHtml(food.name) : ''}">
    <label class="field-label" for="f-unit">Measured in</label>
    <select class="text-input" id="f-unit" style="margin-bottom:12px;">
      <option value="g" ${!isEdit || unitOf(food) === 'g' ? 'selected' : ''}>grams — solid food</option>
      <option value="ml" ${isEdit && unitOf(food) === 'ml' ? 'selected' : ''}>millilitres — drinks</option>
    </select>
    <label class="field-label" for="f-kcal"><span data-unit-word>Calories per 100 g</span></label>
    <input class="text-input" id="f-kcal" type="number" style="margin-bottom:12px;" value="${isEdit ? food.per100g.kcal : ''}">
    <label class="field-label" for="f-protein"><span data-unit-word>Protein per 100 g</span></label>
    <input class="text-input" id="f-protein" type="number" style="margin-bottom:12px;" value="${isEdit ? food.per100g.protein : ''}">
    <label class="field-label" for="f-carbs"><span data-unit-word>Carbs per 100 g (optional)</span></label>
    <input class="text-input" id="f-carbs" type="number" style="margin-bottom:12px;" value="${isEdit && food.per100g.carbs != null ? food.per100g.carbs : ''}">
    <label class="field-label" for="f-fat"><span data-unit-word>Fat per 100 g (optional)</span></label>
    <input class="text-input" id="f-fat" type="number" style="margin-bottom:12px;" value="${isEdit && food.per100g.fat != null ? food.per100g.fat : ''}">
    <label class="field-label" for="f-fibre"><span data-unit-word>Fibre per 100 g (optional)</span></label>
    <input class="text-input" id="f-fibre" type="number" style="margin-bottom:12px;" value="${isEdit && food.per100g.fibre != null ? food.per100g.fibre : ''}">
    <label class="field-label" for="f-portion"><span data-unit-word>Default portion (g)</span></label>
    <input class="text-input" id="f-portion" type="number" style="margin-bottom:12px;" value="${isEdit ? food.defaultPortionG : 100}">
    <label class="field-label" for="f-source">Source</label>
    <select class="text-input" id="f-source" style="margin-bottom:12px;">
      <option value="label" ${isEdit && food.source === 'label' ? 'selected' : ''}>label — from packaging</option>
      <option value="reference" ${isEdit && food.source === 'reference' ? 'selected' : ''}>reference — published table</option>
      <option value="estimate" ${isEdit && food.source === 'estimate' ? 'selected' : ''}>estimate — entered by hand</option>
    </select>
    <label class="field-label" for="f-tags">Tags (comma separated)</label>
    <input class="text-input" id="f-tags" style="margin-bottom:12px;" value="${isEdit ? escapeHtml((food.tags ?? []).join(', ')) : ''}">
    <div class="form-msg error" id="f-error" hidden></div>
    <div class="form-msg" id="f-warn" hidden style="color:var(--amber);"></div>
    <div class="modal-actions">
      <button type="button" class="secondary-btn" id="f-cancel">Cancel</button>
      <button type="button" class="primary-btn" id="f-save">Save</button>
    </div>
  `;
  openModal(body);
  document.getElementById('f-cancel').addEventListener('click', closeModal);

  const fUnitSelect = document.getElementById('f-unit');
  const applyFoodUnitLabels = () => {
    const u = fUnitSelect.value;
    const words = [
      `Calories per 100 ${u}`, `Protein per 100 ${u}`, `Carbs per 100 ${u} (optional)`,
      `Fat per 100 ${u} (optional)`, `Fibre per 100 ${u} (optional)`, `Default portion (${u})`,
    ];
    document.querySelectorAll('#modal-sheet [data-unit-word]').forEach((span, i) => { span.textContent = words[i]; });
  };
  fUnitSelect.addEventListener('change', applyFoodUnitLabels);
  applyFoodUnitLabels();

  let duplicateAcknowledged = false;
  document.getElementById('f-save').addEventListener('click', async () => {
    const num = v => (v === '' ? null : Number(v));
    const enteredName = document.getElementById('f-name').value.trim();

    const similar = findSimilarFoods(enteredName, cache.foods, { excludeId: isEdit ? food.id : null });
    if (similar.length && !duplicateAcknowledged) {
      const warnEl = document.getElementById('f-warn');
      warnEl.innerHTML = `You already have <strong>${escapeHtml(similar[0].name)}</strong>. Tap Save again to add this anyway.`;
      warnEl.hidden = false;
      duplicateAcknowledged = true;
      return;
    }

    const obj = {
      id: isEdit ? food.id : slugify(enteredName),
      name: enteredName,
      per100g: {
        kcal: num(document.getElementById('f-kcal').value),
        protein: num(document.getElementById('f-protein').value),
        carbs: num(document.getElementById('f-carbs').value),
        fat: num(document.getElementById('f-fat').value),
        fibre: num(document.getElementById('f-fibre').value),
      },
      defaultPortionG: num(document.getElementById('f-portion').value) ?? 100,
      source: document.getElementById('f-source').value,
      unit: fUnitSelect.value,
      tags: document.getElementById('f-tags').value.split(',').map(t => t.trim()).filter(Boolean),
    };
    const errors = validateFood(obj);
    const errEl = document.getElementById('f-error');
    if (errors.length) {
      errEl.textContent = errors.join(' '); errEl.hidden = false;
      return;
    }
    await db.put('foods', obj);
    await refreshCache();
    closeModal();
    renderFoods();
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

document.getElementById('paste-import-btn').addEventListener('click', () => {
  const body = `
    <h2>Paste from Claude</h2>
    <p style="font-size:0.8125rem; color:var(--text-secondary); margin-top:0;">Paste the JSON block Claude gave you.</p>
    <button type="button" class="secondary-btn" id="import-clipboard" style="margin-bottom:10px;">Paste from clipboard</button>
    <textarea id="import-text" placeholder="[ { &quot;id&quot;: ... } ]"></textarea>
    <div class="form-msg error" id="import-msg" hidden></div>
    <div class="modal-actions">
      <button type="button" class="secondary-btn" id="import-cancel">Cancel</button>
      <button type="button" class="primary-btn" id="import-review">Review</button>
    </div>
  `;
  openModal(body);
  document.getElementById('import-cancel').addEventListener('click', closeModal);

  document.getElementById('import-clipboard').addEventListener('click', async () => {
    const msgEl = document.getElementById('import-msg');
    try {
      const text = await navigator.clipboard.readText();
      if (!text || !text.trim()) {
        msgEl.textContent = 'Your clipboard looks empty.';
        msgEl.hidden = false;
        return;
      }
      document.getElementById('import-text').value = text;
      msgEl.hidden = true;
      reviewImport();
    } catch {
      // Safari can refuse without a fresh user gesture, or the permission can be denied.
      msgEl.textContent = 'Couldn’t read the clipboard — paste into the box below instead.';
      msgEl.hidden = false;
    }
  });

  document.getElementById('import-review').addEventListener('click', reviewImport);
});

async function reviewImport() {
  const text = document.getElementById('import-text').value;
  const msgEl = document.getElementById('import-msg');
  try {
    const plan = await prepareImport(text);
    openImportPreview(plan);
  } catch (err) {
    msgEl.textContent = err instanceof ImportError ? err.message : 'Import failed.';
    msgEl.hidden = false;
  }
}

// A collision is no longer fatal to the whole paste — each clashing item becomes a choice.
function openImportPreview(plan) {
  const summary = plan.conflictCount === 0
    ? `${plan.newCount} new item${plan.newCount === 1 ? '' : 's'} to add.`
    : `${plan.newCount} new, ${plan.conflictCount} already in your library.`;

  const rowsHtml = plan.items.map((it, i) => {
    const macros = it.kind === 'food'
      ? `${it.obj.per100g.kcal} kcal · ${it.obj.per100g.protein} g /100${unitOf(it.obj)}`
      : `${it.obj.ingredients.length} ingredient${it.obj.ingredients.length === 1 ? '' : 's'} · ${it.obj.portions} portions`;
    const control = it.conflict
      ? `<select class="text-input" data-import-action="${i}" style="width:auto; height:40px; padding:0 8px; font-size:0.8125rem;">
           <option value="skip">Skip</option>
           <option value="replace">Replace</option>
         </select>`
      : `<span class="source-badge" style="border:1px solid var(--teal-tint-border); background:var(--teal-badge-bg);">
           <span class="word" style="color:var(--teal);">new</span>
         </span>`;
    return `
      <div class="food-row">
        <div class="main">
          <div class="name">${escapeHtml(it.obj.name)}</div>
          <div class="per100">${it.kind} · ${macros}</div>
        </div>
        ${control}
      </div>
    `;
  }).join('');

  openModal(`
    <h2>Review import</h2>
    <p style="font-size:0.8125rem; color:var(--text-secondary); margin-top:0;">${summary}</p>
    <div class="entry-list">${rowsHtml}</div>
    <div class="modal-actions">
      <button type="button" class="secondary-btn" id="ip-cancel">Cancel</button>
      <button type="button" class="primary-btn" id="ip-confirm">Import</button>
    </div>
  `);

  document.querySelectorAll('[data-import-action]').forEach(sel => {
    sel.addEventListener('change', () => {
      plan.items[Number(sel.dataset.importAction)].action = sel.value;
    });
  });

  document.getElementById('ip-cancel').addEventListener('click', closeModal);
  document.getElementById('ip-confirm').addEventListener('click', async () => {
    const result = await commitImport(plan.items);
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
  if (cache.recipes.length === 0) list.appendChild(el(`<div class="empty-state">No recipes yet.</div>`));
  const fMap = foodsById();
  for (const r of cache.recipes) {
    const draft = isDraftRecipe(r);
    let perPortionText = '—';
    if (draft) {
      perPortionText = 'Draft — needs the cooked batch weight';
    } else {
      try {
        const perGram = recipePerGram(r, fMap);
        const grams = r.cookedWeightG / r.portions;
        // Per-100 g matters as much as per-portion now that any weighed amount can be logged.
        perPortionText = `${Math.round(perGram.kcal * grams)} kcal · ${Math.round(perGram.protein * grams)} g / portion`
          + ` · ${Math.round(perGram.kcal * 100)} kcal /100g`;
      } catch {
        perPortionText = 'Missing an ingredient food';
      }
    }
    const row = el(`
      <div>
        <div class="food-row" style="align-items:flex-start;">
          <div class="main">
            <div class="name">${escapeHtml(r.name)}${draft ? ' <span class="draft-tag">draft</span>' : ''}</div>
            <div class="per100">${escapeHtml(perPortionText)}</div>
          </div>
          <div class="actions">
            <button type="button" class="icon-btn-small" data-edit-recipe="${r.id}" aria-label="Edit ${escapeHtml(r.name)}">✎</button>
            <button type="button" class="icon-btn-small" data-delete-recipe="${r.id}" aria-label="Delete ${escapeHtml(r.name)}">×</button>
          </div>
        </div>
        <div style="display:flex; gap:8px; margin:6px 0 6px;">
          <button type="button" class="secondary-btn" data-log-recipe="${r.id}" ${draft ? 'disabled' : ''} style="text-align:center;${draft ? 'opacity:0.5;' : ''}">
            ${draft ? 'Add cooked weight to log' : `Log 1 portion (${onePortionGrams(r)} g)`}
          </button>
          <button type="button" class="secondary-btn" data-weigh-recipe="${r.id}" ${draft ? 'disabled' : ''} style="text-align:center;${draft ? 'opacity:0.5;' : ''}">
            Weigh a portion
          </button>
        </div>
        <div style="margin:0 0 14px;">
          <button type="button" class="secondary-btn" data-cook-again="${r.id}" style="text-align:center;">Cook this again</button>
        </div>
      </div>
    `);
    list.appendChild(row);
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
  // Sends you to the amount screen with the recipe selected and one portion pre-filled, so you
  // can dial in whatever you actually weighed out.
  list.querySelectorAll('[data-weigh-recipe]').forEach(btn => {
    btn.addEventListener('click', () => {
      const recipe = recipesById().get(btn.dataset.weighRecipe);
      if (!recipe || isDraftRecipe(recipe)) return;
      logState.query = '';
      logState.pickedId = recipe.id;
      logState.pickedKind = 'recipe';
      logState.grams = String(onePortionGrams(recipe));
      goTo('log');
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

document.getElementById('add-recipe-btn').addEventListener('click', () => openRecipeModal(null));

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
    const placeholder = chosen && unitOf(chosen) === 'ml' ? 'ml (raw)' : 'grams (raw)';
    return `
      <div style="display:flex; gap:8px; margin-bottom:8px;" data-ing-row="${i}">
        <select class="text-input" data-ing-food style="flex:2;"><option value="">Select food…</option>${options}</select>
        <input class="text-input" data-ing-grams type="number" placeholder="${placeholder}" aria-label="Amount of ingredient ${i + 1}" style="flex:1;" value="${ing.grams || ''}">
        <button type="button" class="icon-btn-small" data-remove-ing aria-label="Remove ingredient">×</button>
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
    ? `<div class="form-msg" style="color:var(--amber); margin:0 0 12px;">
         This recipe has ${loggedCount} portion${loggedCount === 1 ? '' : 's'} already logged. Changing
         the weights here also changes what those past meals say you ate. For a new batch, close this
         and use “Cook this again” instead.
       </div>`
    : '';

  const copyNote = copyFrom
    ? `<div class="form-msg" style="color:var(--text-secondary); margin:0 0 12px;">
         Copied from “${escapeHtml(copyFrom.name)}”. Adjust the weights for this batch — past meals stay untouched.
       </div>`
    : '';

  const body = `
    <h2>${titleText}</h2>
    ${editWarning}${copyNote}
    <label class="field-label" for="r-name">Name</label>
    <input class="text-input" id="r-name" style="margin-bottom:12px;" value="${escapeHtml(defaultName)}">
    <div class="field-label" style="margin-bottom:8px;">Raw ingredients</div>
    <div id="r-ingredients">${ingredients.map(ingredientRowHtml).join('')}</div>
    <div style="display:flex; gap:8px; margin-bottom:14px;">
      <button type="button" class="secondary-btn" id="r-add-ing" style="text-align:center;">Add ingredient</button>
      <button type="button" class="secondary-btn" id="r-new-food" style="text-align:center;">New food</button>
    </div>
    <label class="field-label" for="r-cooked">Cooked / finished batch weight (g)</label>
    <input class="text-input" id="r-cooked" type="number" inputmode="numeric" style="margin-bottom:6px;" value="${restore ? escapeHtml(restore.cooked) : (isEdit && recipe.cookedWeightG != null ? recipe.cookedWeightG : '')}">
    <div style="font-size:0.75rem; color:var(--text-secondary); margin-bottom:12px;">
      Leave empty to save as a draft while the batch is still cooking. You can’t log portions until it’s filled in.
    </div>
    <label class="field-label" for="r-portions">Portions</label>
    <input class="text-input" id="r-portions" type="number" inputmode="numeric" style="margin-bottom:12px;" value="${restore ? escapeHtml(restore.portions) : (template ? template.portions : '')}">
    <div class="form-msg error" id="r-error" hidden></div>
    <div class="modal-actions">
      <button type="button" class="secondary-btn" id="r-cancel">Cancel</button>
      <button type="button" class="primary-btn" id="r-save">Save</button>
    </div>
  `;
  openModal(body);

  let rows = ingredients.slice();

  function rerenderIngredients() {
    document.getElementById('r-ingredients').innerHTML = rows.map(ingredientRowHtml).join('');
    wireIngredientRows();
  }

  function wireIngredientRows() {
    document.querySelectorAll('[data-ing-food]').forEach((sel, i) => sel.addEventListener('change', () => {
      rows[i].foodId = sel.value;
      // Re-render so the amount placeholder switches to ml when a drink is chosen.
      rerenderIngredients();
    }));
    document.querySelectorAll('[data-ing-grams]').forEach((inp, i) => inp.addEventListener('input', () => { rows[i].grams = inp.value; }));
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
      portions: document.getElementById('r-portions').value,
      rows: rows.map(r => ({ ...r })),
    };
    openQuickAddFoodModal('', {
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
      portions: Number(document.getElementById('r-portions').value),
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

// ==================== HISTORY ====================
function renderHistory() {
  renderHistoryList();
}

async function renderHistoryList() {
  const to = isoDaysAgo(1); // yesterday — today lives on the Today screen
  const from = isoDaysAgo(14);
  const entries = await db.entriesInRange(from, to);
  const byDate = new Map();
  for (const e of entries) {
    if (!byDate.has(e.date)) byDate.set(e.date, []);
    byDate.get(e.date).push(e);
  }
  const fMap = foodsById(), rMap = recipesById();
  const dates = Array.from(byDate.keys()).sort((a, b) => b.localeCompare(a));
  const list = document.getElementById('history-list');
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
    const bg = over ? 'var(--red-tint-bg)' : 'var(--navy-tint-bg)';
    const border = over ? 'var(--red-tint-border)' : 'var(--navy-tint-border-2)';
    const color = over ? 'var(--red)' : 'var(--navy)';
    const diffColor = over ? 'var(--red-diff)' : 'var(--text-secondary)';
    const diffParts = [];
    if (target.kcal != null) diffParts.push(`${Math.abs(kcalTotal - target.kcal)} kcal ${kcalTotal > target.kcal ? 'over' : 'under'}`);
    if (target.protein != null) diffParts.push(`${Math.abs(protTotal - target.protein)} g ${protTotal > target.protein ? 'over' : 'under'}`);
    const card = el(`
      <div class="history-card" style="border:1px solid ${border}; background:${bg};">
        <div class="top-row">
          <div class="date">${formatDateHeader(dateStr)}</div>
          <div class="totals-wrap" style="color:${color};">
            <span>${over ? '▲' : '▼'}</span><span>${kcalTotal} kcal · ${protTotal} g</span>
          </div>
        </div>
        <div class="diff" style="color:${diffColor};">${diffParts.length ? diffParts.join(' · ') : 'no target set'}</div>
      </div>
    `);
    list.appendChild(card);
  }
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
  document.getElementById('account-current-user').textContent = accountLabel(sessionUser);
  renderSyncStatus();
  const list = document.getElementById('weekday-targets-list');
  list.innerHTML = '';
  for (const wd of WEEKDAY_ROWS) {
    const row = cache.dayTargets.find(d => d.weekday === wd) ?? { weekday: wd, kcal: null, protein: null };
    const rowEl = el(`
      <div class="weekday-row">
        <span class="day">${WEEKDAY_LABELS[wd]}</span>
        <div class="inputs">
          <input type="number" aria-label="${WEEKDAY_LABELS[wd]} calorie target" placeholder="kcal" value="${row.kcal ?? ''}">
          <input type="number" aria-label="${WEEKDAY_LABELS[wd]} protein target" placeholder="protein g" value="${row.protein ?? ''}">
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
  renderWeightLog();
}

function renderOverrides() {
  const container = document.getElementById('overrides-list');
  container.innerHTML = '';
  const sorted = cache.overrides.slice().sort((a, b) => a.date.localeCompare(b.date));
  for (const o of sorted) {
    const row = el(`
      <div class="override-row">
        <input type="date" value="${o.date}" aria-label="Override date" disabled>
        <input type="number" placeholder="kcal" value="${o.kcal ?? ''}" style="width:80px;" class="text-input" aria-label="Override calorie target">
        <input type="number" placeholder="protein g" value="${o.protein ?? ''}" style="width:90px;" class="text-input" aria-label="Override protein target">
        <button type="button" class="icon-btn-small" aria-label="Remove override for ${o.date}">×</button>
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

function renderWeightLog() {
  const container = document.getElementById('weight-log-list');
  container.innerHTML = '';
  if (cache.weightLog.length === 0) container.appendChild(el(`<div class="empty-state">No weight entries yet.</div>`));
  for (const w of cache.weightLog) {
    container.appendChild(el(`<div class="weight-row"><span>${w.date}</span><span>${w.kg} kg</span></div>`));
  }
}

document.getElementById('add-weight-btn').addEventListener('click', () => {
  const body = `
    <h2>Log a weight</h2>
    <label class="field-label" for="w-date">Date</label>
    <input class="text-input" id="w-date" type="date" style="margin-bottom:12px;" value="${todayISO()}">
    <label class="field-label" for="w-kg">Weight (kg)</label>
    <input class="text-input" id="w-kg" type="number" step="0.1" style="margin-bottom:12px;">
    <div class="modal-actions">
      <button type="button" class="secondary-btn" id="w-cancel">Cancel</button>
      <button type="button" class="primary-btn" id="w-save">Save</button>
    </div>
  `;
  openModal(body);
  document.getElementById('w-cancel').addEventListener('click', closeModal);
  document.getElementById('w-save').addEventListener('click', async () => {
    const date = document.getElementById('w-date').value;
    const kg = Number(document.getElementById('w-kg').value);
    if (!date || !kg) return;
    await db.put('weightLog', { date, kg });
    await refreshCache();
    closeModal();
    renderWeightLog();
  });
});

document.getElementById('logout-btn').addEventListener('click', async () => {
  await logout();
  // onUserChanged puts the login screen back up.
});

document.getElementById('export-all-btn').addEventListener('click', async () => {
  const [foods, recipes, logEntries, dayTargets, overrides, weightLog] = await Promise.all([
    db.getAll('foods'), db.getAll('recipes'), db.getAll('logEntries'), db.getAll('dayTargets'), db.getAll('dayTargetOverrides'), db.getAll('weightLog'),
  ]);
  const text = JSON.stringify({ foods, recipes, logEntries, dayTargets, dayTargetOverrides: overrides, weightLog }, null, 2);
  const ok = await copyText(text);
  toast(ok ? 'Copied full data export' : 'Could not copy — check clipboard permission');
});

// ==================== MODAL ====================
function openModal(bodyHtml) {
  const backdrop = document.getElementById('modal-backdrop');
  const sheet = document.getElementById('modal-sheet');
  sheet.innerHTML = bodyHtml;
  backdrop.hidden = false;
  // The page behind must stay put while a sheet is up. The scrolling element is .screen, not
  // body, so locking body alone would do nothing here.
  document.body.classList.add('modal-open');
  sheet.scrollTop = 0;
}
function closeModal() {
  document.getElementById('modal-backdrop').hidden = true;
  document.getElementById('modal-sheet').innerHTML = '';
  document.body.classList.remove('modal-open');
}
document.getElementById('modal-backdrop').addEventListener('click', e => {
  if (e.target.id === 'modal-backdrop') closeModal();
});

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

async function unlockApp(user) {
  sessionUser = user;
  db.setCurrentUser(user.uid);
  document.getElementById('login-screen').hidden = true;
  document.getElementById('app').hidden = false;
  passwordInput.value = '';

  await seedSharedIfEmpty();
  await seedUserIfEmpty();
  await maybeOfferMigration();
  await refreshCache();
  if (!location.hash) location.hash = 'today';
  renderRoute();
}

function showLoginScreen() {
  sessionUser = null;
  db.setCurrentUser(null);
  document.getElementById('app').hidden = true;
  document.getElementById('login-screen').hidden = false;
  submitBtn.textContent = 'Sign in';
  updateLoginSubmitEnabled();
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
  const badge = document.getElementById('sync-badge');
  if (!badge) return;
  const online = navigator.onLine;
  badge.textContent = online ? 'synced' : 'offline — will sync';
  badge.classList.toggle('offline', !online);
}
window.addEventListener('online', renderSyncStatus);
window.addEventListener('offline', renderSyncStatus);

// ==================== BOOT ====================
function boot() {
  renderSyncStatus();

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
