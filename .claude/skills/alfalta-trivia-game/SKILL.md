---
name: alfalta-trivia-game
description: >
  Project knowledge for "الفلتة" (Al-Falta), Khalifa's Arabic multiplayer trivia
  web game. Load this whenever working on the Trivia-Game project — building or
  editing features, debugging, styling, or deploying. Covers the stack,
  architecture, design language, conventions, gotchas, and the build/deploy
  workflow so changes come out consistent with how the game already works.
---

# الفلتة (Al-Falta) — Project Skill

A real-time, room-based Arabic trivia game. Players join 4-character rooms and
play 3 difficulty phases (easy → medium → hard) of questions, scoring points with
a leveling system. UI is right-to-left (RTL) Arabic.

- **Live site:** alfalta.com (also trivia-game-9m2d.onrender.com)
- **Repo:** github.com/Bin-Jiran/Trivia-Game (main branch)
- **Owner/dev:** Khalifa (commits as Bin-Jiran / aljiran89@gmail.com)

## Stack & architecture

- **Backend:** a single `server.js` — Node + Express, Socket.io (real-time
  gameplay: rooms, players, timers, leaderboards), `pg` (PostgreSQL to Supabase),
  `bcryptjs` + `jsonwebtoken` (auth, 30-day JWTs), `dotenv`, and the Anthropic API
  (`claude-sonnet-4-6`) which generates questions live at game start.
- **Frontend:** a single `public/index.html` — vanilla HTML/CSS/JS, NO framework
  and NO build step. Talks to the backend via `fetch('/api/...')` and a Socket.io
  connection.
- **Database:** Supabase Postgres. Tables auto-created on boot. Includes `users`,
  `game_history`, and `question_flags`.
- **Admin panel:** `public/admin.html` (separate from the game), plus
  `/api/admin/*` endpoints in `server.js`.
- **Hosting:** Render (paid Starter plan). Auto-deploys from GitHub on push.

## CRITICAL gotchas (these waste the most time if forgotten)

1. **Backend changes need a server restart.** Edits to `server.js` do NOT take
   effect until the running process is restarted (`Ctrl+C` → `npm start` locally).
   A stale server is the #1 cause of "the new endpoint returns 404 / feature
   doesn't work." On Render this is automatic (every deploy restarts fresh), so
   this trap is local-only.
2. **Frontend changes just need a hard refresh** (`Ctrl+F5`) — no restart.
3. **Supabase connection:** use the **Session pooler** connection string, NOT the
   direct connection. The direct one fails on Render with IPv6 `ENETUNREACH`.
   The `pg` Pool needs `ssl: { rejectUnauthorized: false }` (Supabase requires SSL).
4. **Tabler icons: only a SUBSET is loaded.** Many `ti-*` glyphs render BLANK
   (zero-width). Do NOT use arbitrary Tabler webfont icons — use **inline SVG**
   (or text) instead. (This caused an invisible report button and would hit the
   admin icons too.)
5. **`index.html` must live inside `public/`** for Render to serve it.
6. **Render sometimes doesn't auto-deploy.** Fallback: Manual Deploy → "Clear
   build cache & deploy" (or "Deploy latest commit").
7. Render's free tier has NO persistent storage — that's why data lives in
   Supabase, not on Render.

## Local dev environment (Windows)

- Tools: Git, Node.js (LTS), Claude Code (native install at `~/.local/bin`).
- If `npm` is blocked by PowerShell: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.
- `.env` holds `DATABASE_URL`, `ANTHROPIC_API_KEY`, `JWT_SECRET`, `PORT`, `ADMIN_EMAIL`.
  `.env` is gitignored; values mirror what's set in Render's Environment tab.
- Run locally: `npm install`, then `npm start`, open `http://localhost:3000`.
  Test multiplayer with a second incognito window.
- **NEVER commit `.env` or secrets.** (`.env` was verified never committed.)

## Design language (keep everything consistent with this)

- **RTL Arabic** throughout. Numbers in RTL need explicit `dir="ltr"` spans to stop
  number/number sequences flipping.
- **Brand palette (CSS vars):** `--red:#E8472A`, `--blue:#3AABDB`,
  `--yellow:#F5C200`, `--green:#5BBD4E` (+ darker variants). The four-color logo
  palette is reserved for the **bottom nav** and the **four answer options** only.
- **Sunburst background:** full-screen `repeating-conic-gradient` of yellow rays
  centered at 50% 50%, fixed. Used on the game home screen and the admin panel.
- **Frosted glass** surfaces everywhere: translucent fills + backdrop blur + subtle
  light border. White text with drop-shadow. Admin panel uses DARK frosted glass on
  the sunburst yellow.
- **Logo:** `logo-full.png` (الفلتة wordmark + light bulb). Assets in
  `/icons/` (logo-bulb, logo-full, trophy) and `/levels/` (shield badges:
  penguin, wolf, bear, lion, dragon, falta).
- Admin panel uses **functional** colors: red = leave/exit/danger, green = go/ok,
  blue = navigate. Colored boxes get a white border.

## Frontend conventions (`index.html`)

- **All screen changes route through one `show(id)` helper.** Don't scatter
  show/hide logic — centralize through `show()`.
