# Calorie & Protein Tracker

Single-user, offline-first PWA that answers "how much can I still eat today?" No backend,
no build step — plain HTML/CSS/JS with IndexedDB for storage. Built from `calorietrackerbrief.md`
v1.1 and its companion Claude Code / Claude Design briefs.

## Run it locally

Any static file server works, since the app needs `http://` (not `file://`) for ES modules
and the service worker to function:

```bash
npm run serve
```

Then open `http://localhost:8080`. Resize your browser to a phone width (or open dev tools'
device toolbar) — the layout is portrait-only, iPhone-width by design.

## Run the tests

```bash
npm test
```

Covers the two things the brief flags as highest-risk: the cooked-weight derivation
(`js/logic.js`'s `recipePerGram`) and target resolution with date-specific overrides
(`resolveTarget`). Both are pure functions with no DOM/IndexedDB dependency, so they run
under plain `node`.

## Deploying to GitHub Pages

1. Push this repo to `main` on GitHub.
2. In the repo's Settings → Pages, set Source to "Deploy from a branch", branch `main`, folder `/ (root)`.
3. Visit `https://<your-username>.github.io/<repo-name>/`.

No build step, no GitHub Actions workflow needed — the manifest's `start_url`/`scope` and the
service worker's registration are all relative paths, so they work correctly whether the site
is served from a domain root or a project subpath like `/mycounter/`.

### Bumping the cache after a deploy

GitHub Pages doesn't let you set custom `Cache-Control` headers, so the service worker
(`sw.js`) does its own cache-busting: bump `CACHE_VERSION` at the top of the file on any
release where shell files (HTML/CSS/JS/fonts/icons) changed. Old caches are dropped automatically
on activate.

## Installing on iPhone (required, not optional)

Add to Home Screen from Safari — don't just bookmark the page. Regular Safari tabs are
subject to WebKit's Intelligent Tracking Prevention, which can evict IndexedDB after ~7 days
of no interaction; Home Screen web apps are exempt from that cap. Since this app has no cloud
backup by design, Home Screen installation is what makes local-only storage safe.

## What's seeded on first run

Per the brief's "don't invent values" rule (§11), almost nothing is pre-filled:

- One food: Tia's Granola (the only food with fully confirmed label macros). Shared between
  both accounts.
- One body-weight entry: 68.2 kg on 22 Aug 2026 — seeded only for the `yannick` account, since
  it's a fact about him specifically.
- Per-weekday calorie/protein targets exist as empty rows per account — set them in Settings.

Everything else (weekday targets, date overrides for the Sept maintenance block, the rest
of the food list, recipes) is entered by hand or via "Paste from Claude" once you know the
real numbers.

## Accounts

Two accounts, `yannick` and `manshini`, share the same password. Foods and recipes are one
shared library; log entries, daily targets, date overrides, and the body-weight log are kept
separate per account (`js/db.js` routes each to its own IndexedDB database, `calorie-tracker-user-<name>`,
while `foods`/`recipes` live in a shared `calorie-tracker-shared` database). A session persists
in `localStorage` until "Log out" in Settings is used.

**This is not real security.** The app is a static site with no backend (main brief §3), so
there is no server to check a credential against — the check lives in `js/auth.js`, in plain
JavaScript anyone can read via view-source. It exists to keep two people sharing a device from
casually seeing each other's log, not to protect the data from a determined viewer. Don't put
anything genuinely sensitive behind it.

## Architecture notes

- **`js/logic.js`** — pure functions only (target resolution, cooked-weight math, macro
  rounding, import validation, export text formatting). No DOM, no IndexedDB. Unit tested.
- **`js/db.js`** — thin promise wrapper over IndexedDB. Stores: `foods`, `recipes`,
  `logEntries` (indexed on `date` for range queries), `dayTargets`, `dayTargetOverrides`,
  `weightLog`.
- **`js/import-export.js`** — clipboard export (day/range) and paste-import with schema
  validation; rejects on any invalid object or ID collision rather than partially importing.
- **`js/app.js`** — screen rendering and event wiring. Hash-based routing (`#today`, `#log`,
  `#foods`, `#recipes`, `#history`, `#settings`).
- **Recipe portions in `logEntry`**: a logged recipe portion is stored as
  `{ recipeId, foodId: null, grams }` (an extension of the main brief's schema, which only
  showed `foodId`) rather than being expanded into a synthesized food record. Macros are
  resolved live from the recipe + its ingredients at render/export time.
- **Recipes tab**: the visual design handoff's tab bar only showed five tabs (Today, Log,
  Foods, History, Settings); the main brief's Recipes screen (§6D) didn't have a home there.
  Added as a sixth tab rather than nesting it, since it's a primary CRUD screen with its own
  "Log a portion" primary action.

## Fonts & icons

IBM Plex Sans/Mono are self-hosted under `fonts/` (not loaded from Google Fonts at runtime)
so the app doesn't depend on network access for its own typography when offline. App icons
in `icons/` are generated PNGs (navy background, ring motif matching the hero-card rings).
