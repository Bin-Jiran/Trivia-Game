I'm a beginner. Explain what you're doing and why, in plain language, before each step. Don't assume I know coding terms.

# Project memory

## Data formats
- Excel master (`C:\Users\aljir\Trivia-Data\Question-Bank\alfalta-questions.xlsx`): answers are letters A–D, difficulty in Arabic (سهل/متوسط/صعب).
- Supabase `questions` table: answers are the FULL TEXT of the correct choice, difficulty in English (easy/medium/hard).
- Every load converts both (letter→text, Arabic→English). The master is the single source of truth; ANY master edit requires a matching DB sync or the two diverge.

## Load patterns
- Content loads are single-transaction SQL: BEGIN/COMMIT plus a guard block (`DO $$`) that aborts everything on any count or integrity mismatch.
- أنمي: once image rows exist, category delete+reload is PERMANENTLY FORBIDDEN — append-only loaders from then on.
- Never re-run a spent INSERT file (it duplicates rows). Delete load SQL files from the repo root after a successful run.

## New-tile workflow
1. Add the tile in `public/index.html`.
2. Extract the category string FROM THE FILE ITSELF (never retype it).
3. Query the DB with the extracted string and expect the exact row count.
4. Only then commit.

## Gotchas
- Generated SQL must have REAL newlines — literal `\n` artifacts happened once and abort with a syntax error near `"\"`.
- Arabic tile ↔ DB category strings must match byte-for-byte (spaces included).
- Git tracks folders only via files — an otherwise-empty folder needs a `.gitkeep`.

## Environment
- MAINTENANCE_MODE lives in Render's Environment tab; the local `.env` has no effect on the live site. Only the literal lowercase string `true` enables it.
- AI_FALLBACK_ENABLED is hardcoded `true` at server.js:24 (not an env var).
- The خمن الشعار tile has 0 DB rows — it is served ONLY by the AI fallback.

## Round contract
- 12 questions per round; per-category base 1, cap 2; NO cross-category top-up — gaps go to the AI fallback or the round runs short.
- 6 selected categories → exactly 2 questions each.
- Admins bypass maintenance mode via `users.is_admin`.