- **Screen transitions:** fade-and-scale, 500ms, `cubic-bezier(0.22,0.61,0.36,1)`,
  directionless (every screen enters the same way). Cleanup uses `animationend`
  listeners (not setTimeout). Heavy screens (Profile, Shop) need
  `will-change: transform, opacity` during the transition to avoid stutter (GPU
  layer promotion). Wrap motion in `prefers-reduced-motion`.
- When guarding an image to avoid needless reloads, compare `getAttribute('src')`
  (raw relative value) NOT `.src` (which returns the absolute URL and never matches).
- **Sound:** Web Audio API synthesized effects (click, correct, wrong, question,
  tick countdown, leaderboard fanfare, enter chime) via a `playSound()` helper.
- **Bottom nav:** 5 cells (profile / levels / home / shop / how-to-play) with a
  floating glowing bulb for the active home state (spring-bounce animation). Built
  with a transparent-gap flex layout (restructured, not patched).
- **Answer options:** colored red/blue/yellow/green, no letter prefixes; order is
  randomized so the correct answer isn't always first.
- **Leaderboard:** dark frosted glass, title "الفائز", podium-style FINAL only
  (no mid-game leaderboards); 1st green / 2nd yellow / 3rd blue, trophy for 1st.

## Gameplay rules (don't regress these)

- Questions are AI-generated per game by `claude-sonnet-4-6`. There is **NO
  permanent question bank** yet.
- Don't reveal the correct answer until ALL players have answered.
- Timer stops once everyone has answered.
- A solo host can start immediately when alone, but must wait for all players when
  others are present.
- Round-intro countdown (`3 → 2 → 1 → يلا`) is client-side cosmetic (~3.85s); the
  server-side intro delay still needs syncing to match it (open item).

## Admin system

- `is_admin` BOOLEAN on `users` (added with `ALTER TABLE ... ADD COLUMN IF NOT
  EXISTS`, backward-compatible). `ADMIN_EMAIL` in `.env` auto-promotes that account
  on boot.
- **Security rule:** `requireAdmin` middleware verifies the JWT, then reads
  `is_admin` FRESH FROM THE DB — never trust a token claim. `is_admin` is exposed
  only via `/api/me`, never broadcast to other players via sockets.
- **Super-admin model (planned/ongoing):** only Khalifa's account (a
  super-admin flag) may promote/demote admins; regular admins can review data but
  cannot manage admins. Enforce both in UI (hide controls) AND on the server
  (refuse the action). Never allow removing the last/super admin.
- **Question reporting:** players tap a report button on a question → records to
  `question_flags` with a `UNIQUE(question_key, user_id)` constraint (one report
  per player per question = spam protection). Since questions aren't stored, the
  flag saves a SNAPSHOT of the question text + answers so it's reviewable later.
- **Flagged-review screen:** groups reports of the same question (count + earliest
  date), oldest-first. Actions: تعديل (edit + resolve), حذف (delete/dismiss),
  "لا يوجد خطأ" (keep/dismiss as fine). Resolutions are MARKED (`resolved=true`,
  `resolution` = ok/edited/dismissed) rather than hard-deleted, to keep history.
- **Admin stats:** `/api/admin/stats` (admin-only) returns activeGames,
  playersOnline (from Socket.io memory), totalUsers, gamesToday, flaggedCount.
  `gamesToday` uses `COUNT(DISTINCT room_code)` on a **Kuwait-time (UTC+3)** day
  boundary. Dashboard auto-refreshes every 30s and on tab re-focus.

## Workflow & communication preferences

- **Mockup before code, always.** Khalifa wants to see a visual mockup/preview and
  approve it BEFORE any code is written.
- **Build in stages and test each stage** locally at `localhost:3000` before
  pushing. Never push untested code; nothing reaches live players until approved.
- For gameplay-affecting changes (e.g. room codes), isolate them and test on their
  own — don't bundle with cosmetic tweaks.
- Concise, direct, mixed Arabic/English. Honest trade-off analysis. Numbered change
  lists. Incremental adjustments over large specs.
- Deploy loop now: edit locally with Claude Code → test → commit → push → Render
  auto-deploys. (Older workflow was editing files directly on GitHub mobile.)

## Roadmap / known open items

- **Room codes:** currently reused 4-digit NUMERIC codes (collision risk; slightly
  undercounts distinct games). Planned change to uppercase alphanumeric, avoiding
  confusable chars (O/0, I/1/L). Touches the live create/join flow — test carefully.
- **Player management** and **statistics** admin screens: not built yet (their
  dashboard cards currently 404).
- **Question bank (future):** move from live AI generation to a self-managed
  `questions` table (text, options, correct, category, difficulty, approved flag),
  with admin add/edit/bulk-import screens and a game-logic change to pull from the
  bank (bank-only, AI-only, or hybrid). Resolved/edited flagged questions are the
  natural seed. Sourcing plan: commission Gulf-native writers (platforms Bahr,
  fallback Ureed) in Modern Standard Arabic with Khaleeji relevance — NOT Egyptian
  dialect; QC rubric = factual accuracy, distractor quality, duplicates, language
  clarity, difficulty labeling; delivered as Excel/CSV (question, 4 options, correct,
  category, difficulty).
- **Shop/currency system:** "قريباً" placeholder.
- **Professional email** (contact@alfalta.com): Zoho started then paused (free tier
  uncertain in Kuwait); fallback is Namecheap email forwarding to Gmail.

## Secrets

This skill contains NO secrets. Database passwords and API keys live only in `.env`
(local) and Render's Environment tab. Never put them in this file or commit them.
