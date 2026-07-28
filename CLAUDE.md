# Instructions

I'm a beginner. Explain what you're doing and why, in plain language, before each step. Don't assume I know coding terms.

# Project memory — Al-Falta (الفلتة) trivia game

Durable rules only. No live row counts here — they go stale; get counts from the database when needed.

## Data formats & source of truth
- The Excel master (`C:/Users/aljir/Trivia-Data/Question-Bank/`) is the single source of truth. ANY master edit requires a database sync, or master and live silently diverge.
- Master format: answers as letters A–D, difficulty in Arabic (سهل/متوسط/صعب). Supabase format: answers as full text, difficulty in English (easy/medium/hard). Every load converts both.
- `image_url` column: NULL = text question; a path (e.g. `/flags/kw.svg`) = classic image-in-question rendering. `is_image=true` is the separate (unused) 2×2 tile feature — never set both on one row.
- Never trust terminal display of Arabic strings (RTL reordering lies) — verify by code points or a DB query.

## Load patterns
- Content loads (new categories, bulk inserts, master→DB syncs) always follow the content-loader skill.
- Category delete+reload is PERMANENTLY FORBIDDEN for أنمي once image rows exist — use append-only or targeted-UPDATE loaders after that point.
- Spent INSERT files must never be re-run (it duplicates rows) — the content-loader skill handles this and file cleanup.

## New-tile workflow
- Adding a category tile follows the new-tile skill (byte-exact insertion + DB verification).
- The category grid is currently 28 tiles — keep this number in sync when adding/removing tiles.

## Content conventions
- أنمي: one category (per-title split rejected); every question carries its title, convention «في {Title}، …»; a future split is a prefix-match relabel. Character-image questions will NOT name the anime. Titles/character/technique names in English, question text in Arabic.
- بباي الطيبين (formerly كرتون, renamed 2026-07-28): nostalgia cartoons for the Gulf audience up to the 2000s generation. Arabic DUBBED names throughout (titles and characters) — the English-titles rule of أنمي explicitly does NOT apply here. Category name is بباي الطيبين; question prefix stays «في كرتون {الاسم}،» — كرتون here is the ordinary word for "cartoon," not the old category name, so this wording applies to existing AND future rows alike. Do not "correct" it to بباي الطيبين. Image-backed BY DESIGN — append-only forever, even while text-only. No theme-song lyrics reproduction, ever. Overlap guard: shows covered in أنمي (currently Hunter x Hunter, Dragon Ball, Pokémon, and any future additions) must never appear in بباي الطيبين and vice versa.
- Answer and its three distractors always use the same language/spelling per row.
- أساطير: answers and distractors in English (names); meaning-answers may stay Arabic.
- قصص الأنبياء covers past prophets only; سيرة النبي محمد ﷺ stays in إسلامي. Sourcing: Quranic narrative and mainstream tafsir only.
- «بني إسرائيل» in قصص الأنبياء is the Quranic term (children of يعقوب عليه السلام) — it is unrelated to the state and must NEVER be caught by any إسرائيل content cleanup.
- Flag questions: fixed question «لمن هذا العلم؟», 2-letter lowercase SVG filenames in `public/flags/` (exceptions: `gb-eng`/`gb-sct`/`gb-wls` for England/Scotland/Wales), distractors from visually similar flags, never-pair rule for indistinguishable flags (e.g. Indonesia/Monaco, Romania/Chad, the UK blue-ensign family). Flag `image_url` is now recorded in the master Excel as well (backfilled from the DB, sweep-verified).
- شعارات كروية (football crests): fixed question «لمن هذا الشعار؟», `image_url` = `/crests/{name}.png` in `public/crests/`; the 1:1 crest frame is applied by path-prefix detection (`/crests/`) in index.html, so the path convention is load-bearing. Saudi club files are suffixed `-ksa`, Kuwaiti `-kw`, European clubs unsuffixed. Image-backed category — append-only FOREVER (no delete+reload).
- Bucket floors: 20 rows per difficulty for general categories, 15 for Gulf-niche (أكلات كويتية، عود وعطور، مكياج، أزياء، الكويت).

## Environment & deploys
- Render's Environment tab is the live config; the local `.env` has NO effect on the deployed site.
- `MAINTENANCE_MODE`: only the literal lowercase string `true` enables it. The game has never launched — turning maintenance off IS the launch decision, not routine cleanup. Admins bypass maintenance via `users.is_admin`.
- `AI_FALLBACK_ENABLED` is env-driven (`process.env.AI_FALLBACK_ENABLED !== 'false'`, default ON); the live value is set in Render and is `false`, verified silent in logs (fallback retired — rounds must fill from the bank).
- Pushing to `main` auto-deploys on Render and restarts the server (drops in-memory rooms). Until launch, deploys are free — no players.
- The خمن الشعار tile was removed at commit 96316a2 (0 DB rows, was AI-fallback-served); restore it from git history when the logo category gets real content.
- Git tracks folders only via files — use `.gitkeep` for empty folders. New binary assets go through "Add file → Upload files" on GitHub web, or Claude Code copies them locally.

## Round contract (server.js)
- 3 rounds (easy/medium/hard), 12 questions each; players select 6–12 categories.
- Allocation: base 1 per category, cap 2, no cross-category top-up. With exactly 6 categories every category serves exactly 2 per round.
- Round-building queries retry once (300ms) on failure, then log loudly (room, difficulty, categories). Any AI-fallback contribution is always logged (`ℹ️ AI fallback filled …`) — with the fallback off, that line should never appear.
- `generateQuestions` returns an empty array (does not throw) on API auth failure — a broken API key shows up only as `aiFilled=0`, not as an error. Known future fix.
